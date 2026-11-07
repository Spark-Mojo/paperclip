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
  const descriptorNamesOwnerAndAction = Boolean(
    descriptor &&
      typeof descriptor === "object" &&
      typeof descriptor.action === "string" &&
      descriptor.action.trim().length > 0 &&
      (descriptor.owner === "board" ||
        (typeof descriptor.owner === "object" &&
          descriptor.owner !== null &&
          (("agentId" in descriptor.owner && typeof descriptor.owner.agentId === "string") ||
            ("userId" in descriptor.owner && typeof descriptor.owner.userId === "string")))),
  );
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

      await settleUnrecoverableExecutions(db);

      // O1(e): the recovery outcome resolves to a terminal, no-replay receipt.
      const [action] = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.id, watchdog.id));
      expect(action!.status).toBe("resolved");
      expect(action!.evidence?.runId).toBe(runId);
      const automaticRecovery = (action!.evidence as Record<string, any>)
        ?.automaticRecovery as Record<string, any> | undefined;
      expect(automaticRecovery).toMatchObject({
        policy: "preserve_without_replay_v1",
        replay: "blocked",
        runId,
      });
      const settledLogs = await readSettledLogs(db, issueId);
      expect(settledLogs).toHaveLength(1);

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
      }

      // O1(c): no fabricated blocker — every blocker relation references a
      // real, unresolved issue row, and the wait derives from THIS failed
      // execution (the resolved action's evidence binds the run).
      const { blockerIds, realIds } = await readRealBlockerRelations(db, companyId, issueId);
      expect(new Set(realIds)).toEqual(new Set(blockerIds));
      expect(blockerIds.every((id) => id !== issueId)).toBe(true);
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
    }, 60_000);

    // O2: service-level idempotency + exactly-once durable effects.
    it("concurrent settlement and replay after resolution yield exactly one resolved action with one owner/action projection", async () => {
      const { agentId, issueId, runId } = await insertFailedExecutionFixture(
        db,
        "Idempotent Settlement",
      );
      const watchdog = await terminalizeAndGuardWatchdog(db, runId, issueId);

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
      // owner fields; a blocker wait matches by surfacing the blocking state
      // (blocking issue id, blocker issue title, or an explicit readiness/
      // blocking reference). Non-vacuity: the unpatched settler's settlement
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
        // Blocker-carried wait: every attention projection must surface the
        // blocking state — the blocking issue id, the blocker issue's own
        // title, or an explicit readiness/blocking reference — instead of
        // arbitrary prose (the readiness structured checks are already pinned
        // above; realness of every blocker row via readRealBlockerRelations).
        const blockingIssueIds = contract.unresolvedBlockerIssueIds;
        const blockerTitles = blockingIssueIds.length
          ? (
              await db
                .select({ title: issues.title })
                .from(issues)
                .where(
                  and(
                    eq(issues.companyId, actions[0]!.companyId),
                    inArray(issues.id, blockingIssueIds),
                  ),
                )
            ).map((row) => normalize(row.title))
          : [];
        for (const { surface, text } of projections) {
          const normalized = normalize(text);
          const surfacesBlockingState =
            blockingIssueIds.some((id) => normalized.includes(id)) ||
            blockerTitles.some((title) => title.length > 0 && normalized.includes(title)) ||
            /readiness|unresolved|blocker|blocking|blocked by/i.test(normalized);
          expect(
            surfacesBlockingState,
            `${surface} projection must surface the blocking wait (blocking issue id, blocker title, or readiness/blocking reference), got: ${JSON.stringify(text)}`,
          ).toBe(true);
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
      expect(issue!.blockedOwnerNotifiedAt).toBeNull();
      const { blockerIds } = await readRealBlockerRelations(db, companyId, issueId);
      expect(blockerIds).toEqual([]);
      const actions = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, issueId));
      expect(actions).toHaveLength(1);
    }, 60_000);
  },
);
