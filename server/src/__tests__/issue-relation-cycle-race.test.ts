/**
 * Race test: concurrent blocker-relation writers with DISJOINT endpoint sets
 * must never jointly persist a blocking cycle.
 *
 * Bug under test (stock engine): syncBlockedByIssueIds locks only the endpoint
 * issue rows (FOR UPDATE), then runs assertNoBlockingCycles against the
 * company-wide `blocks` adjacency, then deletes/inserts issueRelations. Two
 * writers whose endpoint sets are disjoint take no common lock, both pass the
 * cycle check against their own snapshot and both commit -> cycle persisted.
 *
 * Derivation of the jointly-cyclic shape (edge direction = blocker -> blocked,
 * i.e. issueRelations.issueId -> issueRelations.relatedIssueId):
 *   NOTE: the card's literal wording (seeds X->A, B->Z; new X->Z and B->A) is
 *   NOT cyclic: X and B are pure sources, so every edge leaves {X,B}. We
 *   therefore use the same *shape* with a real cycle:
 *     seed edges : P -> S   (S.blockedBy = [P])      and   R -> Q (Q.blockedBy = [R])
 *     writer 1   : update(P, {blockedByIssueIds:[Q]})  adds  Q -> P   endpoints {P,Q}
 *     writer 2   : update(R, {blockedByIssueIds:[S]})  adds  S -> R   endpoints {R,S}
 *   Endpoint sets {P,Q} and {R,S} are disjoint. Seeds sit on S and Q, which
 *   neither writer rewrites (each writer only replaces blockers of its own
 *   issue P / R, which have none beforehand), so they are preserved.
 *   Alone, writer 1 closes no cycle (P->S->(nothing), R->Q->P is not complete
 *   without S->R) and likewise writer 2. Together: Q->P->S->R->Q is a cycle.
 *
 * Mechanism A: a 2-party barrier installed at the after-cycle-check test hook
 *   forces both writers to pass their cycle check before either writes.
 *   Bounded (4s): a patched engine that serialises writers never reaches the
 *   barrier with both parties, so the timeout releasing is expected there.
 * Mechanism B: N iterations (ISSUE_RELATION_RACE_ITERATIONS, default 60,
 *   min 50) of fresh pairs with seeded-PRNG jitter (ISSUE_RELATION_RACE_SEED)
 *   injected via the same hook. Recipe if a plain run does not reproduce on the
 *   unpatched engine: raise ISSUE_RELATION_RACE_ITERATIONS (e.g. 300) and/or
 *   change the seed; writers are launched in the same tick on separate pool
 *   connections and delayed 0-15ms (plus setImmediate yields) after the check.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issueRelations, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";
import { setIssueRelationGuardTestHook } from "../services/issue-relation-test-seam.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const CYCLE_MESSAGE = "Blocking relations cannot contain cycles";
const BARRIER_TIMEOUT_MS = 4_000;

type Edge = { blocker: string; blocked: string };
type Db = ReturnType<typeof createDb>;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Returns one node on a directed cycle, or null when the graph is acyclic. */
function findCycle(edges: Edge[]): string[] | null {
  const adjacency = new Map<string, string[]>();
  const nodes = new Set<string>();
  for (const { blocker, blocked } of edges) {
    nodes.add(blocker);
    nodes.add(blocked);
    adjacency.set(blocker, [...(adjacency.get(blocker) ?? []), blocked]);
  }
  const state = new Map<string, 1 | 2>(); // 1 = on stack, 2 = done
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

describeEmbeddedPostgres("issue blocker relations: concurrent disjoint writers", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: Db;
  let svc!: ReturnType<typeof issueService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-relation-cycle-race-");
    // Real pool: two writers must run on separate connections.
    db = createDb(tempDb.connectionString, { maxConnections: 10 });
    svc = issueService(db);
  }, 120_000);

  afterEach(() => {
    setIssueRelationGuardTestHook(null);
  });

  afterAll(async () => {
    setIssueRelationGuardTestHook(null);
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  async function seedPair() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "RaceCo",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 7).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const [P, Q, R, S] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await db.insert(issues).values(
      [P, Q, R, S].map((id, i) => ({
        id,
        companyId,
        title: `race-${"PQRS"[i]}`,
        status: "todo",
        priority: "medium",
      })),
    );
    // Seed edges: P -> S and R -> Q (blocker -> blocked).
    await db.insert(issueRelations).values([
      { companyId, issueId: P, relatedIssueId: S, type: "blocks" },
      { companyId, issueId: R, relatedIssueId: Q, type: "blocks" },
    ]);
    return { companyId, P, Q, R, S };
  }

  async function readEdges(companyId: string): Promise<Edge[]> {
    const rows = await db
      .select({ blocker: issueRelations.issueId, blocked: issueRelations.relatedIssueId, type: issueRelations.type })
      .from(issueRelations)
      .where(eq(issueRelations.companyId, companyId));
    return rows.filter((row) => row.type === "blocks").map(({ blocker, blocked }) => ({ blocker, blocked }));
  }

  const hasEdge = (edges: Edge[], blocker: string, blocked: string) =>
    edges.some((e) => e.blocker === blocker && e.blocked === blocked);

  /** Run both writers concurrently; returns settled results and the committed flags. */
  async function runWriters(
    ids: { P: string; Q: string; R: string; S: string },
    tracker?: { finished: number },
  ) {
    const track = <T,>(p: Promise<T>) =>
      p.finally(() => {
        if (tracker) tracker.finished += 1;
      });
    const settled = await Promise.allSettled([
      track(svc.update(ids.P, { blockedByIssueIds: [ids.Q] })), // adds Q -> P
      track(svc.update(ids.R, { blockedByIssueIds: [ids.S] })), // adds S -> R
    ]);
    const writers = [
      { name: "writer1", edge: [ids.Q, ids.P] as const, result: settled[0] },
      { name: "writer2", edge: [ids.S, ids.R] as const, result: settled[1] },
    ];
    return writers.map((w) => ({
      ...w,
      committed: w.result.status === "fulfilled" && w.result.value != null,
      // A fulfilled null (issue not found) is neither a commit nor a legal 422.
      cycleRejected:
        w.result.status === "rejected" &&
        (w.result.reason as { status?: number })?.status === 422 &&
        (w.result.reason as { message?: string })?.message === CYCLE_MESSAGE,
    }));
  }

  function describeOutcome(w: Awaited<ReturnType<typeof runWriters>>[number]) {
    if (w.result.status === "fulfilled") return `${w.name}: fulfilled(${w.result.value == null ? "null" : "row"})`;
    const reason = w.result.reason as { status?: number; message?: string };
    return `${w.name}: rejected status=${reason?.status} message=${JSON.stringify(reason?.message ?? String(reason))}`;
  }

  it("A: forced interleaving (both writers pass the cycle check before either writes) never persists a cycle", async () => {
    const ids = await seedPair();
    let arrived = 0;
    let release!: () => void;
    const bothArrived = new Promise<void>((resolve) => {
      release = resolve;
    });
    setIssueRelationGuardTestHook(async (ctx) => {
      if (ctx.companyId !== ids.companyId) return;
      arrived += 1;
      if (arrived >= 2) release();
      // Bounded wait: a patched engine that serialises writers times out here.
      await Promise.race([bothArrived, sleep(BARRIER_TIMEOUT_MS)]);
    });

    const outcomes = await runWriters(ids);
    setIssueRelationGuardTestHook(null);

    // The seam must actually have fired, or every assertion below passes vacuously.
    expect(arrived, "after-cycle-check hook never fired for this company (seam mis-wired?)").toBeGreaterThan(0);

    const edges = await readEdges(ids.companyId);
    const cycle = findCycle(edges);
    expect(
      cycle,
      `blocking cycle persisted: ${JSON.stringify(cycle)}; ${outcomes.map(describeOutcome).join("; ")}`,
    ).toBeNull();

    for (const w of outcomes) {
      expect(
        w.committed || w.cycleRejected,
        `${describeOutcome(w)} - must commit or reject with 422 "${CYCLE_MESSAGE}"`,
      ).toBe(true);
      if (w.committed) expect(hasEdge(edges, w.edge[0], w.edge[1]), `${w.name} reported commit but edge missing`).toBe(true);
    }
    // An over-rejecting engine (422 on both writers) must fail: at least one commits.
    expect(
      outcomes.filter((w) => w.committed).length,
      `no writer committed: ${outcomes.map(describeOutcome).join("; ")}`,
    ).toBeGreaterThanOrEqual(1);
    // Seed edges untouched.
    expect(hasEdge(edges, ids.P, ids.S)).toBe(true);
    expect(hasEdge(edges, ids.R, ids.Q)).toBe(true);
  }, 60_000);

  it("B: randomized concurrent writer pairs never persist a cycle or lose an update", async () => {
    const iterations = Math.max(50, Number(process.env.ISSUE_RELATION_RACE_ITERATIONS ?? 60) || 60);
    const envSeed = process.env.ISSUE_RELATION_RACE_SEED;
    const seed = envSeed !== undefined && envSeed !== "" && Number.isFinite(Number(envSeed))
      ? Number(envSeed) >>> 0
      : (Date.now() & 0xffffffff) >>> 0;
    const rand = mulberry32(seed);
    console.log(`RACE-SEED seed=${seed} iterations=${iterations}`);

    let cyclesPersisted = 0;
    let lostUpdates = 0;
    let hookInvocations = 0;
    let overlaps = 0; // diagnostic only: both hooks entered before either writer finished
    const violations: string[] = [];

    for (let i = 0; i < iterations; i++) {
      const ids = await seedPair();
      // Per-issue jitter drawn up-front so a given seed is reproducible.
      const delays = new Map<string, number>([
        [ids.P, Math.floor(rand() * 16)],
        [ids.R, Math.floor(rand() * 16)],
      ]);
      const yields = new Map<string, number>([
        [ids.P, Math.floor(rand() * 4)],
        [ids.R, Math.floor(rand() * 4)],
      ]);
      const tracker = { finished: 0 };
      let entered = 0;
      let overlapped = false;
      setIssueRelationGuardTestHook(async (ctx) => {
        if (ctx.companyId !== ids.companyId) return;
        hookInvocations += 1;
        entered += 1;
        if (entered === 2 && tracker.finished === 0) overlapped = true;
        for (let y = 0; y < (yields.get(ctx.issueId) ?? 0); y++) await new Promise<void>((r) => setImmediate(r));
        const delay = delays.get(ctx.issueId) ?? 0;
        if (delay > 0) await sleep(delay);
      });

      const outcomes = await runWriters(ids, tracker);
      setIssueRelationGuardTestHook(null);
      if (overlapped) overlaps += 1;

      const edges = await readEdges(ids.companyId);
      const cycle = findCycle(edges);
      if (outcomes.filter((w) => w.committed).length < 1) {
        violations.push(`iter ${i}: no writer committed (${outcomes.map(describeOutcome).join("; ")})`);
      }
      if (!hasEdge(edges, ids.P, ids.S) || !hasEdge(edges, ids.R, ids.Q)) {
        violations.push(`iter ${i}: seed edge lost (P->S intact=${hasEdge(edges, ids.P, ids.S)}, R->Q intact=${hasEdge(edges, ids.R, ids.Q)})`);
      }
      if (cycle) {
        cyclesPersisted += 1;
        violations.push(`iter ${i}: cycle persisted ${JSON.stringify(cycle)}`);
      }
      for (const w of outcomes) {
        if (w.committed) {
          if (!hasEdge(edges, w.edge[0], w.edge[1])) {
            lostUpdates += 1;
            violations.push(`iter ${i}: ${w.name} committed but edge missing`);
          }
        } else if (!w.cycleRejected) {
          violations.push(`iter ${i}: ${describeOutcome(w)} (neither commit nor 422 cycle message)`);
        }
      }
    }

    console.log(
      `RACE-SUMMARY iterations=${iterations} cyclesPersisted=${cyclesPersisted} lostUpdates=${lostUpdates} overlaps=${overlaps} hookInvocations=${hookInvocations} seed=${seed}`,
    );
    expect(hookInvocations, "after-cycle-check hook never fired across the run (seam mis-wired?)").toBeGreaterThan(0);
    expect(violations, `violations (${violations.length}) seed=${seed}:\n${violations.slice(0, 10).join("\n")}`).toEqual([]);
    expect(cyclesPersisted).toBe(0);
    expect(lostUpdates).toBe(0);
  }, Math.max(180_000, Number(process.env.ISSUE_RELATION_RACE_ITERATIONS ?? 60) * 2_000 + 30_000));
});
