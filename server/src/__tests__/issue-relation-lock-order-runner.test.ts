/**
 * Lock-order race test: the native runner tool paths versus a top-level
 * `issueService(db).update(sameIssue, { blockedByIssueIds })`.
 *
 * Law under test: the per-company relation advisory lock
 * (`pg_advisory_xact_lock(hashtextextended('issue_relations:' || companyId, 0))`,
 * exposed as `issueService(db).acquireIssueRelationWriteLock`) must be taken
 * FIRST; only then any issue/run row lock.
 *
 * Violation (before the runner fix): `PaperclipRunnerToolAuthority`
 * `#lockAuthorizedMutationContext` row-locks the bound issue (and run) first,
 * and `set_dependencies` / `create_task` (with blockedByTaskIds) then call into
 * issueService, which takes the relation lock -> row-lock-then-relation-lock.
 * The top-level update takes relation lock then row-locks the same issue ->
 * classic ABBA deadlock, which Postgres resolves by aborting one writer with
 * SQLSTATE 40P01 (deadlock_detected).
 *
 * Deterministic barrier (no sleeps-and-hope, no test hooks needed). THREE real,
 * separate connection pools, each tagged with its own `application_name`:
 *   holder  - opens a tx and takes the relation advisory lock for the company,
 *             then parks. Nobody can acquire the lock while it is held.
 *   update  - the top-level `issueService(...).update(...)` writer ("U").
 *   runner  - `PaperclipRunnerToolAuthority.execute(...)` writer ("R").
 * The test starts the writers one at a time and polls pg_locks/pg_stat_activity
 * until the first one is observed WAITING on an advisory lock (ungranted),
 * then starts and waits for the second. That fixes the queue order on the
 * advisory lock. When the holder commits, Postgres grants the lock to the head
 * of the queue:
 *   - "update-first": U (no row lock yet) is granted the relation lock, then
 *     needs the issue row lock that R already holds (R row-locked before it
 *     queued) while R waits on the relation lock U holds -> deadlock.
 *   - "runner-first": R is granted the lock, finishes and commits; U then
 *     proceeds. Serializes cleanly (and must still pass after the fix).
 *
 * Every wait is bounded, so a hang fails the test rather than the suite.
 *
 * Expected state at the d2a head: the two "runner-first" cases are
 * SERIALIZATION CONTROLS and pass; the two "update-first" cases are the RED
 * ABBA reproductions (they fail with SQLSTATE 40P01 deadlock_detected).
 */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";
import { PaperclipRunnerToolAuthority } from "../services/native-runtime/paperclip-runner-tool-authority.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;
type Tool = "set_dependencies" | "create_task";
type Order = "update-first" | "runner-first";

const DEADLOCK_SQLSTATE = "40P01";
const POLL_TIMEOUT_MS = 15_000;
const SETTLE_TIMEOUT_MS = 30_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`TIMEOUT after ${ms}ms: ${what}`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Collects `code`/`message` from an error and its whole `cause` chain. */
function errorChain(error: unknown): Array<{ code?: string; message: string }> {
  const out: Array<{ code?: string; message: string }> = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const e = current as { code?: unknown; message?: unknown; cause?: unknown };
    out.push({
      code: typeof e.code === "string" ? e.code : undefined,
      message: typeof e.message === "string" ? e.message : String(e.message ?? ""),
    });
    current = e.cause;
  }
  return out;
}

function isDeadlock(error: unknown): boolean {
  return errorChain(error).some(
    (link) => link.code === DEADLOCK_SQLSTATE || /deadlock detected/i.test(link.message),
  );
}

/** Returns one node on a directed cycle, or null when the graph is acyclic. */
function findCycle(edges: Array<{ blocker: string; blocked: string }>): string[] | null {
  const adjacency = new Map<string, string[]>();
  const nodes = new Set<string>();
  for (const { blocker, blocked } of edges) {
    nodes.add(blocker);
    nodes.add(blocked);
    adjacency.set(blocker, [...(adjacency.get(blocker) ?? []), blocked]);
  }
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (node: string): string[] | null => {
    state.set(node, 1);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      if (state.get(next) === 1) return [...stack.slice(stack.indexOf(next)), next];
      if (!state.has(next)) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(node, 2);
    return null;
  };
  for (const node of nodes) {
    if (!state.has(node)) {
      const found = visit(node);
      if (found) return found;
    }
  }
  return null;
}

describeEmbeddedPostgres("issue relation lock order: runner tools vs top-level update", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let adminDb!: Db; // seeding, polling, read-back
  let holderDb!: Db; // parks the relation advisory lock
  let updateDb!: Db; // top-level update writer (U)
  let runnerDb!: Db; // runner tool writer (R)
  let releaseHolder: (() => void) | null = null;
  let holderDone: Promise<void> | null = null;

  const APP = { admin: "lockorder-admin", holder: "lockorder-holder", update: "lockorder-update", runner: "lockorder-runner" };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-relation-lock-order-runner-");
    const make = (name: string) =>
      createDb(tempDb!.connectionString, { maxConnections: 4, applicationName: name });
    adminDb = make(APP.admin);
    holderDb = make(APP.holder);
    updateDb = make(APP.update);
    runnerDb = make(APP.runner);
  }, 120_000);

  afterEach(async () => {
    releaseHolder?.();
    releaseHolder = null;
    // Drain the holder tx so a setup throw cannot leave an unhandled rejection.
    await holderDone?.catch(() => {});
    holderDone = null;
  });

  afterAll(async () => {
    releaseHolder?.();
    await holderDone?.catch(() => {});
    await Promise.all([adminDb, holderDb, updateDb, runnerDb].map((d) => d?.$client.end({ timeout: 1 })));
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    await adminDb.insert(companies).values({
      id: companyId,
      name: "LockOrderCo",
      issuePrefix: `L${companyId.replace(/-/g, "").slice(0, 7).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const agentId = randomUUID();
    await adminDb.insert(agents).values({
      id: agentId,
      companyId,
      name: "Lock order runner agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const [X, B, C] = [randomUUID(), randomUUID(), randomUUID()];
    const runId = randomUUID();
    await adminDb.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      runtimeMode: "native",
      nativeIssueId: X,
      contextSnapshot: { issueId: X },
    });
    await adminDb.insert(issues).values([
      {
        id: X,
        companyId,
        title: "lock-order X (runner-bound issue)",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        executionRunId: runId,
        checkoutRunId: runId,
      },
      { id: B, companyId, title: "lock-order B", status: "todo", priority: "medium" },
      { id: C, companyId, title: "lock-order C", status: "todo", priority: "medium" },
    ]);
    return { companyId, agentId, runId, X, B, C };
  }

  /**
   * Polls pg_locks until a backend with this application_name waits on THE
   * company's relation advisory lock. pg_locks reports a bigint advisory key
   * as classid = high 32 bits, objid = low 32 bits, objsubid = 1.
   */
  async function waitForAdvisoryWaiter(applicationName: string, companyId: string, what: string) {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    for (;;) {
      const rows = (await withTimeout(adminDb.execute(sql`
        SELECT a.pid
        FROM pg_locks l
        JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory'
          AND NOT l.granted
          AND l.objsubid = 1
          AND l.classid::text::bigint = ((hashtextextended(${"issue_relations:" + companyId}, 0) >> 32) & 4294967295)
          AND l.objid::text::bigint = (hashtextextended(${"issue_relations:" + companyId}, 0) & 4294967295)
          AND a.application_name = ${applicationName}
      `), 5000, "poll query")) as unknown as Array<{ pid: number }>;
      if (rows.length > 0) return;
      if (Date.now() > deadline) {
        throw new Error(`SETUP: ${what} never queued on the relation advisory lock within ${POLL_TIMEOUT_MS}ms`);
      }
      await sleep(25);
    }
  }

  async function startHolder(companyId: string) {
    let held!: () => void;
    const heldPromise = new Promise<void>((resolve) => {
      held = resolve;
    });
    const parked = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const tx = holderDb
      .transaction(async (txn) => {
        await issueService(holderDb).acquireIssueRelationWriteLock(txn, companyId);
        held();
        await parked;
      })
      .catch((error) => {
        held();
        throw error;
      });
    holderDone = tx;
    tx.catch(() => {}); // handled branch; callers awaiting holder.done still see the rejection
    await withTimeout(heldPromise, POLL_TIMEOUT_MS, "holder taking the relation advisory lock");
    return { done: tx };
  }

  async function readEdges(companyId: string) {
    const rows = await adminDb
      .select({ blocker: issueRelations.issueId, blocked: issueRelations.relatedIssueId, type: issueRelations.type })
      .from(issueRelations)
      .where(eq(issueRelations.companyId, companyId));
    return rows.filter((r) => r.type === "blocks").map(({ blocker, blocked }) => ({ blocker, blocked }));
  }

  const cases: Array<{ tool: Tool; order: Order }> = [
    { tool: "set_dependencies", order: "update-first" },
    { tool: "set_dependencies", order: "runner-first" },
    { tool: "create_task", order: "update-first" },
    { tool: "create_task", order: "runner-first" },
  ];

  for (const { tool, order } of cases) {
    it(`${tool} vs concurrent update(sameIssue, blockedByIssueIds), ${order} queue order: no deadlock, both succeed, no cycle`, async () => {
      const { companyId, agentId, runId, X, B, C } = await seed();
      const authority = new PaperclipRunnerToolAuthority(runnerDb, { companyId, issueId: X, runId, agentId });

      const startUpdate = () =>
        issueService(updateDb).update(X, { blockedByIssueIds: [C] }).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      const startRunner = () =>
        authority
          .execute(
            tool === "set_dependencies"
              ? {
                  tool,
                  callId: randomUUID(),
                  arguments: { idempotencyKey: randomUUID(), blockedByTaskIds: [B] },
                }
              : {
                  tool,
                  callId: randomUUID(),
                  arguments: {
                    idempotencyKey: randomUUID(),
                    title: "child created under a blocker",
                    blockedByTaskIds: [B],
                  },
                },
          )
          .then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          );

      // 1. Park the relation advisory lock on the holder connection.
      const holder = await startHolder(companyId);

      // 2. Force the queue order on that lock, one writer at a time.
      let updatePromise!: ReturnType<typeof startUpdate>;
      let runnerPromise!: ReturnType<typeof startRunner>;
      if (order === "update-first") {
        updatePromise = startUpdate();
        await waitForAdvisoryWaiter(APP.update, companyId, "top-level update (U)");
        runnerPromise = startRunner();
        await waitForAdvisoryWaiter(APP.runner, companyId, "runner tool (R)");
      } else {
        runnerPromise = startRunner();
        await waitForAdvisoryWaiter(APP.runner, companyId, "runner tool (R)");
        updatePromise = startUpdate();
        await waitForAdvisoryWaiter(APP.update, companyId, "top-level update (U)");
      }

      // 3. Release the holder: the lock goes to the head of the queue.
      releaseHolder?.();
      releaseHolder = null;
      await withTimeout(holder.done, POLL_TIMEOUT_MS, "holder commit");

      const [update, runner] = await withTimeout(
        Promise.all([updatePromise, runnerPromise]),
        SETTLE_TIMEOUT_MS,
        "both writers to settle after the holder released",
      );

      const deadlockErrors = [update, runner]
        .filter((r): r is { ok: false; error: unknown } => !r.ok)
        .filter((r) => isDeadlock(r.error))
        .map((r) => errorChain(r.error).map((l) => `${l.code ?? "-"}: ${l.message}`));
      // Zero deadlock victims (SQLSTATE deadlock_detected anywhere in the cause chain).
      expect(deadlockErrors, "deadlock_detected raised by a writer").toEqual([]);

      // Both writers succeed.
      expect(update.ok ? "ok" : `update failed: ${errorChain(update.error).map((l) => l.message).join(" <- ")}`).toBe("ok");
      expect(runner.ok ? "ok" : `runner failed: ${errorChain(runner.error).map((l) => l.message).join(" <- ")}`).toBe("ok");
      if (update.ok) expect(update.value).not.toBeNull();

      // No persisted blocking cycle, and the final graph is exactly what the committed writers wrote.
      const edges = await readEdges(companyId);
      expect(findCycle(edges)).toBeNull();
      const blockersOf = (id: string) => edges.filter((e) => e.blocked === id).map((e) => e.blocker).sort();
      if (tool === "set_dependencies") {
        // Same issue, last committed writer wins: exactly one of the two sets.
        const final = blockersOf(X);
        expect([[B], [C]]).toContainEqual(final);
        // Serialized order is deterministic: the holder released to the queue head first.
        expect(final).toEqual(order === "update-first" ? [B] : [C]);
      } else {
        expect(blockersOf(X)).toEqual([C]);
        const child = (await adminDb.select({ id: issues.id }).from(issues).where(eq(issues.parentId, X)))[0];
        expect(child, "create_task child exists").toBeDefined();
        expect(blockersOf(child!.id)).toEqual([B]);
      }

    }, 90_000);
  }
});
