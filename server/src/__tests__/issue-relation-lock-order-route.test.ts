/**
 * Lock-order race test: the review-policy-sensitive `PATCH /api/issues/:id`
 * route versus a top-level `issueService(db).update(sameIssue, { blockedByIssueIds })`.
 *
 * Law under test: the per-company relation advisory lock
 * (`pg_advisory_xact_lock(hashtextextended('issue_relations:' || companyId, 0))`,
 * exposed as `issueService(db).acquireIssueRelationWriteLock`) must be taken
 * FIRST; only then any issue row lock.
 *
 * Violation: in routes/issues.ts the PATCH handler, when
 * `reviewPolicySensitiveMutationRequested` is true (any body carrying
 * `reviewPolicy`, or status done/cancelled), opens `db.transaction` and calls
 * `assertLockedReviewPolicyAllowsMutation(tx)` -> `svc.getByIdForUpdate(id, tx)`
 * (a row lock on the issue) BEFORE `svc.update(id, data, tx)` takes the relation
 * lock for `blockedByIssueIds`. That is row-lock-then-relation-lock. The
 * top-level update takes the relation lock, then row-locks the same issue ->
 * classic ABBA deadlock; Postgres aborts one writer with SQLSTATE 40P01.
 *
 * Deterministic barrier (no sleeps-and-hope, no test hooks). THREE real,
 * separate connection pools, each tagged with its own `application_name`; the
 * route is mounted on the "route" pool so its transaction genuinely row-locks:
 *   holder  - opens a tx and takes the relation advisory lock for the company,
 *             then parks. Nobody else can acquire the lock while it is held.
 *   update  - the top-level `issueService(...).update(...)` writer ("U").
 *   route   - the real PATCH /api/issues/:id handler (supertest) ("R").
 * The test starts the writers one at a time and polls pg_locks (exact
 * classid/objid match of the company's advisory key) until the first one is
 * observed WAITING (ungranted), then starts and waits for the second. That
 * fixes the queue order on the advisory lock. When the holder commits,
 * Postgres grants the lock to the head of the queue (FIFO):
 *   - "update-first": U (no row lock yet) is granted the relation lock, then
 *     needs the issue row lock that R already holds while R waits on the
 *     relation lock U holds -> deadlock (RED at this head, 40P01).
 *   - "route-first": R is granted the lock, finishes and commits; U then
 *     proceeds. Serializes cleanly (control; must stay green after the fix).
 *
 * Every wait is bounded, so a hang fails the test rather than the suite.
 *
 * Expected state at the d2a head: "route-first" is the SERIALIZATION CONTROL
 * and passes; "update-first" is the RED ABBA reproduction (fails with 40P01).
 */
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
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
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;
type Order = "update-first" | "route-first";

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

function isDeadlockLink(link: { code?: string; message: string }): boolean {
  return link.code === DEADLOCK_SQLSTATE || /deadlock detected|40P01/i.test(link.message);
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

describeEmbeddedPostgres("issue relation lock order: review-sensitive PATCH route vs top-level update", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let adminDb!: Db; // seeding, polling, read-back
  let holderDb!: Db; // parks the relation advisory lock
  let updateDb!: Db; // top-level update writer (U)
  let routeDb!: Db; // backs the real issueRoutes router (R)
  let releaseHolder: (() => void) | null = null;
  let holderDone: Promise<void> | null = null;

  const APP = {
    admin: "lockorder-route-admin",
    holder: "lockorder-route-holder",
    update: "lockorder-route-update",
    route: "lockorder-route-route",
  };

  const routeErrors: unknown[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };

  beforeAll(async () => {
    process.on("unhandledRejection", onUnhandled);
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-relation-lock-order-route-");
    const make = (name: string) =>
      createDb(tempDb!.connectionString, { maxConnections: 4, applicationName: name });
    adminDb = make(APP.admin);
    holderDb = make(APP.holder);
    updateDb = make(APP.update);
    routeDb = make(APP.route);
  }, 120_000);

  afterEach(async () => {
    releaseHolder?.();
    releaseHolder = null;
    // Drain the holder tx so a setup throw cannot leave an unhandled rejection.
    await holderDone?.catch(() => {});
    holderDone = null;
    // Let any stray rejection surface before asserting the guard.
    await sleep(0);
    expect(unhandled, "unhandled promise rejection during the test").toEqual([]);
  });

  afterAll(async () => {
    process.off("unhandledRejection", onUnhandled);
    releaseHolder?.();
    await holderDone?.catch(() => {});
    await Promise.all([adminDb, holderDb, updateDb, routeDb].map((d) => d?.$client.end({ timeout: 1 })));
    await tempDb?.cleanup();
  });

  function app() {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "board-user",
        source: "local_implicit",
        isInstanceAdmin: true,
      };
      next();
    });
    testApp.use("/api", issueRoutes(routeDb, {} as never));
    // The production errorHandler flattens a 40P01 into a generic 500 body, so
    // record the raw error (with its SQLSTATE cause chain) before delegating.
    testApp.use((err: unknown, _req: express.Request, _res: express.Response, next: express.NextFunction) => {
      routeErrors.push(err);
      next(err);
    });
    testApp.use(errorHandler);
    return testApp;
  }

  async function seed() {
    const companyId = randomUUID();
    await adminDb.insert(companies).values({
      id: companyId,
      name: "LockOrderRouteCo",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 7).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const agentId = randomUUID();
    await adminDb.insert(agents).values({
      id: agentId,
      companyId,
      name: "Lock order route agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const [X, B, C] = [randomUUID(), randomUUID(), randomUUID()];
    await adminDb.insert(issues).values([
      {
        id: X,
        companyId,
        title: "route lock-order X (contended issue)",
        status: "todo",
        priority: "medium",
        // A non-null policy; the PATCH body restates it, which makes
        // reviewPolicySensitiveMutationRequested true without a verdict check.
        reviewPolicy: "anyone",
      },
      { id: B, companyId, title: "route lock-order B", status: "todo", priority: "medium" },
      { id: C, companyId, title: "route lock-order C", status: "todo", priority: "medium" },
    ]);
    return { companyId, X, B, C };
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

  const orders: Order[] = ["update-first", "route-first"];

  for (const order of orders) {
    it(`review-sensitive PATCH route vs concurrent update(sameIssue, blockedByIssueIds), ${order} queue order: no deadlock, both succeed, no cycle`, async () => {
      const { companyId, X, B, C } = await seed();
      routeErrors.length = 0;
      const testApp = app();

      const startUpdate = () =>
        issueService(updateDb).update(X, { blockedByIssueIds: [C] }).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      // reviewPolicy in the body => reviewPolicySensitiveMutationRequested =>
      // the handler takes the row lock (getByIdForUpdate) before svc.update's
      // relation lock for blockedByIssueIds.
      const startRoute = () =>
        new Promise<{ ok: true; status: number; body: unknown } | { ok: false; error: unknown }>((resolve) => {
          request(testApp)
            .patch(`/api/issues/${X}`)
            .send({ reviewPolicy: "anyone", blockedByIssueIds: [B] })
            .then(
              (res) => resolve({ ok: true, status: res.status, body: res.body }),
              (error: unknown) => resolve({ ok: false, error }),
            );
        });

      // 1. Park the relation advisory lock on the holder connection.
      const holder = await startHolder(companyId);

      // 2. Force the queue order on that lock, one writer at a time.
      let updatePromise!: ReturnType<typeof startUpdate>;
      let routePromise!: ReturnType<typeof startRoute>;
      if (order === "update-first") {
        updatePromise = startUpdate();
        await waitForAdvisoryWaiter(APP.update, companyId, "top-level update (U)");
        routePromise = startRoute();
        await waitForAdvisoryWaiter(APP.route, companyId, "PATCH route (R)");
      } else {
        routePromise = startRoute();
        await waitForAdvisoryWaiter(APP.route, companyId, "PATCH route (R)");
        updatePromise = startUpdate();
        await waitForAdvisoryWaiter(APP.update, companyId, "top-level update (U)");
      }

      // 3. Release the holder: the lock goes to the head of the queue.
      releaseHolder?.();
      releaseHolder = null;
      await withTimeout(holder.done, POLL_TIMEOUT_MS, "holder commit");

      const [update, route] = await withTimeout(
        Promise.all([updatePromise, routePromise]),
        SETTLE_TIMEOUT_MS,
        "both writers to settle after the holder released",
      );

      // Zero deadlock victims: SQLSTATE 40P01 anywhere in the update's error
      // chain, or in the route's HTTP error body (the error handler may map it to a 500).
      const deadlockEvidence: string[] = [];
      if (!update.ok) {
        const links = errorChain(update.error);
        if (links.some(isDeadlockLink)) {
          deadlockEvidence.push(`update: ${links.map((l) => `${l.code ?? "-"}: ${l.message}`).join(" <- ")}`);
        }
      }
      if (!route.ok) {
        const links = errorChain(route.error);
        if (links.some(isDeadlockLink)) {
          deadlockEvidence.push(`route: ${links.map((l) => `${l.code ?? "-"}: ${l.message}`).join(" <- ")}`);
        }
      } else if (route.status !== 200 && isDeadlockLink({ message: JSON.stringify(route.body) })) {
        deadlockEvidence.push(`route: HTTP ${route.status} ${JSON.stringify(route.body)}`);
      }
      for (const err of routeErrors) {
        const links = errorChain(err);
        if (links.some(isDeadlockLink)) {
          deadlockEvidence.push(`route (raw handler error): ${links.map((l) => `${l.code ?? "-"}: ${l.message}`).join(" <- ")}`);
        }
      }
      expect(deadlockEvidence, `deadlock_detected (${DEADLOCK_SQLSTATE}) raised by a writer`).toEqual([]);

      // Both writers succeed.
      expect(update.ok ? "ok" : `update failed: ${errorChain(update.error).map((l) => l.message).join(" <- ")}`).toBe("ok");
      if (update.ok) expect(update.value).not.toBeNull();
      expect(route.ok ? route.status : `route request failed: ${errorChain(route.error).map((l) => l.message).join(" <- ")}`, route.ok ? JSON.stringify(route.body) : undefined).toBe(200);

      // No persisted blocking cycle, and the final graph is exactly what the
      // last committed writer wrote (the holder released to the queue head first).
      const edges = await readEdges(companyId);
      expect(findCycle(edges)).toBeNull();
      const blockersOfX = edges.filter((e) => e.blocked === X).map((e) => e.blocker).sort();
      expect([[B], [C]]).toContainEqual(blockersOfX);
      expect(blockersOfX).toEqual(order === "update-first" ? [B] : [C]);
    }, 90_000);
  }
});
