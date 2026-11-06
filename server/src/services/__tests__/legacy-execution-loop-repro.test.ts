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

type TestDb = ReturnType<typeof createDb>;

async function insertLoopFixture(
  db: TestDb,
  label: string,
  runOverrides: Record<string, unknown> = {},
) {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const issueId = randomUUID();
  const runId = randomUUID();
  const expectedFingerprint = `legacy-execution:${runId}`;
  await db.insert(companies).values({
    id: companyId,
    name: label,
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
    ...runOverrides,
  });
  return { companyId, agentId, issueId, runId, expectedFingerprint };
}

async function terminalizeAndSettle(db: TestDb, runId: string) {
  const [run] = await db
    .select()
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId));
  await terminalizeLegacyExecution({ db, run: run!, status: "failed" });
  await settleUnrecoverableExecutions(db);
}

async function readActions(db: TestDb, issueId: string) {
  return db
    .select()
    .from(issueRecoveryActions)
    .where(eq(issueRecoveryActions.sourceIssueId, issueId));
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
  "legacy-execution recovery-action create/settle loop repro",
  () => {
    let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
    let db: TestDb;
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

    it("N=3 cycles yield exactly one recovery action and one settled log", async () => {
      const { issueId, runId, expectedFingerprint } =
        await insertLoopFixture(db, "Loop Repro");

      for (let cycle = 1; cycle <= 3; cycle += 1) {
        const [run] = await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, runId));
        await terminalizeLegacyExecution({ db, run: run!, status: "failed" });
        await settleUnrecoverableExecutions(db);
        const actions = await readActions(db, issueId);
        const ids = actions.map((action) => action.id).join(",");
        const fingerprints = actions
          .map((action) => String(action.fingerprint))
          .join(",");
        console.log(
          `CYCLE ${cycle} actions=${actions.length} ids=${ids} fingerprints=${fingerprints}`,
        );
      }

      // Idempotent per fingerprint: repeated terminalize/settle sweeps must
      // not mint a fresh row per cycle.
      const actions = await readActions(db, issueId);
      expect(actions).toHaveLength(1);
      // Fingerprint stable, single UUID retained.
      expect(actions.map((action) => action.fingerprint)).toEqual([
        expectedFingerprint,
      ]);
      expect(new Set(actions.map((action) => action.id)).size).toBe(1);
      // The retained row is terminal, with replay blocked under the
      // preserve-without-replay policy for this run — however the
      // resolution was recorded (no executionReconciliation required, no
      // workspaceRestoreFailure required).
      const [retained] = actions;
      expect(retained!.status).toBe("resolved");
      expect(retained!.evidence?.runId).toBe(runId);
      const automaticRecovery = (retained!.evidence as Record<string, any>)
        ?.automaticRecovery as Record<string, any> | undefined;
      expect(automaticRecovery).toMatchObject({
        policy: "preserve_without_replay_v1",
        replay: "blocked",
        runId,
      });
      // Exactly one settled activity row: later cycles add zero new rows.
      const settledLogs = await readSettledLogs(db, issueId);
      expect(settledLogs).toHaveLength(1);
    });

    it("a genuinely new failure (different runId) still creates a new action row", async () => {
      const { issueId, runId: firstRunId } = await insertLoopFixture(
        db,
        "Loop Oracle New",
      );
      await terminalizeAndSettle(db, firstRunId);
      const secondRunId = randomUUID();
      const [first] = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, firstRunId));
      await db.insert(heartbeatRuns).values({
        id: secondRunId,
        companyId: first!.companyId,
        agentId: first!.agentId,
        nativeIssueId: issueId,
        runtimeMode: "legacy",
        status: "failed",
        errorCode: "adapter_failed",
        contextSnapshot: { issueId },
      });
      await terminalizeAndSettle(db, secondRunId);

      const actions = await readActions(db, issueId);
      const fingerprints = actions.map((action) => String(action.fingerprint));
      console.log(
        `ORACLE new-run actions=${actions.length} fingerprints=${fingerprints.join(",")}`,
      );
      // No over-suppression: a distinct run identity mints its own row.
      expect(actions).toHaveLength(2);
      expect(new Set(fingerprints).size).toBe(2);
      expect(fingerprints).toEqual(
        expect.arrayContaining([
          `legacy-execution:${firstRunId}`,
          `legacy-execution:${secondRunId}`,
        ]),
      );
      expect(new Set(actions.map((action) => action.id)).size).toBe(2);
    });

    it("a resolved row stays resolved across further settle sweeps", async () => {
      const { issueId, runId } = await insertLoopFixture(
        db,
        "Loop Oracle Stable",
      );
      await terminalizeAndSettle(db, runId);
      const [settled] = await readActions(db, issueId);
      expect(settled!.status).toBe("resolved");
      const settledId = settled!.id;
      const logsBefore = await readSettledLogs(db, issueId);

      // Further settle-only sweeps plus repeat terminalize/settle cycles must
      // neither reopen the row nor leak extra rows or settled logs.
      await settleUnrecoverableExecutions(db);
      await terminalizeAndSettle(db, runId);
      await settleUnrecoverableExecutions(db);
      const [run] = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId));
      await terminalizeLegacyExecution({ db, run: run!, status: "failed" });
      await settleUnrecoverableExecutions(db);
      const actions = await readActions(db, issueId);
      console.log(
        `ORACLE stable actions=${actions.length} ids=${actions.map((a) => a.id).join(",")}`,
      );
      expect(actions).toHaveLength(1);
      expect(actions[0]!.id).toBe(settledId);
      expect(actions[0]!.status).toBe("resolved");
      expect(["active", "escalated"]).not.toContain(actions[0]!.status);
      const logsAfter = await readSettledLogs(db, issueId);
      expect(logsAfter).toHaveLength(logsBefore.length);
    });
  },
);
