/**
 * Mixed-workload concurrency test (card SPA-16971, R2).
 *
 * Law under test: the per-company relation advisory lock
 * (`pg_advisory_xact_lock(hashtextextended('issue_relations:' || companyId, 0))`,
 * taken FIRST inside `syncBlockedByIssueIds`, before row locks and the cycle
 * check) makes a MIXED workload — concurrent blocker-relation writes + plain
 * issue updates + unrelated writes — complete within a FIXED timeout with a
 * correct final state, and makes concurrent writers to the SAME
 * (blocker-set, target-issue) pair serialize so that exactly one writer's
 * complete written set is observable at the end.
 *
 * FIXED TIMEOUT (stated per R2): the whole mixed workload must settle within
 * 30 seconds — `MIXED_WORKLOAD_BUDGET_MS` below, asserted explicitly against
 * the measured wall clock, and backed by it() timeouts above that budget so a
 * budget overrun fails the assertion (with the elapsed time in the message)
 * rather than letting vitest kill the run.
 *
 * Correct final state (R2) means ALL of:
 *   - no blocking cycle exists in the final relation graph;
 *   - every write that returned success is reflected;
 *   - no torn/interleaved relation row: the final blockedBy set of a
 *     contended issue equals exactly one writer's complete written set
 *     (never a union, intersection, or partial mix of two writers' sets).
 *
 * Workload shapes are acyclic BY CONSTRUCTION so every write has a legal
 * success path and any rejection is itself a defect:
 *   - "sources" (S*) are pure blockers: they never appear as `blocked`, so no
 *     edge is ever added out of them and the cycle check's forward BFS from a
 *     target (which has no outgoing blocker->blocked edges) always terminates
 *     immediately. Edges only ever go source -> target: a bipartite DAG under
 *     any interleaving.
 *
 * Mechanism (test 2, deterministic barrier, no sleeps-and-hope): the first
 * writer to reach the after-cycle-check test seam parks (bounded 4s, as in
 * issue-relation-cycle-race.test.ts). With the advisory lock in place the
 * sibling writers are parked at `pg_advisory_xact_lock` — strictly BEFORE the
 * cycle check — so they can never enter the seam while the first writer holds
 * it: max concurrent seam occupancy must be exactly 1. If the lock were
 * dropped, both writers pass the cycle check and sit in the seam together
 * (maxConcurrent >= 2) and their delete/insert windows interleave into a torn
 * union -> the test goes red on both discriminators.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
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

/** FIXED budget for the whole mixed workload (R2: state the timeout in the test). */
const MIXED_WORKLOAD_BUDGET_MS = 30_000;
/** Bounded wait for the deterministic same-pair barrier (serialization control). */
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

function describeOutcome(result: PromiseSettledResult<unknown>): string {
  if (result.status === "fulfilled") {
    return result.value == null ? "fulfilled(null: issue not found?)" : "fulfilled(row)";
  }
  const reason = result.reason as { status?: number; message?: string };
  return `rejected status=${reason?.status} message=${JSON.stringify(reason?.message ?? String(result.reason))}`;
}

describeEmbeddedPostgres("issue relations: mixed workload concurrency", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: Db;
  let svc!: ReturnType<typeof issueService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-relation-mixed-workload-");
    // Real pool: the workload's writers must run on separate connections.
    db = createDb(tempDb.connectionString, {
      maxConnections: 10,
      applicationName: "issue-relation-mixed-workload",
    });
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

  async function seedCompany(name: string): Promise<string> {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 7).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedIssues(companyId: string, titles: string[]): Promise<string[]> {
    const ids = titles.map(() => randomUUID());
    await db.insert(issues).values(
      ids.map((id, i) => ({
        id,
        companyId,
        title: titles[i],
        status: "todo",
        priority: "medium",
      })),
    );
    return ids;
  }

  async function readEdges(companyId: string): Promise<Edge[]> {
    const rows = await db
      .select({ blocker: issueRelations.issueId, blocked: issueRelations.relatedIssueId, type: issueRelations.type })
      .from(issueRelations)
      .where(eq(issueRelations.companyId, companyId));
    return rows.filter((row) => row.type === "blocks").map(({ blocker, blocked }) => ({ blocker, blocked }));
  }

  /** Final blocker set of one target issue (complete written set of the last sync). */
  async function readBlockedBy(companyId: string, targetId: string): Promise<string[]> {
    const rows = await db
      .select({ blocker: issueRelations.issueId, type: issueRelations.type })
      .from(issueRelations)
      .where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.relatedIssueId, targetId)));
    return rows
      .filter((row) => row.type === "blocks")
      .map((row) => row.blocker)
      .sort();
  }

  it("A: relation writes + issue updates + unrelated writes complete within the fixed 30s budget with correct final state", async () => {
    const companyId = await seedCompany("MixedWorkloadCo");
    const unrelatedCompanyId = await seedCompany("UnrelatedCo");
    const [U] = await seedIssues(unrelatedCompanyId, ["unrelated other-company issue"]);

    // 4 pure sources (never blocked) + 6 pure targets (never blockers).
    const S = await seedIssues(companyId, ["mixed S1", "mixed S2", "mixed S3", "mixed S4"]);
    const T = await seedIssues(companyId, [
      "mixed T1", "mixed T2", "mixed T3", "mixed T4", "mixed T5", "mixed T6",
    ]);

    // Relation writers: distinct targets, pairwise-different complete blocker
    // sets (subsets of sources only -> acyclic under any interleaving).
    const relationWrites: Array<{ target: string; blockers: string[] }> = [
      { target: T[0], blockers: [S[0]] },
      { target: T[1], blockers: [S[0], S[1]] },
      { target: T[2], blockers: [S[1], S[2]] },
      { target: T[3], blockers: [S[2], S[3]] },
      { target: T[4], blockers: [S[3]] },
      { target: T[5], blockers: [S[0], S[2]] },
    ];
    // Plain issue updates, two of them contending with each other AND with the
    // relation writer on T[0] (same row, same tick). Title/priority only:
    // status transitions (e.g. in_progress) carry assignee requirements that
    // would make the 422 rejection legal here instead of a defect.
    const issueUpdates: Array<{ issueId: string; data: Partial<typeof issues.$inferInsert> }> = [
      { issueId: T[0], data: { title: "mixed-u1 T1", priority: "high" } },
      { issueId: T[0], data: { title: "mixed-u2 T1", priority: "low" } },
      { issueId: T[2], data: { title: "mixed-u3 T3" } },
      { issueId: T[4], data: { title: "mixed-u4 T5", priority: "high" } },
    ];

    const envSeed = process.env.ISSUE_RELATION_MIXED_SEED;
    const seed = envSeed !== undefined && envSeed !== "" && Number.isFinite(Number(envSeed))
      ? Number(envSeed) >>> 0
      : (Date.now() & 0xffffffff) >>> 0;
    const rand = mulberry32(seed);
    console.log(`MIXED-WORKLOAD-SEED seed=${seed}`);
    const jitter = () => sleep(Math.floor(rand() * 11)); // 0-10ms, seeded & reproducible

    // Concurrency control: proves the workload genuinely overlapped (a
    // sequential shuffle would keep max == 1 and make every later assertion vacuous).
    const inFlight = { now: 0, max: 0 };
    const tracked = async <T>(work: () => Promise<T>): Promise<T> => {
      inFlight.now += 1;
      inFlight.max = Math.max(inFlight.max, inFlight.now);
      try {
        await jitter();
        return await work();
      } finally {
        inFlight.now -= 1;
      }
    };

    const startedAt = Date.now();
    // All three families are created in the same tick: 16 writes in flight together.
    const [relationSettled, updateSettled, unrelatedSettled] = await Promise.all([
      Promise.allSettled(
        relationWrites.map((w) => tracked(() => svc.update(w.target, { blockedByIssueIds: w.blockers }))),
      ),
      Promise.allSettled(
        issueUpdates.map((u) => tracked(() => svc.update(u.issueId, u.data))),
      ),
      Promise.allSettled([
        tracked(() => svc.update(U, { title: "unrelated other-company issue: retitled" })),
        tracked(async () => {
          const [newIssue] = await seedIssues(companyId, ["unrelated new issue 1"]);
          return newIssue;
        }),
        tracked(async () => {
          const [newIssue] = await seedIssues(companyId, ["unrelated new issue 2"]);
          return newIssue;
        }),
        tracked(async () => {
          const id = randomUUID();
          await db.insert(issues).values({
            id,
            companyId,
            title: "unrelated new issue 3 (raw insert)",
            status: "todo",
            priority: "low",
          });
          return id;
        }),
      ]),
    ]);
    const elapsedMs = Date.now() - startedAt;

    // --- the FIXED budget (stated above): everything settled within 30s.
    expect(
      elapsedMs,
      `mixed workload exceeded the fixed ${MIXED_WORKLOAD_BUDGET_MS}ms budget: took ${elapsedMs}ms`,
    ).toBeLessThanOrEqual(MIXED_WORKLOAD_BUDGET_MS);
    // --- vacuity control: the writes really overlapped.
    expect(
      inFlight.max,
      "workload never overlapped (max in-flight writes == 1): the concurrency oracle below would be vacuous",
    ).toBeGreaterThanOrEqual(2);

    // --- every write that returned success... (here: every write must succeed;
    // the shapes are acyclic by construction, so a rejection is a defect).
    const failures: string[] = [];
    relationSettled.forEach((r, i) => {
      if (r.status !== "fulfilled" || r.value == null) failures.push(`relation writer ${i} (T[${i}]): ${describeOutcome(r)}`);
    });
    updateSettled.forEach((r, i) => {
      if (r.status !== "fulfilled" || r.value == null) failures.push(`issue update ${i}: ${describeOutcome(r)}`);
    });
    unrelatedSettled.forEach((r, i) => {
      if (r.status !== "fulfilled" || r.value == null) failures.push(`unrelated write ${i}: ${describeOutcome(r)}`);
    });
    expect(
      failures,
      `${failures.length} write(s) did not succeed:\n${failures.join("\n")}`,
    ).toEqual([]);

    // --- no blocking cycle in the final relation graph.
    const edges = await readEdges(companyId);
    const cycle = findCycle(edges);
    expect(cycle, `blocking cycle persisted: ${JSON.stringify(cycle)}`).toBeNull();

    // --- every committed relation write fully reflected, no torn row: the
    // final blockedBy set of each target equals EXACTLY that writer's set.
    for (const w of relationWrites) {
      const finalBlockedBy = await readBlockedBy(companyId, w.target);
      expect(
        finalBlockedBy,
        `blockedBy of target ${w.target} is not exactly the writer's complete set ${JSON.stringify([...w.blockers].sort())}`,
      ).toEqual([...w.blockers].sort());
    }
    // No stray edges beyond the written ones.
    const expectedEdgeCount = relationWrites.reduce((sum, w) => sum + w.blockers.length, 0);
    expect(edges, "unexpected extra/missing blocking edges in the final graph").toHaveLength(expectedEdgeCount);

    // --- committed issue updates reflected; the doubly-contended row (T[0])
    // carries exactly one writer's complete (title,priority) pair.
    const [t1] = await db.select().from(issues).where(eq(issues.id, T[0]));
    const t1CandidatePairs = issueUpdates
      .slice(0, 2)
      .map((u) => [u.data.title, u.data.priority]);
    expect(
      t1CandidatePairs,
      `contended issue T[0] is torn: final ${JSON.stringify([t1.title, t1.priority])} matches neither writer's complete write`,
    ).toContainEqual([t1.title, t1.priority]);
    const [t3] = await db.select().from(issues).where(eq(issues.id, T[2]));
    expect(t3.title).toBe(issueUpdates[2].data.title);
    const [t5] = await db.select().from(issues).where(eq(issues.id, T[4]));
    expect([t5.title, t5.priority]).toEqual([issueUpdates[3].data.title, issueUpdates[3].data.priority]);

    // --- unrelated writes reflected (other company + new same-company rows).
    const [u] = await db.select().from(issues).where(eq(issues.id, U));
    expect(u.title).toBe("unrelated other-company issue: retitled");
    const newTitles = await db
      .select({ title: issues.title })
      .from(issues)
      .where(eq(issues.companyId, companyId));
    for (const expected of ["unrelated new issue 1", "unrelated new issue 2", "unrelated new issue 3 (raw insert)"]) {
      expect(newTitles.map((r) => r.title), `unrelated insert missing: ${expected}`).toContain(expected);
    }
  }, 90_000);

  it("B: concurrent writers to the SAME pair serialize — final blockedBy set is exactly one writer's complete set", async () => {
    const companyId = await seedCompany("SamePairCo");
    const [T] = await seedIssues(companyId, ["same-pair contended target"]);
    const S = await seedIssues(companyId, ["same-pair S1", "same-pair S2", "same-pair S3", "same-pair S4", "same-pair S5"]);

    // Five writers, same target, pairwise-different complete blocker sets.
    // Deliberately an ANTICHAIN whose pairwise unions match no member set, so
    // a torn interleaved delete/insert (union or mix of two writers' writes)
    // can never masquerade as some writer's complete set.
    const writerSets: string[][] = [
      [S[0], S[1]],
      [S[2], S[3]],
      [S[0], S[4]],
      [S[1], S[2], S[4]],
      [S[3], S[4]],
    ];

    // Deterministic serialization control: the FIRST writer into the
    // after-cycle-check seam parks (bounded). Every sibling writer with the
    // advisory lock in place is parked earlier, at pg_advisory_xact_lock, and
    // can only pass the cycle check AFTER the holder committed — so while the
    // holder sits in the seam nobody else is inside it.
    let arrived = 0;
    let inHook = 0;
    let maxConcurrent = 0;
    let release!: () => void;
    const aSecondWriterArrived = new Promise<void>((resolve) => {
      release = resolve;
    });
    setIssueRelationGuardTestHook(async (ctx) => {
      if (ctx.companyId !== companyId) return;
      arrived += 1;
      inHook += 1;
      maxConcurrent = Math.max(maxConcurrent, inHook);
      try {
        if (arrived === 1) {
          // First writer parks until a sibling joins it inside the guard
          // section (proof the advisory lock did NOT serialize) or the bounded
          // timeout releases it (the expected path: siblings are parked at
          // pg_advisory_xact_lock, strictly before the cycle check).
          await Promise.race([aSecondWriterArrived, sleep(BARRIER_TIMEOUT_MS)]);
        } else {
          release(); // a sibling reached the guard section: wake the parked holder
        }
      } finally {
        inHook -= 1;
      }
    });

    const settled = await Promise.allSettled(
      writerSets.map((set) => svc.update(T, { blockedByIssueIds: set })),
    );
    setIssueRelationGuardTestHook(null);

    // The seam must have fired for every writer (all sets are non-empty).
    expect(arrived, "after-cycle-check seam never fired (mis-wired?)").toBe(writerSets.length);
    // Serialization control: never two writers inside the guard section at once.
    expect(
      maxConcurrent,
      `${maxConcurrent} writers passed the cycle check concurrently: the relation advisory lock did not serialize same-pair writers`,
    ).toBe(1);

    // All five writers succeed (acyclic by construction).
    const failures: string[] = [];
    settled.forEach((r, i) => {
      if (r.status !== "fulfilled" || r.value == null) failures.push(`writer ${i}: ${describeOutcome(r)}`);
    });
    expect(failures, `same-pair writers failed:\n${failures.join("\n")}`).toEqual([]);

    // Correct final state: no blocking cycle anywhere in the company graph.
    const edges = await readEdges(companyId);
    const cycle = findCycle(edges);
    expect(cycle, `blocking cycle persisted: ${JSON.stringify(cycle)}`).toBeNull();

    // No torn/interleaved relation row: the final blockedBy set of the
    // contended target equals EXACTLY one writer's complete written set.
    const finalBlockedBy = await readBlockedBy(companyId, T);
    expect(
      writerSets.map((set) => [...set].sort()),
      `final blockedBy ${JSON.stringify(finalBlockedBy)} is not exactly one writer's complete set (torn row?)`,
    ).toContainEqual(finalBlockedBy);
    // ...and nothing else was written into the company graph.
    expect(edges, "unexpected extra blocking edges alongside the contended pair").toHaveLength(finalBlockedBy.length);
  }, 60_000);
});
