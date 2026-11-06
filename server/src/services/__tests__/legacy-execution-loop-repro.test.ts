import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { terminalizeLegacyExecution } from "../legacy-execution-recovery.js";
import { settleUnrecoverableExecutions } from "../execution-recovery-resolution.js";

const externalDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = externalDatabaseUrl
  ? { supported: true }
  : await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)(
  "legacy-execution recovery-action create/settle loop repro",
  () => {
    let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
    let db: ReturnType<typeof createDb>;
    beforeAll(async () => {
      if (externalDatabaseUrl) {
        db = createDb(externalDatabaseUrl);
        return;
      }
      database = await startEmbeddedPostgresTestDatabase(
        "paperclip-legacy-execution-loop-",
      );
      db = createDb(database.connectionString);
    }, 30_000);
    afterEach(async () => {
      await db.execute(sql`TRUNCATE companies CASCADE`);
    });
    afterAll(async () => {
      if (externalDatabaseUrl) await db?.$client.end();
      else await database?.cleanup();
    });

    it("creates one fresh recovery action per terminalize/settle cycle (N=3)", async () => {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const issueId = randomUUID();
      const runId = randomUUID();
      const expectedFingerprint = `legacy-execution:${runId}`;
      await db.insert(companies).values({
        id: companyId,
        name: "Loop Repro",
        issuePrefix: `LR${companyId.slice(0, 6)}`,
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Executor",
        role: "engineer",
        adapterType: "paperclip_runner",
      });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Loop fixture",
        status: "in_progress",
        assigneeAgentId: agentId,
      });
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

      for (let cycle = 1; cycle <= 3; cycle += 1) {
        const [run] = await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, runId));
        await terminalizeLegacyExecution({ db, run: run!, status: "failed" });
        await settleUnrecoverableExecutions(db);
        const actions = await db
          .select()
          .from(issueRecoveryActions)
          .where(eq(issueRecoveryActions.sourceIssueId, issueId));
        const ids = actions.map((action) => action.id).join(",");
        const fingerprints = actions
          .map((action) => String(action.fingerprint))
          .join(",");
        console.log(
          `CYCLE ${cycle} actions=${actions.length} ids=${ids} fingerprints=${fingerprints}`,
        );
      }

      const actions = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, issueId));
      // One fresh row per cycle: the settler resolves each action with
      // evidence.automaticRecovery.replay="blocked" but no
      // evidence.executionReconciliation, so the terminalize skip-guard
      // (legacy-execution-recovery.ts:133-147) misses and inserts again.
      expect(actions).toHaveLength(3);
      // Same identity re-created, fresh UUIDs each cycle.
      expect(actions.map((action) => action.fingerprint)).toEqual([
        expectedFingerprint,
        expectedFingerprint,
        expectedFingerprint,
      ]);
      expect(new Set(actions.map((action) => action.id)).size).toBe(3);
      for (const action of actions) {
        expect(action.status).toBe("resolved");
        expect(action.evidence?.automaticRecovery?.replay).toBe("blocked");
        expect(action.evidence?.runId).toBe(runId);
        // The guard's second disjunct needs workspaceRestoreFailure, which
        // this fixture lacks; the first disjunct needs executionReconciliation.
        expect(action.evidence).not.toHaveProperty("executionReconciliation");
        expect(action.evidence).not.toHaveProperty("workspaceRestoreFailure");
      }
      const settledLogs = await db
        .select()
        .from(activityLog)
        .where(
          and(
            eq(activityLog.entityId, issueId),
            eq(activityLog.action, "issue.execution_recovery_settled"),
          ),
        );
      expect(settledLogs).toHaveLength(3);
    });
  },
);
