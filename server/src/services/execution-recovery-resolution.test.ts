/**
 * RED regression tests for the failed-execution settlement contract (SPA-17669).
 *
 * Defect under test: settleUnrecoverableExecutions() writes status "blocked"
 * DIRECTLY onto the issue (execution-recovery-resolution.ts, the `current`
 * branch), bypassing the enteringBlocked gate that server/src/routes/issues.ts
 * enforces with a 422 for any blocked transition without an allowed actionable
 * wait (unresolved blocker, pending interaction, pending approval, or an
 * unblockDescriptor naming a concrete owner and action).
 *
 * These tests demand the correct behavior: a failed execution resolution may
 * only land the issue in blocked WITH a real owner/action wait that derives
 * from the failed execution itself, and the settlement must stay idempotent.
 * They intentionally FAIL on the unpatched settlement path, for exactly that
 * reason — never for a fixture/import/setup reason.
 */

import { randomUUID } from "node:crypto";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueApprovals,
  issueRelations,
  issueRecoveryActions,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  legacyExecutionNeedsReconciliation,
  terminalizeLegacyExecution,
} from "./legacy-execution-recovery.js";
import { settleUnrecoverableExecutions } from "./execution-recovery-resolution.js";
import { issueService } from "./issues.js";
import { attentionService } from "./attention.js";

const externalDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = externalDatabaseUrl
  ? { supported: true }
  : await getEmbeddedPostgresTestSupport();

type TestDb = ReturnType<typeof createDb>;

/** Fixture: an in-progress issue owned by an executor whose legacy adapter run
 * failed with `adapter_failed` (the repro-harness shape of the defect). The
 * issue carries the run's execution and checkout locks so settlement must
 * release them while preserving the assignee. */
async function insertFailedExecutionFixture(db: TestDb, label: string) {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const issueId = randomUUID();
  const runId = randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name: label,
    issuePrefix: `FS${companyId.slice(0, 6)}`,
  });
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "Executor",
    role: "engineer",
    adapterType: "paperclip_runner",
  });
  // The run must exist before the issue: execution/checkout locks carry an FK.
  await db.insert(heartbeatRuns).values({
    id: runId,
    companyId,
    agentId,
    nativeIssueId: issueId,
    runtimeMode: "legacy",
    status: "failed",
    errorCode: "adapter_failed",
    contextSnapshot: { issueId },
  });
  await db.insert(issues).values({
    id: issueId,
    companyId,
    title: "Failed settlement fixture",
    status: "in_progress",
    assigneeAgentId: agentId,
    executionRunId: runId,
    checkoutRunId: runId,
    executionLockedAt: new Date(),
    executionAgentNameKey: "executor",
  });
  return { companyId, agentId, issueId, runId };
}

/** Terminalize the failed run (mints the `legacy_execution_requires_reconciliation`
 * watchdog) and assert the preconditions that make the later settlement real. */
async function terminalizeAndGuardWatchdog(db: TestDb, runId: string, issueId: string) {
  const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
  expect(run).toBeDefined();
  // R1 link: adapter_failed on a legacy run genuinely requires reconciliation.
  expect(legacyExecutionNeedsReconciliation(run!)).toBe(true);
  await terminalizeLegacyExecution({ db, run: run!, status: "failed" });
  const [watchdog] = await db
    .select()
    .from(issueRecoveryActions)
    .where(eq(issueRecoveryActions.sourceIssueId, issueId));
  expect(watchdog).toBeDefined();
  expect(watchdog!.cause).toBe("legacy_execution_requires_reconciliation");
  expect(watchdog!.kind).toBe("active_run_watchdog");
  expect(watchdog!.status === "active" || watchdog!.status === "escalated").toBe(true);
  expect(watchdog!.returnOwnerAgentId).not.toBeNull();
  return watchdog!;
}

/** Structural shape of a valid unblockDescriptor: a concrete owner (board, an
 * agent id, or a user id) AND a non-empty action. Deliberately stricter than
 * the route's gate at issues.ts:13361, which accepts ANY truthy descriptor. */
type UnblockDescriptorShape = {
  owner?: { agentId?: unknown; userId?: unknown } | "board" | null;
  action?: unknown;
} | null | undefined;

function namesOwnerAndAction(descriptor: UnblockDescriptorShape) {
  return Boolean(
    descriptor &&
      typeof descriptor.action === "string" &&
      descriptor.action.trim().length > 0 &&
      (descriptor.owner === "board" ||
        (typeof descriptor.owner === "object" &&
          descriptor.owner !== null &&
          (("agentId" in descriptor.owner && typeof descriptor.owner.agentId === "string") ||
            ("userId" in descriptor.owner && typeof descriptor.owner.userId === "string")))),
  );
}

type IssueUnblockOwnerLike = { agentId: string } | { userId: string } | "board";

/** The wait surface of a blocking issue ITSELF — one level of recursion only:
 * either its own `unblockDescriptor` naming a concrete owner + action, or its
 * populated owner fields (`assigneeAgentId`/`assigneeUserId`) with the issue
 * title as the action being worked. Representation-agnostic on purpose. The
 * blocker's own blockers are never read, and nothing below one level. */
type BlockerWaitSurface =
  | { issueId: string; via: "descriptor"; owner: IssueUnblockOwnerLike; actionLabel: string }
  | { issueId: string; via: "ownerFields"; owner: IssueUnblockOwnerLike; actionLabel: string }
  | { issueId: string; via: null; owner: null; actionLabel: null };

async function readBlockerWaitSurfaces(
  db: TestDb,
  companyId: string,
  blockerIssueIds: string[],
): Promise<BlockerWaitSurface[]> {
  if (blockerIssueIds.length === 0) return [];
  const rows = await db
    .select({
      id: issues.id,
      title: issues.title,
      unblockDescriptor: issues.unblockDescriptor,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeUserId: issues.assigneeUserId,
    })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), inArray(issues.id, blockerIssueIds)));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return blockerIssueIds.map((issueId) => {
    const row = byId.get(issueId);
    if (!row) return { issueId, via: null, owner: null, actionLabel: null };
    if (namesOwnerAndAction(row.unblockDescriptor)) {
      const descriptor = row.unblockDescriptor!;
      return {
        issueId,
        via: "descriptor" as const,
        owner: descriptor.owner,
        actionLabel: descriptor.action,
      };
    }
    if (row.assigneeAgentId || row.assigneeUserId) {
      return {
        issueId,
        via: "ownerFields" as const,
        owner: row.assigneeAgentId
          ? ({ agentId: row.assigneeAgentId } as const)
          : ({ userId: row.assigneeUserId! } as const),
        actionLabel: row.title,
      };
    }
    return { issueId, via: null, owner: null, actionLabel: null };
  });
}

/**
 * The SAME predicate the public route enforces when an issue transitions to
 * blocked (server/src/routes/issues.ts, enteringBlocked around 13304-13362):
 * entering blocked is valid ONLY with (a) an unresolved first-class blocker
 * (getDependencyReadiness().unresolvedBlockerCount > 0), (b) a pending thread
 * interaction, (c) a pending approval, or (d) an unblockDescriptor naming a
 * concrete owner and action. Absent all four, the route answers 422 — and a
 * service writing "blocked" directly produces an unroutable state.
 */
async function readBlockedEntryContract(db: TestDb, issueId: string) {
  const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
  expect(issue).toBeDefined();
  const readiness = await issueService(db).getDependencyReadiness(issueId);
  const [pendingInteraction] = await db
    .select({ id: issueThreadInteractions.id })
    .from(issueThreadInteractions)
    .where(
      and(
        eq(issueThreadInteractions.companyId, issue!.companyId),
        eq(issueThreadInteractions.issueId, issueId),
        eq(issueThreadInteractions.status, "pending"),
      ),
    )
    .limit(1);
  const [pendingApproval] = await db
    .select({ id: approvals.id })
    .from(issueApprovals)
    .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
    .where(
      and(
        eq(issueApprovals.companyId, issue!.companyId),
        eq(issueApprovals.issueId, issueId),
        eq(approvals.status, "pending"),
      ),
    )
    .limit(1);
  const descriptor = issue!.unblockDescriptor;
  // Deliberately stricter than the route's gate at issues.ts:13361, which
  // accepts ANY truthy unblockDescriptor — this shape check demands a real
  // owner+action pair so a drift back to the looser gate stays visible here.
  const descriptorNamesOwnerAndAction = namesOwnerAndAction(descriptor);
  const hasUnresolvedBlocker = readiness.unresolvedBlockerCount > 0;
  const hasAllowedActionableWait =
    hasUnresolvedBlocker ||
    pendingInteraction != null ||
    pendingApproval != null ||
    descriptorNamesOwnerAndAction;
  return {
    issue: issue!,
    readiness,
    hasUnresolvedBlocker,
    unresolvedBlockerIssueIds: readiness.unresolvedBlockerIssueIds,
    pendingInteraction: pendingInteraction != null,
    pendingApproval: pendingApproval != null,
    descriptor,
    descriptorNamesOwnerAndAction,
    hasAllowedActionableWait,
  };
}

/** Every "blocks" relation pointing at the issue must reference a real, live
 * issue row of the same company — no fabricated blocker ids. */
async function readRealBlockerRelations(db: TestDb, companyId: string, issueId: string) {
  const relations = await db
    .select({ blockerIssueId: issueRelations.issueId })
    .from(issueRelations)
    .where(
      and(
        eq(issueRelations.companyId, companyId),
        eq(issueRelations.type, "blocks"),
        eq(issueRelations.relatedIssueId, issueId),
      ),
    );
  const blockerIds = relations.map((relation) => relation.blockerIssueId);
  if (blockerIds.length === 0) return { blockerIds, realIds: [] as string[] };
  const real = await db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        inArray(issues.id, blockerIds),
        notInArray(issues.status, ["done", "cancelled"]),
      ),
    );
  return { blockerIds, realIds: real.map((row) => row.id) };
}

async function readSettledLogs(db: TestDb, issueId: string) {
  return db
    .select()
    .from(activityLog)
    .where(
      and(
        eq(activityLog.entityId, issueId),
        eq(activityLog.action, "issue.execution_recovery_settled"),
      ),
    );
}

/** Provenance snapshot: issue ids that pre-date settlement. Any blocker id
 * minted by settlement itself (placeholder) fails the post-settlement check. */
async function snapshotIssueIds(db: TestDb, companyId: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: issues.id })
    .from(issues)
    .where(eq(issues.companyId, companyId));
  return new Set(rows.map((row) => row.id));
}

function normalizeObligationLabel(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase().replace(/\s+/g, " ").trim() : "";
}

function obligationOwnerKey(owner: unknown): string | null {
  if (owner === "board") return "board";
  if (owner && typeof owner === "object") {
    if ("agentId" in owner && typeof (owner as { agentId: unknown }).agentId === "string") {
      return `agent:${(owner as { agentId: string }).agentId}`;
    }
    if ("userId" in owner && typeof (owner as { userId: unknown }).userId === "string") {
      return `user:${(owner as { userId: string }).userId}`;
    }
  }
  return null;
}

function ownerKeyFromRecoveryRow(row: {
  ownerType: string | null;
  ownerAgentId: string | null;
  ownerUserId: string | null;
}): string | null {
  if (row.ownerType === "board") return "board";
  if (row.ownerAgentId) return `agent:${row.ownerAgentId}`;
  if (row.ownerUserId) return `user:${row.ownerUserId}`;
  return null;
}

/** Two obligation representations are the SAME obligation only when they name
 * the SAME owner (structural key) AND the SAME semantic action label. Blank
 * labels and raw-UUID labels never count as a match. */
function sameObligation(
  left: { ownerKey: string | null; actionLabel: string },
  right: { ownerKey: string | null; actionLabel: string },
): boolean {
  if (!left.ownerKey || !right.ownerKey) return false;
  if (left.ownerKey !== right.ownerKey) return false;
  const leftLabel = normalizeObligationLabel(left.actionLabel);
  const rightLabel = normalizeObligationLabel(right.actionLabel);
  if (!leftLabel || !rightLabel) return false;
  const bareUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (bareUuid.test(leftLabel) || bareUuid.test(rightLabel)) return false;
  return leftLabel === rightLabel;
}

type ObligationVehicle = {
  kind: "blocker" | "interaction" | "approval" | "descriptor" | "recoveryAction";
  ownerKey: string | null;
  actionLabel: string;
};

async function readActiveRecoveryObligation(
  db: TestDb,
  companyId: string,
  sourceIssueId: string,
  excludeActionId?: string,
) {
  const rows = await db
    .select({
      id: issueRecoveryActions.id,
      ownerType: issueRecoveryActions.ownerType,
      ownerAgentId: issueRecoveryActions.ownerAgentId,
      ownerUserId: issueRecoveryActions.ownerUserId,
      nextAction: issueRecoveryActions.nextAction,
      status: issueRecoveryActions.status,
    })
    .from(issueRecoveryActions)
    .where(
      and(
        eq(issueRecoveryActions.companyId, companyId),
        eq(issueRecoveryActions.sourceIssueId, sourceIssueId),
        inArray(issueRecoveryActions.status, ["active", "escalated"]),
      ),
    );
  return excludeActionId ? rows.filter((row) => row.id !== excludeActionId) : rows;
}

/** Logical-obligation vehicles across ALL routable-wait surfaces. Count is the
 * number of vehicles present; same-obligation sharing is checked separately. */
async function readObligationVehicles(
  db: TestDb,
  contract: Awaited<ReturnType<typeof readBlockedEntryContract>>,
  opts: { companyId: string; issueId: string; excludeRecoveryActionId?: string },
): Promise<ObligationVehicle[]> {
  const vehicles: ObligationVehicle[] = [];
  if (contract.hasUnresolvedBlocker) {
    // One vehicle PER unresolved blocker id (never collapsed to one): a
    // blocker with no wait surface still counts as its own vehicle with
    // owner null/action "" so it fails same-obligation rather than vanishing.
    const surfaces = await readBlockerWaitSurfaces(
      db,
      opts.companyId,
      contract.unresolvedBlockerIssueIds,
    );
    for (const surface of surfaces) {
      vehicles.push({
        kind: "blocker",
        ownerKey: surface.via !== null ? obligationOwnerKey(surface.owner) : null,
        actionLabel: surface.via !== null ? (surface.actionLabel ?? "") : "",
      });
    }
  }
  // Boolean vehicles: at most one pending interaction / one pending approval
  // can route a single issue, so existence counts as 1 each — limit(1) only
  // fetches the representative row for owner/action naming, not the count.
  if (contract.pendingInteraction) {
    const [interaction] = await db
      .select({
        kind: issueThreadInteractions.kind,
        title: issueThreadInteractions.title,
        addresseeAgentId: issueThreadInteractions.addresseeAgentId,
        addresseeUserId: issueThreadInteractions.addresseeUserId,
      })
      .from(issueThreadInteractions)
      .where(
        and(
          eq(issueThreadInteractions.companyId, opts.companyId),
          eq(issueThreadInteractions.issueId, opts.issueId),
          eq(issueThreadInteractions.status, "pending"),
        ),
      )
      .limit(1);
    vehicles.push({
      kind: "interaction",
      ownerKey: interaction?.addresseeAgentId
        ? `agent:${interaction.addresseeAgentId}`
        : interaction?.addresseeUserId
          ? `user:${interaction.addresseeUserId}`
          : null,
      actionLabel: interaction?.title ?? interaction?.kind ?? "",
    });
  }
  if (contract.pendingApproval) {
    const [approval] = await db
      .select({
          type: approvals.type,
          payload: approvals.payload,
          requestedByAgentId: approvals.requestedByAgentId,
          requestedByUserId: approvals.requestedByUserId,
        })
      .from(issueApprovals)
      .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
      .where(
        and(
          eq(issueApprovals.companyId, opts.companyId),
          eq(issueApprovals.issueId, opts.issueId),
          eq(approvals.status, "pending"),
        ),
      )
      .limit(1);
    const payload = (approval?.payload ?? {}) as Record<string, unknown>;
    const title =
      typeof payload.title === "string" && payload.title.trim()
        ? payload.title
        : typeof payload.summary === "string" && payload.summary.trim()
          ? payload.summary
          : (approval?.type ?? "");
    vehicles.push({
      kind: "approval",
      // Obligation owner: the requester who must act (requestedByAgentId /
      // requestedByUserId, approvals.ts:11-12). linkedBy fields on
      // issue_approvals (issue_approvals.ts:13-14) are linkage provenance
      // (who attached the approval to the issue), not the obligation owner.
      ownerKey: approval?.requestedByAgentId
        ? `agent:${approval.requestedByAgentId}`
        : approval?.requestedByUserId
          ? `user:${approval.requestedByUserId}`
          : null,
      actionLabel: title,
    });
  }
  if (contract.descriptorNamesOwnerAndAction) {
    const descriptor = contract.descriptor as {
      owner: unknown;
      action: unknown;
    };
    vehicles.push({
      kind: "descriptor",
      ownerKey: obligationOwnerKey(descriptor.owner),
      actionLabel: typeof descriptor.action === "string" ? descriptor.action : "",
    });
  }
  const activeRecovery = await readActiveRecoveryObligation(
    db,
    opts.companyId,
    opts.issueId,
    opts.excludeRecoveryActionId,
  );
  // One vehicle PER active/escalated recovery row (never collapsed to the
  // first): 2+ active actions count as 2+ vehicles so the same-obligation
  // check sees every obligation.
  if (activeRecovery.length > 0) {
    for (const row of activeRecovery) {
      vehicles.push({
        kind: "recoveryAction",
        ownerKey: ownerKeyFromRecoveryRow(row),
        actionLabel: row.nextAction ?? "",
      });
    }
  }
  return vehicles;
}

/** Service-level engine projection: the blocked row as the engine serves it
 * (issueService list with includeBlockedBy), plus the full attention feed
 * fetched through the attention service. The feed is asserted by linkage +
 * owner/action naming when it projects this issue, never by an exactly-once
 * count and never by raw-UUID prose. By engine design only human-routed waits
 * (user/board descriptor, stalled terminal blockers) page the feed — an
 * agent-owned GREEN wait surfaces via the engine row, not the feed — so the
 * feed assertion falls back to the engine-row structural check when the feed
 * carries no row for this issue. */
async function readBlockedEngineProjection(
  db: TestDb,
  companyId: string,
  issueId: string,
) {
  const engineRows = await issueService(db).list(companyId, {
    status: "blocked",
    includeBlockedBy: true,
  });
  const engineRow = engineRows.find((row) => row.id === issueId) ?? null;
  const feed = await attentionService(db).list(companyId, {
    all: true,
    allowUnscopedAll: true,
  });
  return { engineRow, feed };
}

(support.supported ? describe : describe.skip)(
  "failed-execution settlement blocked-entry contract",
  () => {
    let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
    let db: TestDb;
    beforeAll(async () => {
      if (externalDatabaseUrl) {
        db = createDb(externalDatabaseUrl);
        return;
      }
      database = await startEmbeddedPostgresTestDatabase(
        "paperclip-execution-recovery-resolution-",
      );
      db = createDb(database.connectionString);
    }, 30_000);
    afterEach(async () => {
      await db.execute("TRUNCATE companies CASCADE");
    });
    afterAll(async () => {
      if (externalDatabaseUrl) await db?.$client.end();
      else await database?.cleanup();
    });

    // R1 + O1(a)-(e): the settlement-contract regression.
    it("adapter_failed settlement must not strand the issue blocked without an allowed actionable wait", async () => {
      const { companyId, agentId, issueId, runId } = await insertFailedExecutionFixture(
        db,
        "Failed Settlement",
      );
      const watchdog = await terminalizeAndGuardWatchdog(db, runId, issueId);
      // Provenance/legitimacy: snapshot every issue id that pre-dates
      // settlement. A GREEN repair may only reference these ids — settlement
      // must never mint a placeholder blocker to fake a wait.
      const preExistingIssueIds = await snapshotIssueIds(db, companyId);

      await settleUnrecoverableExecutions(db);

      // O1(e): the recovery outcome resolves to a terminal, no-replay receipt.
      const [action] = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.id, watchdog.id));
      expect(action!.status).toBe("resolved");
      expect(action!.evidence?.runId).toBe(runId);
      const automaticRecovery = (action!.evidence as Record<string, any>)
        ?.automaticRecovery as Record<string, unknown> | undefined;
      expect(automaticRecovery).toMatchObject({
        policy: "preserve_without_replay_v1",
        replay: "blocked",
        runId,
      });
      const settledLogs = await readSettledLogs(db, issueId);
      expect(settledLogs).toHaveLength(1);

      // Current settlement resolves the watchdog, so a wait must NOT be read
      // off this resolved recovery action — the engine projection below
      // asserts the blocked-issue attention path instead.

      // The settlement must stop the issue (precondition of the contract below).
      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(issue!.status).toBe("blocked");

      // R1 + O1(a): the SAME predicate the public route enforces with a 422 —
      // a blocked issue without an allowed actionable wait is the defect.
      const contract = await readBlockedEntryContract(db, issueId);
      expect(
        contract.hasAllowedActionableWait,
        `failed-execution settlement stranded issue ${issueId} in status "blocked" with NO allowed actionable wait (no unresolved blocker, no pending interaction, no pending approval, no unblockDescriptor naming owner+action) — violates the enteringBlocked 422 contract of server/src/routes/issues.ts`,
      ).toBe(true);

      // O1(b): the wait must be a real owner/action wait, not a bare state.
      const ownerAgentId = action!.returnOwnerAgentId ?? agentId;
      const waitNamesConcreteOwnerAndAction =
        contract.descriptorNamesOwnerAndAction ||
        (contract.hasUnresolvedBlocker &&
          contract.unresolvedBlockerIssueIds.every((id) => id !== issueId));
      expect(
        waitNamesConcreteOwnerAndAction,
        "the blocked wait must name a concrete owner and action (valid unblockDescriptor or a distinct unresolved blocker issue)",
      ).toBe(true);
      if (contract.descriptorNamesOwnerAndAction) {
        const owner = contract.descriptor!.owner;
        if (typeof owner === "object" && "agentId" in owner) {
          expect(owner.agentId).toBe(ownerAgentId);
        }
      } else {
        // Blocker-carried wait: ANY blocked result needs a real owner/action
        // wait — so the blocking issue itself must name a CONCRETE owner and
        // action via its own unblockDescriptor or its populated owner fields
        // (representation-agnostic). ONE level of recursion: this surface is
        // asserted; the blocker's own blockers never are.
        const surfaces = await readBlockerWaitSurfaces(
          db,
          companyId,
          contract.unresolvedBlockerIssueIds,
        );
        for (const surface of surfaces) {
          expect(
            surface.via,
            `blocker-carried wait: blocking issue ${surface.issueId} carries no concrete owner/action wait of its own (no unblockDescriptor with owner+action, no populated assignee owner fields) — the blocked result would name no owner and no action anywhere`,
          ).not.toBeNull();
        }
      }

      // O1(c): no fabricated blocker — every blocker relation references a
      // real, unresolved issue row, and the wait derives from THIS failed
      // execution (the resolved action's evidence binds the run).
      const { blockerIds, realIds } = await readRealBlockerRelations(db, companyId, issueId);
      expect(new Set(realIds)).toEqual(new Set(blockerIds));
      expect(blockerIds.every((id) => id !== issueId)).toBe(true);
      // Authorized shapes only: descriptor, or a pre-existing blocker with a
      // wait surface. Settlement-minted placeholders fail here.
      expect(blockerIds.every((id) => preExistingIssueIds.has(id))).toBe(true);
      expect(action!.evidence?.runId).toBe(runId);

      // O1(d): preserved assignee; execution/checkout locks fully released.
      // terminalizeLegacyExecution (legacy-execution-recovery.ts:97-110)
      // already nulls these lock fields before settlement, so these asserts
      // are a regression net only — not a probe of settler behavior.
      expect(issue!.assigneeAgentId).toBe(agentId);
      expect(issue!.executionRunId).toBeNull();
      expect(issue!.checkoutRunId).toBeNull();
      expect(issue!.executionLockedAt).toBeNull();
      expect(issue!.executionAgentNameKey).toBeNull();

      // Engine projection (O2): when a wait remains, the blocked row must
      // surface in the engine list AND the attention feed must name the SAME
      // owner/action as the wait vehicle (structural owner match + semantic
      // action-label containment, never raw-UUID prose, never exactly-once).
      // On the RED path this stays unreachable — the wait-must-remain failure
      // above fires first, so RED still reports missing wait behavior.
      expect(contract.hasAllowedActionableWait).toBe(true);
      const { engineRow, feed } = await readBlockedEngineProjection(db, companyId, issueId);
      expect(engineRow).not.toBeNull();
      // Engine-row structural check (always applicable): the engine must
      // serve the blocked row with the SAME wait vehicle — descriptor fields
      // or at least one live blocker in blockedBy.
      if (contract.descriptorNamesOwnerAndAction) {
        expect(engineRow!.unblockDescriptor).not.toBeNull();
      } else {
        const blockedBy = (engineRow as { blockedBy?: Array<{ id: string }> }).blockedBy ?? [];
        expect(blockedBy.length).toBeGreaterThan(0);
        expect(
          blockedBy.every((row) => preExistingIssueIds.has(row.id) && row.id !== issueId),
        ).toBe(true);
      }
      // Feed linkage (conditional, never exactly-once): only human-routed
      // waits page the attention feed by engine design (user/board descriptor
      // at attention.ts:1488-1517, stalled terminal blockers at :1519-1571).
      // An agent-owned GREEN wait surfaces via the engine row above, not the
      // feed — so when the feed carries no row for this issue, the engine-row
      // structural check above carries the assertion and this branch must not
      // fail GREEN vacuously nor pass RED vacuously (RED never reaches here).
      const blockedAttentionItems =
        feed.items?.filter(
          (item) =>
            item.sourceKind === "blocker_attention" &&
            (item.subject.id === issueId || item.relatedIssue?.id === issueId),
        ) ?? [];
      if (contract.descriptorNamesOwnerAndAction) {
        // Human-owned descriptor waits page the feed by engine design — assert
        // feed linkage ONLY here (T2 pattern): SAME owner/action as the wait
        // vehicle (structural owner match + semantic action-label containment,
        // never raw-UUID prose, never exactly-once).
        const waitOwnerKey = obligationOwnerKey(
          (contract.descriptor as { owner: unknown }).owner,
        );
        const waitActionLabel = String((contract.descriptor as { action: unknown }).action ?? "");
        if (blockedAttentionItems.length > 0) {
          const attentionLinked = blockedAttentionItems.some((item) => {
            // Structural owner equality only: the wait owner's key must equal
            // an owner key carried by the feed item's own owner fields
            // (subject or relatedIssue assignee ids). Subject-id linkage alone
            // never counts — every item in this filtered list already
            // references the issue, so it proves nothing about the owner.
            const feedOwnerKeys = new Set<string>();
            for (const scope of [item.subject, item.relatedIssue]) {
              const agentId = scope?.metadata?.assigneeAgentId;
              const userId = scope?.metadata?.assigneeUserId;
              if (typeof agentId === "string" && agentId) feedOwnerKeys.add(`agent:${agentId}`);
              if (typeof userId === "string" && userId) feedOwnerKeys.add(`user:${userId}`);
            }
            const ownerMatches =
              waitOwnerKey != null &&
              (waitOwnerKey === "board"
                ? item.entryRule.includes("human-owned unblockDescriptor")
                : feedOwnerKeys.has(waitOwnerKey));
            const normalizedWait = normalizeObligationLabel(waitActionLabel);
            const actionMatches =
              normalizedWait.length > 0
                ? `${item.whyNow} ${item.detail && "blockingIssue" in item.detail ? (item.detail.blockingIssue?.title ?? "") : ""}`
                    .toLowerCase()
                    .includes(normalizedWait) ||
                  item.decisionVerbs.some((verb) =>
                    (verb.description ?? "").toLowerCase().includes(normalizedWait),
                  )
                : true;
            return ownerMatches && actionMatches;
          });
          expect(
            attentionLinked,
            `attention feed must project the SAME owner/action as the wait vehicle for blocked issue ${issueId}`,
          ).toBe(true);
          // Non-vacuity: the projection must name a semantic label, never a
          // raw UUID and never a blank whyNow.
          for (const item of blockedAttentionItems) {
            expect(item.whyNow.trim().length).toBeGreaterThan(0);
          }
        } else {
          // No feed row for this issue: document that agent-owned waits are
          // engine-row-only by design (GREEN expectation), and pin it — the
          // wait vehicle must be agent-owned or blocker-carried, never a
          // human-owned descriptor that SHOULD have paged the feed.
          const descriptorOwner = obligationOwnerKey(
            (contract.descriptor as { owner: unknown }).owner,
          );
          expect(
            descriptorOwner === null || descriptorOwner.startsWith("agent:"),
            `human-owned descriptor wait for blocked issue ${issueId} must page the attention feed (engine design attention.ts:1488-1517) — feed absence with a board/user descriptor is a missing projection`,
          ).toBe(true);
        }
      } else {
        // Blocker-carried wait: NEVER fail solely because the feed exists, and
        // never require attentionLinked via the descriptor waitOwnerKey (null
        // for blocker-only waits, which made feed-present+blocker fail
        // spuriously while feed-absent+blocker passed vacuously). The
        // engine-row structural check above (blockedBy pre-existing issues)
        // already carries the assertion; here, when feed items ARE present, at
        // least one item's owner must structurally match SOME blocking
        // issue's wait-surface owner (readBlockerWaitSurfaces, one level) AND
        // its action label containment.
        if (blockedAttentionItems.length > 0) {
          const surfaces = await readBlockerWaitSurfaces(
            db,
            companyId,
            contract.unresolvedBlockerIssueIds,
          );
          const withWait = surfaces.filter((surface) => surface.via !== null);
          const blockerLinked = blockedAttentionItems.some((item) => {
            const feedOwnerKeys = new Set<string>();
            for (const scope of [item.subject, item.relatedIssue]) {
              const agentId = scope?.metadata?.assigneeAgentId;
              const userId = scope?.metadata?.assigneeUserId;
              if (typeof agentId === "string" && agentId) feedOwnerKeys.add(`agent:${agentId}`);
              if (typeof userId === "string" && userId) feedOwnerKeys.add(`user:${userId}`);
            }
            return withWait.some((surface) => {
              const surfaceOwnerKey = obligationOwnerKey(surface.owner);
              const ownerMatches =
                surfaceOwnerKey != null &&
                (surfaceOwnerKey === "board"
                  ? item.entryRule.includes("human-owned unblockDescriptor")
                  : feedOwnerKeys.has(surfaceOwnerKey));
              if (!ownerMatches) return false;
              const normalizedSurface = normalizeObligationLabel(surface.actionLabel ?? "");
              if (normalizedSurface.length === 0) return false;
              return (
                `${item.whyNow} ${item.detail && "blockingIssue" in item.detail ? (item.detail.blockingIssue?.title ?? "") : ""}`
                  .toLowerCase()
                  .includes(normalizedSurface) ||
                item.decisionVerbs.some((verb) =>
                  (verb.description ?? "").toLowerCase().includes(normalizedSurface),
                )
              );
            });
          });
          expect(
            blockerLinked,
            `attention feed items for blocked issue ${issueId} must project SOME blocking issue's owner/action (structural owner match + action-label containment) — never fail a blocker-wait solely because the feed exists`,
          ).toBe(true);
          for (const item of blockedAttentionItems) {
            expect(item.whyNow.trim().length).toBeGreaterThan(0);
          }
        }
        // Feed absent on a blocker-carried wait passes vacuously BY DESIGN:
        // the stalled-terminal path (attention.ts:1519-1571, entryRule
        // `terminal blocker has a non-live blockerAttention.state`) carries no
        // owner condition, so the feed may legitimately be absent on the RED
        // path — RED still fails first at hasAllowedActionableWait above.
      }
      // One-obligation bound: at most one logical obligation across ALL
      // vehicles; multiple representations pass ONLY when demonstrably the
      // same obligation (same owner AND same action label).
      const vehicles = await readObligationVehicles(db, contract, {
        companyId,
        issueId,
        excludeRecoveryActionId: watchdog.id,
      });
      // Single-null-vehicle non-vacuity: when a wait is claimed, even one
      // vehicle must name an obligation — a lone vehicle with null owner or
      // a blank label names nothing. Skipped when no wait is claimed (RED
      // has zero vehicles, and RED fails earlier at hasAllowedActionableWait).
      if (contract.hasAllowedActionableWait) {
        expect(
          vehicles.length,
          `blocked issue ${issueId} claims an allowed actionable wait but no obligation vehicle remains — a claimed wait with zero vehicles must fail instead of passing via length<=1`,
        ).toBeGreaterThan(0);
        for (const vehicle of vehicles) {
          expect(
            vehicle.ownerKey != null && normalizeObligationLabel(vehicle.actionLabel).length > 0,
            `obligation vehicle names no obligation for blocked issue ${issueId}: ${JSON.stringify(vehicle)} — a wait vehicle must name a concrete owner and a non-blank action label`,
          ).toBe(true);
        }
      }
      const allSameObligation =
        vehicles.length > 0 &&
        vehicles.every((vehicle) => sameObligation(vehicles[0]!, vehicle));
      expect(
        vehicles.length <= 1 || allSameObligation,
        `more than one logical obligation remains for blocked issue ${issueId}: ${JSON.stringify(vehicles)} — multiple representations must name the SAME owner AND action`,
      ).toBe(true);
      // No second owner-routing effect beyond the single obligation:
      // blockedOwnerNotifiedAt null-or-timestamp consistent with the vehicle
      // (agent-owned descriptor wait may set it post-GREEN via
      // routable-blocked.ts:23-54 + routes/issues.ts:13822-13839; a
      // blocker-only wait carries no descriptor so nothing may notify).
      // RED path never reaches here (no wait exists there); GREEN with a
      // descriptor permits either state until the notify path lands.
      if (contract.descriptorNamesOwnerAndAction) {
        expect(
          issue!.blockedOwnerNotifiedAt == null || issue!.blockedOwnerNotifiedAt instanceof Date,
        ).toBe(true);
      } else {
        expect(issue!.blockedOwnerNotifiedAt).toBeNull();
      }
      // No second active recovery action beyond the resolved watchdog —
      // settlement must not mint one to fake a wait.
      const extraRecovery = await readActiveRecoveryObligation(db, companyId, issueId, watchdog.id);
      expect(extraRecovery).toEqual([]);
    }, 60_000);

    // O2: service-level idempotency + exactly-once durable effects.
    it("concurrent settlement and replay after resolution yield exactly one resolved action with one owner/action projection", async () => {
      const { agentId, issueId, runId } = await insertFailedExecutionFixture(
        db,
        "Idempotent Settlement",
      );
      const watchdog = await terminalizeAndGuardWatchdog(db, runId, issueId);
      // Provenance snapshot: GREEN may only reference pre-existing issues.
      const idempotentCompanyId = watchdog.companyId;
      const preExistingIssueIds = await snapshotIssueIds(db, idempotentCompanyId);

      // Concurrent settlement: the attempt row's active-fingerprint uniqueness
      // plus the transactional re-check must let exactly one logical resolve win.
      const results = await Promise.allSettled([
        settleUnrecoverableExecutions(db),
        settleUnrecoverableExecutions(db),
      ]);
      const rejected = results.filter((result) => result.status === "rejected");
      expect(
        rejected.map((result) => String((result as PromiseRejectedResult).reason)),
        "concurrent settlement sweeps must not crash",
      ).toEqual([]);

      // Replay after resolution: terminalize + settle must not mint a second action.
      const [runAfter] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      await terminalizeLegacyExecution({ db, run: runAfter!, status: "failed" });
      await settleUnrecoverableExecutions(db);

      const actions = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, issueId));
      expect(actions).toHaveLength(1);
      expect(actions[0]!.id).toBe(watchdog.id);
      expect(actions[0]!.status).toBe("resolved");

      // At most one durable routing obligation when a wait remains, and none
      // of them invented: every blocker relation references a real issue.
      const { blockerIds, realIds } = await readRealBlockerRelations(db, actions[0]!.companyId, issueId);
      expect(blockerIds.length).toBeLessThanOrEqual(1);
      expect(new Set(realIds)).toEqual(new Set(blockerIds));
      expect(blockerIds.every((id) => preExistingIssueIds.has(id))).toBe(true);

      // One-obligation bound across ALL vehicles (replaces the blocker-only
      // bound): count the blocker vehicle + pending interaction + pending
      // approval + descriptor + any active/escalated recovery action beyond
      // the resolved watchdog; assert <= 1 when a wait remains. Multiple
      // representations pass ONLY when demonstrably the same obligation
      // (same owner AND same action label via sameObligation). Lifecycle
      // receipt stays exactly one (settled log + lifecycle run event below),
      // AND no second owner-routing effect may exist (blockedOwnerNotifiedAt
      // single timestamp at most, no second active recovery action). The
      // current settlement resolves the watchdog, so a wait must NOT be read
      // off it — the new active-recovery vehicle below excludes it.
      const postContract = await readBlockedEntryContract(db, issueId);
      const obligationVehicles = await readObligationVehicles(db, postContract, {
        companyId: actions[0]!.companyId,
        issueId,
        excludeRecoveryActionId: watchdog.id,
      });
      const allSameObligation =
        obligationVehicles.length > 0 &&
        obligationVehicles.every((vehicle) => sameObligation(obligationVehicles[0]!, vehicle));
      // Single-null-vehicle non-vacuity (copied from the first test): when a
      // wait is claimed, even one vehicle must name an obligation. Skipped on
      // RED (postContract.hasAllowedActionableWait=false there, so RED still
      // fails at the wait-must-remain asserts below).
      if (postContract.hasAllowedActionableWait) {
        expect(
          obligationVehicles.length,
          `blocked issue ${issueId} claims an allowed actionable wait but no obligation vehicle remains — a claimed wait with zero vehicles must fail instead of passing via length<=1`,
        ).toBeGreaterThan(0);
        for (const vehicle of obligationVehicles) {
          expect(
            vehicle.ownerKey != null && normalizeObligationLabel(vehicle.actionLabel).length > 0,
            `obligation vehicle names no obligation for blocked issue ${issueId}: ${JSON.stringify(vehicle)} — a wait vehicle must name a concrete owner and a non-blank action label`,
          ).toBe(true);
        }
      }
      expect(
        obligationVehicles.length <= 1 || allSameObligation,
        `more than one logical obligation remains for blocked issue ${issueId}: ${JSON.stringify(obligationVehicles)} — multiple representations must name the SAME owner AND action`,
      ).toBe(true);
      const [issueAfterIdempotent] = await db.select().from(issues).where(eq(issues.id, issueId));
      if (postContract.descriptorNamesOwnerAndAction) {
        // GREEN expectation (documented, not yet reachable): descriptor wait
        // may carry a notifiedAt timestamp after the blocked-owner notify
        // path (routable-blocked.ts:23-54) delivers the agent wakeup.
        expect(
          issueAfterIdempotent!.blockedOwnerNotifiedAt == null ||
            issueAfterIdempotent!.blockedOwnerNotifiedAt instanceof Date,
        ).toBe(true);
      } else {
        // No invented notification may mask a missing wait: blocker-only or
        // interaction/approval waits carry no descriptor, so notifiedAt stays null.
        expect(issueAfterIdempotent!.blockedOwnerNotifiedAt).toBeNull();
      }
      const extraRecovery = await readActiveRecoveryObligation(
        db,
        actions[0]!.companyId,
        issueId,
        watchdog.id,
      );
      expect(extraRecovery).toEqual([]);
      // Engine projection (O2 service-level): when a wait remains the blocked
      // row must surface via the engine (issueService list with
      // includeBlockedBy) with the SAME wait vehicle, and the attention feed
      // must project the SAME owner/action when it carries the row (never
      // exactly-once, never raw-UUID prose). Guarded on the wait so the RED
      // path (no wait) skips this and fails at the wait-must-remain assert
      // below with its original message — this block can never turn RED green.
      if (postContract.hasAllowedActionableWait) {
      const { engineRow, feed } = await readBlockedEngineProjection(
        db,
        actions[0]!.companyId,
        issueId,
      );
      expect(engineRow).not.toBeNull();
      const blockedFeedItems =
        feed.items?.filter(
          (item) =>
            item.sourceKind === "blocker_attention" &&
            (item.subject.id === issueId || item.relatedIssue?.id === issueId),
        ) ?? [];
      if (postContract.descriptorNamesOwnerAndAction) {
        expect(engineRow!.unblockDescriptor).not.toBeNull();
        const humanOwner = obligationOwnerKey(
          (postContract.descriptor as { owner: unknown }).owner,
        );
        if (humanOwner === "board" || humanOwner?.startsWith("user:")) {
          expect(
            blockedFeedItems.length,
            `human-owned descriptor wait for blocked issue ${issueId} must page the attention feed (attention.ts:1488-1517)`,
          ).toBeGreaterThan(0);
        }
      } else if (postContract.hasUnresolvedBlocker) {
        const blockedBy = (engineRow as { blockedBy?: Array<{ id: string }> }).blockedBy ?? [];
        expect(blockedBy.length).toBeGreaterThan(0);
      }
      } // end guarded engine projection — RED (no wait) skips to the wait-must-remain failure below

      // No duplicate replay notification: one settled log row, one lifecycle
      // run event, across both sweeps and the replay cycle.
      const settledLogs = await readSettledLogs(db, issueId);
      expect(settledLogs).toHaveLength(1);
      const lifecycleEvents = await db
        .select()
        .from(heartbeatRunEvents)
        .where(
          and(
            eq(heartbeatRunEvents.runId, runId),
            eq(heartbeatRunEvents.eventType, "lifecycle"),
          ),
        );
      expect(lifecycleEvents).toHaveLength(1);

      // A wait must remain, and the attention projection surfaces (recovery
      // action nextAction/resolutionNote + run event message) must name the
      // SAME concrete owner (and action) as the wait itself.
      const contract = await readBlockedEntryContract(db, issueId);
      expect(
        contract.hasAllowedActionableWait,
        `settlement left issue ${issueId} blocked without an allowed actionable wait, so no owner/action projection can exist`,
      ).toBe(true);
      // The owner/action linkage is pinned on the WAIT VEHICLE, not on raw
      // owner/assignee id substrings of the prose projections — a valid GREEN
      // repair may carry either vehicle, so derive the marker from whichever
      // one the settled result actually has.
      if (contract.descriptorNamesOwnerAndAction) {
        // Descriptor-carried wait: the stricter shape check above already
        // names owner AND action; when the owner is an agent it must be the
        // owner the resolution returned, not an invented one.
        const owner = contract.descriptor!.owner;
        if (typeof owner === "object" && "agentId" in owner) {
          expect(owner.agentId).toBe(actions[0]!.returnOwnerAgentId ?? agentId);
        }
      } else {
        // Blocker-carried wait: existence + readiness linkage — at least one
        // unresolved blocker, distinct from the blocked issue itself (realness
        // of every blocker row is asserted via readRealBlockerRelations above).
        expect(
          contract.hasUnresolvedBlocker,
          "blocker-carried wait must report unresolvedBlockerCount > 0",
        ).toBe(true);
        expect(contract.unresolvedBlockerIssueIds.length).toBeGreaterThan(0);
        expect(contract.unresolvedBlockerIssueIds.every((id) => id !== issueId)).toBe(true);
      }
      // DoD4: the attention projections must MATCH the wait's owner/action —
      // non-empty alone is not enough (verify round 1 gap). The matching form
      // follows the wait vehicle and never demands a raw owner UUID as prose
      // (critic round 1): a descriptor wait matches by its semantic action
      // label in every projection plus the projection surface's structured
      // owner fields; a blocker wait matches the SAME way, but the expected
      // owner/action is sourced from the blocking issue's own wait surface
      // read from the DB row (never invented constants): structural owner
      // match on the projection surface's owner fields plus the blocker's
      // semantic action label (its descriptor action, or its title when it
      // carries owner fields instead) contained in every projection.
      // Non-vacuity: the unpatched settler's settlement
      // notes ("Automatic recovery stopped. Recorded work is preserved; …")
      // contain no action label and none of these blocking references, and
      // bare "blocked" is deliberately excluded as a keyword — the status
      // word alone would make this oracle accept arbitrary prose.
      const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();
      const bareUuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const projections = [
        { surface: "nextAction", text: actions[0]!.nextAction ?? "" },
        { surface: "resolutionNote", text: actions[0]!.resolutionNote ?? "" },
        { surface: "lifecycle run event", text: lifecycleEvents[0]!.message ?? "" },
      ];
      for (const { surface, text } of projections) {
        expect(
          text.trim().length,
          `${surface} attention projection must be non-empty`,
        ).toBeGreaterThan(0);
      }
      if (contract.descriptorNamesOwnerAndAction) {
        // Descriptor-carried wait: the action is a semantic label, never an
        // id — so prose containment is a semantic match, not an id substring.
        const descriptor = contract.descriptor!;
        const actionLabel = normalize(descriptor.action);
        expect(
          bareUuid.test(descriptor.action.trim()),
          `the descriptor action must be a semantic label, not a raw UUID: ${JSON.stringify(descriptor.action)}`,
        ).toBe(false);
        // Owner match through the projection surface's structured owner
        // fields (ownerType/ownerAgentId/ownerUserId on the recovery action
        // row): the routed attention must name the SAME owner the descriptor
        // names, never an invented one.
        if (descriptor.owner === "board") {
          expect(
            actions[0]!.ownerType === "board" ||
              (actions[0]!.ownerAgentId == null && actions[0]!.ownerUserId == null),
            `board-owned wait projected a non-board owner (ownerType=${actions[0]!.ownerType}, ownerAgentId=${actions[0]!.ownerAgentId}, ownerUserId=${actions[0]!.ownerUserId})`,
          ).toBe(true);
        } else if ("agentId" in descriptor.owner) {
          expect(
            actions[0]!.ownerAgentId,
            `agent-owned wait projected ownerAgentId=${actions[0]!.ownerAgentId}, but the descriptor names ${descriptor.owner.agentId}`,
          ).toBe(descriptor.owner.agentId);
        } else {
          expect(
            actions[0]!.ownerUserId,
            `user-owned wait projected ownerUserId=${actions[0]!.ownerUserId}, but the descriptor names ${descriptor.owner.userId}`,
          ).toBe(descriptor.owner.userId);
        }
        // Action match: every attention projection must name THAT action — a
        // projection that says nothing about it fails.
        for (const { surface, text } of projections) {
          expect(
            normalize(text).includes(actionLabel),
            `${surface} projection must name the descriptor's action ${JSON.stringify(descriptor.action)}, got: ${JSON.stringify(text)}`,
          ).toBe(true);
        }
      } else {
        // Blocker-carried wait: the projection must MATCH the blocking
        // issue's owner/action under the SAME rules as the descriptor
        // branch — structural owner match on the projection surface's
        // owner fields (ownerType/ownerAgentId/ownerUserId on the recovery
        // action row) plus normalized action-label containment in every
        // attention projection. Expected owner/action sourced from the
        // blocking issue's own wait surface (read from the DB row), never
        // from invented constants. ONE level of recursion: the blocker's
        // own wait surface is read; nothing below it is asserted.
        const surfaces = await readBlockerWaitSurfaces(
          db,
          actions[0]!.companyId,
          contract.unresolvedBlockerIssueIds,
        );
        const withWait = surfaces.filter((surface) => surface.via !== null);
        expect(
          withWait.length,
          `blocker-carried wait: no blocking issue (${contract.unresolvedBlockerIssueIds.join(", ")}) carries a concrete owner/action wait of its own (unblockDescriptor with owner+action or populated assignee owner fields), so the attention projection has no owner/action to match — verify round 2: a GREEN repair with no concrete owner/action anywhere must not pass vacuously`,
        ).toBeGreaterThan(0);
        const matched = withWait.find((surface) => {
          const owner = surface.owner;
          const ownerMatches =
            owner === "board"
              ? actions[0]!.ownerType === "board" ||
                (actions[0]!.ownerAgentId == null && actions[0]!.ownerUserId == null)
              : "agentId" in owner
                ? actions[0]!.ownerAgentId === owner.agentId
                : actions[0]!.ownerUserId === owner.userId;
          if (!ownerMatches) return false;
          // Critic round 2, advisory 1: a blank title must NOT reduce the
          // projection check to owner-only via a vacuous includes("") — a
          // blank action label is never a matchable wait.
          if (surface.actionLabel.trim().length === 0) return false;
          // Critic round 2, advisory 2 (anti-raw-UUID guard extended to the
          // ownerFields branch): a UUID-shaped title is an id, not a
          // semantic action label — do NOT demand that UUID as a prose
          // substring; its projection check is carried by the structural
          // owner match above plus the non-empty-projection asserts already
          // run above. Only non-UUID-shaped labels demand prose
          // containment. Descriptor branch unchanged: it always demands
          // prose containment of a semantic action label.
          if (surface.via === "ownerFields" && bareUuid.test(surface.actionLabel.trim())) {
            return true;
          }
          return projections.every(({ text }) =>
            normalize(text).includes(normalize(surface.actionLabel)),
          );
        });
        expect(
          matched,
          `no blocking issue's owner/action matches the attention projection: expected a blocking issue whose owner structurally matches (ownerType=${actions[0]!.ownerType}, ownerAgentId=${actions[0]!.ownerAgentId}, ownerUserId=${actions[0]!.ownerUserId}) and whose semantic action label is contained in every projection ${JSON.stringify(projections)}`,
        ).toBeDefined();
        // The matched action label must be a semantic label, never a raw
        // UUID — containment in prose is a semantic match, not an id
        // substring (critic round 1). Extended (critic round 2): the
        // ownerFields branch never demands a UUID-shaped title as prose at
        // all (waived in the matched predicate) — its check rides on the
        // structural owner match plus the non-empty-projection asserts
        // above; only non-UUID-shaped labels demand containment. The
        // descriptor branch is unchanged: its action must always be
        // semantic, so a raw-UUID action there is forbidden outright.
        if (matched!.via === "descriptor") {
          expect(
            bareUuid.test(matched!.actionLabel.trim()),
            `the blocking issue's descriptor action must be a semantic label, not a raw UUID: ${JSON.stringify(matched!.actionLabel)}`,
          ).toBe(false);
        }
      }
    }, 60_000);

    // O2 negative control: a task whose owner moved on resolves to a valid
    // terminal result — the settler must write NO routing obligation at all.
    it("a valid terminal result (owner changed) resolves without blocking or any routing obligation", async () => {
      const { companyId, issueId, runId } = await insertFailedExecutionFixture(
        db,
        "Owner Moved On",
      );
      const watchdog = await terminalizeAndGuardWatchdog(db, runId, issueId);
      const successorAgentId = randomUUID();
      await db.insert(agents).values({
        id: successorAgentId,
        companyId,
        name: "Successor",
        role: "engineer",
        adapterType: "paperclip_runner",
      });
      await db
        .update(issues)
        .set({ assigneeAgentId: successorAgentId })
        .where(eq(issues.id, issueId));

      await settleUnrecoverableExecutions(db);

      // Non-vacuity guard: the settler DID process this incident.
      const [action] = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.id, watchdog.id));
      expect(action!.status).toBe("resolved");
      expect(action!.outcome).toBe("cancelled");

      // The valid terminal result touches nothing: no blocked state, no wait
      // fabrication, no routing obligation for the new owner.
      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(issue!.status).toBe("in_progress");
      expect(issue!.unblockDescriptor).toBeNull();
      // Terminal control extended to ALL vehicles: null descriptor is not
      // enough — notifiedAt, relations, interaction, approval, and recovery
      // actions must all show zero obligation.
      expect(issue!.blockedOwnerNotifiedAt).toBeNull();
      const { blockerIds } = await readRealBlockerRelations(db, companyId, issueId);
      expect(blockerIds).toEqual([]);
      const terminalContract = await readBlockedEntryContract(db, issueId);
      expect(terminalContract.pendingInteraction).toBe(false);
      expect(terminalContract.pendingApproval).toBe(false);
      expect(terminalContract.hasUnresolvedBlocker).toBe(false);
      expect(terminalContract.descriptorNamesOwnerAndAction).toBe(false);
      const terminalRecovery = await readActiveRecoveryObligation(db, companyId, issueId);
      expect(terminalRecovery).toEqual([]);
      const actions = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, issueId));
      expect(actions).toHaveLength(1);
    }, 60_000);
  },
);
