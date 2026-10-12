import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

// SPA-11863 — James DECIDED 2026-09-14 (SPA-7212, never implemented in the
// old SPA-7212 PR): when a blocker reaches `cancelled`, the engine
// auto-drops the edges this issue had as a `blocks` blocker, logs an
// activity row naming blocker + dependent + actor, and queues exactly one
// `issue_blockers_resolved` wake per dependent whose readiness becomes clean
// after the drop. Hard constraints in the card:
//   - never auto-drop a `blocks` edge in any non-terminal status
//   - never drop a `done` blocker edge
//   - never cross `company_id`
//   - if we cannot prove `cancelled` at drop time, retain the edge
//   - dropped edge must not fire a wake storm: only the dependents it
//     actually gated, exactly once

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping SPA-11863 cancelled-blocker auto-drop tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres(
  "SPA-11863 cancelled-blocker auto-drop (auto-drops first-class blocks edges)",
  () => {
    let db!: ReturnType<typeof createDb>;
    let svc!: ReturnType<typeof issueService>;
    let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

    beforeAll(async () => {
      tempDb = await startEmbeddedPostgresTestDatabase(
        "paperclip-spa-11863-cancelled-blocker-auto-drop-",
      );
      db = createDb(tempDb.connectionString);
      svc = issueService(db);
    }, 20_000);

    afterEach(async () => {
      await db.delete(agentWakeupRequests);
      await db.delete(activityLog);
      await db.delete(issueRelations);
      await db.delete(issues);
      await db.delete(agents);
      await db.delete(companies);
    });

    afterAll(async () => {
      await tempDb?.cleanup();
    });

    async function createCompany(prefix: string) {
      const companyId = randomUUID();
      const agentId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: `Company ${prefix}`,
        issuePrefix: prefix,
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: `${prefix} Agent`,
        role: "engineer",
        status: "idle",
      });
      return { companyId, agentId };
    }

    async function insertIssue(input: {
      companyId: string;
      id?: string;
      identifier: string;
      title: string;
      status: string;
      assigneeAgentId?: string | null;
      assigneeUserId?: string | null;
      blockedTransitionAt?: Date | null;
    }) {
      const id = input.id ?? randomUUID();
      await db.insert(issues).values({
        id,
        companyId: input.companyId,
        identifier: input.identifier,
        title: input.title,
        status: input.status,
        priority: "medium",
        parentId: null,
        assigneeAgentId: input.assigneeAgentId ?? null,
        assigneeUserId: input.assigneeUserId ?? null,
        originKind: "manual",
        originId: null,
        originFingerprint: "default",
        executionState: null,
        description: null,
        blockedTransitionAt: input.blockedTransitionAt ?? null,
      });
      return id;
    }

    async function block(input: {
      companyId: string;
      blockerIssueId: string;
      blockedIssueId: string;
    }) {
      await db.insert(issueRelations).values({
        companyId: input.companyId,
        issueId: input.blockerIssueId,
        relatedIssueId: input.blockedIssueId,
        type: "blocks",
      });
    }

    async function getActivityRowsFor(
      companyId: string,
      action: string,
    ): Promise<
      Array<{
        action: string;
        entityId: string;
        details: Record<string, unknown> | null;
      }>
    > {
      const rows = await db
        .select({
          action: activityLog.action,
          entityId: activityLog.entityId,
          details: activityLog.details,
        })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(activityLog.action, action),
          ),
        );
      return rows.map((row) => ({
        action: row.action,
        entityId: row.entityId,
        details:
          row.details && typeof row.details === "object"
            ? (row.details as Record<string, unknown>)
            : null,
      }));
    }

    async function getWakeRowsFor(
      companyId: string,
      reason: string,
    ) {
      return db
        .select({
          agentId: agentWakeupRequests.agentId,
          reason: agentWakeupRequests.reason,
          status: agentWakeupRequests.status,
          payload: agentWakeupRequests.payload,
          idempotencyKey: agentWakeupRequests.idempotencyKey,
        })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, companyId),
            eq(agentWakeupRequests.reason, reason),
          ),
        );
    }

    // REGRESSION ORACLE #1 — A card `blocked` on a `cancelled` blocker reaches
    // a runnable state with no human PATCH. Re-derivable from
    // `listIssueDependencyReadinessMap`: the cancelled-half auto-drop is
    // visible as the dependent's readiness returning `isDependencyReady=true`
    // immediately after the cancellation commits, with no human follow-up.
    it("auto-drops the blocker edge on a cancelled blocker so a blocked dependent reaches a runnable state with no human PATCH", async () => {
      const { companyId, agentId } = await createCompany("PCA");
      const blockerId = await insertIssue({
        companyId,
        identifier: "PCA-1",
        title: "Blocker",
        status: "in_progress",
        assigneeAgentId: agentId,
      });
      const dependentId = await insertIssue({
        companyId,
        identifier: "PCA-2",
        title: "Dependent",
        status: "blocked",
        assigneeAgentId: agentId,
        blockedTransitionAt: new Date(),
      });
      await block({
        companyId,
        blockerIssueId: blockerId,
        blockedIssueId: dependentId,
      });

      const before = await svc.getRelationSummaries(dependentId);
      expect(before.blockedBy.map((entry: { id: string }) => entry.id)).toEqual([
        blockerId,
      ]);
      const beforeReadiness = await svc.listDependencyReadiness(
        companyId,
        [dependentId],
      );
      expect(beforeReadiness.get(dependentId)?.isDependencyReady).toBe(false);
      expect(
        beforeReadiness.get(dependentId)?.unresolvedBlockerIssueIds,
      ).toEqual([blockerId]);

      // The cancellation lands via the same `update` path the PATCH route uses
      // (issueService.update is the central choke point every status
      // transition goes through — internal callers included).
      await svc.update(blockerId, {
        status: "cancelled",
        actorAgentId: agentId,
      });

      const after = await svc.getRelationSummaries(dependentId);
      expect(after.blockedBy).toEqual([]);
      const afterReadiness = await svc.listDependencyReadiness(
        companyId,
        [dependentId],
      );
      expect(afterReadiness.get(dependentId)?.isDependencyReady).toBe(true);
      expect(afterReadiness.get(dependentId)?.unresolvedBlockerIssueIds).toEqual(
        [],
      );
    });

    // REGRESSION ORACLE #2 — The log row is written, and it names both cards.
    it("writes an activity log row naming both cards on each auto-dropped edge", async () => {
      const { companyId, agentId } = await createCompany("PCB");
      const blockerId = await insertIssue({
        companyId,
        identifier: "PCB-1",
        title: "Blocker to be cancelled",
        status: "in_progress",
        assigneeAgentId: agentId,
      });
      const dependentId = await insertIssue({
        companyId,
        identifier: "PCB-2",
        title: "Dependent waiting on cancelled blocker",
        status: "blocked",
        assigneeAgentId: agentId,
        blockedTransitionAt: new Date(),
      });
      await block({
        companyId,
        blockerIssueId: blockerId,
        blockedIssueId: dependentId,
      });

      await svc.update(blockerId, {
        status: "cancelled",
        actorAgentId: agentId,
      });

      const rows = await getActivityRowsFor(
        companyId,
        "issue.blocker_edge_auto_dropped",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.entityId).toBe(blockerId);
      const details = rows[0]!.details as Record<string, unknown>;
      expect(details["blockerIssueId"]).toBe(blockerId);
      expect(details["dependentIssueId"]).toBe(dependentId);
      expect(details["blockerStatusAtDrop"]).toBe("cancelled");
      expect(details["source"]).toBe("issue-cancelled-blocker-auto-drop");
      expect(typeof details["droppedAt"]).toBe("string");
      expect(details["requestedByActorType"]).toBe("agent");
    });

    it("does not auto-drop edges when the cancelled issue was done moments earlier", async () => {
      const { companyId, agentId } = await createCompany("PCD");
      const blockerId = await insertIssue({
        companyId,
        identifier: "PCD-1",
        title: "Done blocker",
        status: "in_progress",
        assigneeAgentId: agentId,
      });
      const dependentId = await insertIssue({
        companyId,
        identifier: "PCD-2",
        title: "Blocked on done blocker",
        status: "blocked",
        assigneeAgentId: agentId,
      });
      await block({
        companyId,
        blockerIssueId: blockerId,
        blockedIssueId: dependentId,
      });

      await svc.update(blockerId, {
        status: "done",
        actorAgentId: agentId,
      });
      // No further activity row should appear — the `done` transition is
      // not a `cancelled` transition; SPA-11863 only fires on the latter.
      const rows = await getActivityRowsFor(
        companyId,
        "issue.blocker_edge_auto_dropped",
      );
      expect(rows).toEqual([]);
      // The `done` blocker survives too: the existing engine only drops
      // the relation for the recovery-originKind branch or via the
      // route's heartbeat.autoUnblockReadyDependents backstop (not
      // triggered by svc.update directly). SPA-11863 must NOT contribute a
      // log row, and this assertion holds it to that.
      const remaining = await svc.getRelationSummaries(dependentId);
      expect(
        remaining.blockedBy.map((entry: { id: string }) => entry.id),
      ).toEqual([blockerId]);
    });

    it("does not drop an edge that points at a dependent in a different company", async () => {
      const aSide = await createCompany("PCE");
      const bSide = await createCompany("PCF");
      const blockerId = await insertIssue({
        companyId: aSide.companyId,
        identifier: "PCE-1",
        title: "Blocker in company A",
        status: "in_progress",
        assigneeAgentId: aSide.agentId,
      });
      const dependentId = await insertIssue({
        companyId: bSide.companyId,
        identifier: "PCF-2",
        title: "Dependent in company B",
        status: "blocked",
        assigneeAgentId: bSide.agentId,
      });
      // Same-companyId insert directly into the relation table would violate
      // the engine's invariants at write time; build the cross-company edge
      // via a direct relation insert for the test shape. The engine enforces
      // a same-company join guard inside the cancellation flow, so the
      // cancellation must NOT take this edge out.
      await db.insert(issueRelations).values({
        companyId: aSide.companyId,
        issueId: blockerId,
        relatedIssueId: dependentId,
        type: "blocks",
      });

      await svc.update(blockerId, {
        status: "cancelled",
        actorAgentId: aSide.agentId,
      });

      // No log row under the cancelling company (the dependent was a
      // cross-company candidate, not a same-company one).
      const logRows = await getActivityRowsFor(
        aSide.companyId,
        "issue.blocker_edge_auto_dropped",
      );
      expect(logRows).toEqual([]);
      // Edge is retained.
      const survivors = await db
        .select({ id: issueRelations.id })
        .from(issueRelations)
        .where(
          and(
            eq(issueRelations.issueId, blockerId),
            eq(issueRelations.relatedIssueId, dependentId),
          ),
        );
      expect(survivors).toHaveLength(1);
    });

    it.each(["done", "in_review", "todo", "in_progress", "blocked", "backlog"] as const)(
      "does not auto-drop edges on any non-terminal transition (case: %s)",
      async (transition) => {
        const prefix = `PCM${transition.length}_${transition.slice(0, 2)}`;
        const { companyId, agentId } = await createCompany(prefix);
        const blockerId = await insertIssue({
          companyId,
          identifier: "PCX-1",
          title: "Blocker under transition",
          status: "in_progress",
          assigneeAgentId: agentId,
        });
        const dependentId = await insertIssue({
          companyId,
          identifier: "PCX-2",
          title: "Dependent",
          status: "blocked",
          assigneeAgentId: agentId,
        });
        await block({
          companyId,
          blockerIssueId: blockerId,
          blockedIssueId: dependentId,
        });

        await svc.update(blockerId, {
          status: transition,
          actorAgentId: agentId,
        });
        const logs = await getActivityRowsFor(
          companyId,
          "issue.blocker_edge_auto_dropped",
        );
        expect(logs).toEqual([]);
        const survivor = await db
          .select({ id: issueRelations.id })
          .from(issueRelations)
          .where(eq(issueRelations.issueId, blockerId));
        if (transition === "done") {
          // The `done` blocker transition runs through the existing auto-unblock
          // lane, not through ours; for this test we only assert OUR code did
          // not contribute a log row, not that the edge survives.
          return;
        }
        expect(survivor).toHaveLength(1);
      },
    );

    it("auto-drops only this cancelled blocker and keeps other open blockers", async () => {
      const { companyId, agentId } = await createCompany("PCG");
      const cancelledBlockerId = await insertIssue({
        companyId,
        identifier: "PCG-1",
        title: "Will be cancelled",
        status: "in_progress",
        assigneeAgentId: agentId,
      });
      const stillOpenBlockerId = await insertIssue({
        companyId,
        identifier: "PCG-2",
        title: "Will stay open",
        status: "in_progress",
        assigneeAgentId: agentId,
      });
      const dependentId = await insertIssue({
        companyId,
        identifier: "PCG-3",
        title: "Dependent on both",
        status: "blocked",
        assigneeAgentId: agentId,
        blockedTransitionAt: new Date(),
      });
      await block({
        companyId,
        blockerIssueId: cancelledBlockerId,
        blockedIssueId: dependentId,
      });
      await block({
        companyId,
        blockerIssueId: stillOpenBlockerId,
        blockedIssueId: dependentId,
      });

      await svc.update(cancelledBlockerId, {
        status: "cancelled",
        actorAgentId: agentId,
      });

      const summaries = await svc.getRelationSummaries(dependentId);
      expect(
        summaries.blockedBy.map((entry: { id: string }) => entry.id).sort(),
      ).toEqual([stillOpenBlockerId].sort());

      // The dependent's readiness stays `not ready` because one blocker is
      // still open — no wake should be queued.
      const wakers = await getWakeRowsFor(
        companyId,
        "issue_blockers_resolved",
      );
      expect(wakers).toEqual([]);
    });

    it("queues exactly one issue_blockers_resolved wake per ready dependent", async () => {
      const { companyId, agentId } = await createCompany("PCH");
      const blockerId = await insertIssue({
        companyId,
        identifier: "PCH-1",
        title: "Blocker",
        status: "in_progress",
        assigneeAgentId: agentId,
      });
      const dependentId = await insertIssue({
        companyId,
        identifier: "PCH-2",
        title: "Dependent",
        status: "blocked",
        assigneeAgentId: agentId,
        blockedTransitionAt: new Date(),
      });
      await block({
        companyId,
        blockerIssueId: blockerId,
        blockedIssueId: dependentId,
      });

      await svc.update(blockerId, {
        status: "cancelled",
        actorAgentId: agentId,
      });

      const wakes = await getWakeRowsFor(
        companyId,
        "issue_blockers_resolved",
      );
      expect(wakes).toHaveLength(1);
      expect(wakes[0]?.agentId).toBe(agentId);
      expect(wakes[0]?.reason).toBe("issue_blockers_resolved");
      expect(wakes[0]?.status).toBe("queued");
      const payload = wakes[0]!.payload as Record<string, unknown> | null;
      expect(payload?.["issueId"]).toBe(dependentId);
      expect(payload?.["resolvedBlockerIssueId"]).toBe(blockerId);
      expect(payload?.["source"]).toBe("issue-cancelled-blocker-auto-drop");
      expect(typeof wakes[0]?.idempotencyKey).toBe("string");
    });

    it("skips wake but still drops the edge when the dependent has no agent assignee", async () => {
      const { companyId } = await createCompany("PCI");
      const blockerId = await insertIssue({
        companyId,
        identifier: "PCI-1",
        title: "Blocker",
        status: "in_progress",
        assigneeAgentId: null,
      });
      const dependentId = await insertIssue({
        companyId,
        identifier: "PCI-2",
        title: "Human-owned dependent",
        status: "blocked",
        assigneeAgentId: null,
        assigneeUserId: "board-user-1",
        blockedTransitionAt: new Date(),
      });
      await block({
        companyId,
        blockerIssueId: blockerId,
        blockedIssueId: dependentId,
      });

      await svc.update(blockerId, {
        status: "cancelled",
        actorUserId: "board-user-1",
      });

      const summaries = await svc.getRelationSummaries(dependentId);
      expect(summaries.blockedBy).toEqual([]);
      const wakers = await getWakeRowsFor(
        companyId,
        "issue_blockers_resolved",
      );
      expect(wakers).toEqual([]);
      const logs = await getActivityRowsFor(
        companyId,
        "issue.blocker_edge_auto_dropped",
      );
      expect(logs).toHaveLength(1);
    });

    it("does nothing when the dependent is not currently blocked", async () => {
      const { companyId, agentId } = await createCompany("PCJ");
      const blockerId = await insertIssue({
        companyId,
        identifier: "PCJ-1",
        title: "Blocker",
        status: "in_progress",
        assigneeAgentId: agentId,
      });
      const dependentId = await insertIssue({
        companyId,
        identifier: "PCJ-2",
        title: "Dependent already in progress",
        status: "in_progress",
        assigneeAgentId: agentId,
      });
      await block({
        companyId,
        blockerIssueId: blockerId,
        blockedIssueId: dependentId,
      });

      await svc.update(blockerId, {
        status: "cancelled",
        actorAgentId: agentId,
      });

      const wakers = await getWakeRowsFor(
        companyId,
        "issue_blockers_resolved",
      );
      expect(wakers).toEqual([]);
      const survivors = await db
        .select({ id: issueRelations.id })
        .from(issueRelations)
        .where(eq(issueRelations.issueId, blockerId));
      expect(survivors).toHaveLength(1);
      const logs = await getActivityRowsFor(
        companyId,
        "issue.blocker_edge_auto_dropped",
      );
      expect(logs).toEqual([]);
    });

    it("uses the level-triggered state key so a second cancelled transition does not double-fire", async () => {
      const { companyId, agentId } = await createCompany("PCK");
      const blockerAId = await insertIssue({
        companyId,
        identifier: "PCK-1",
        title: "First blocker",
        status: "in_progress",
        assigneeAgentId: agentId,
      });
      const blockerBId = await insertIssue({
        companyId,
        identifier: "PCK-2",
        title: "Second blocker to drive the second transition",
        status: "in_progress",
        assigneeAgentId: agentId,
      });
      const dependentId = await insertIssue({
        companyId,
        identifier: "PCK-3",
        title: "Dependent",
        status: "blocked",
        assigneeAgentId: agentId,
        blockedTransitionAt: new Date(),
      });
      await block({
        companyId,
        blockerIssueId: blockerAId,
        blockedIssueId: dependentId,
      });
      await block({
        companyId,
        blockerIssueId: blockerBId,
        blockedIssueId: dependentId,
      });

      await svc.update(blockerAId, {
        status: "cancelled",
        actorAgentId: agentId,
      });
      // After blocker A drops, the dependent is still gated by B; no wake
      // should fire yet (wake-on-ready only).
      const wakersAfterFirst = await getWakeRowsFor(
        companyId,
        "issue_blockers_resolved",
      );
      expect(wakersAfterFirst).toEqual([]);

      await svc.update(blockerBId, {
        status: "cancelled",
        actorAgentId: agentId,
      });
      // Now ready. Exactly one wake — keyed off the now-empty blocker set
      // for the same blockedTransitionAt cycle, so the level-triggered
      // dedup does not double-fire on the second transition.
      const wakersAfterSecond = await getWakeRowsFor(
        companyId,
        "issue_blockers_resolved",
      );
      expect(wakersAfterSecond).toHaveLength(1);
    });
  },
);
