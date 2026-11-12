/**
 * HTTP contract test (SPA-16971 R3): a direct blocking-cycle attempt through
 * PATCH /api/issues/:id is rejected by the cycle guard as an HTTP 422 whose
 * body is EXACTLY `{ error: "Blocking relations cannot contain cycles" }`.
 *
 * Sequence under test:
 *   1. PATCH A { blockedByIssueIds: [B] }  -> 2xx, edge B-blocks-A persisted.
 *   2. PATCH B { blockedByIssueIds: [A] }  -> 422, exact body shape (no extra
 *      keys such as `code`/`details`), verbatim message.
 *   3. Post-state: the rejected direction (A-blocks-B) was NOT written, the
 *      accepted edge survived, relation count unchanged.
 *   4. Control: a legal non-cycle write (C blockedBy A) after the rejection
 *      still succeeds -> proves the 422 came from the cycle guard, not a
 *      broken route.
 *
 * Real HTTP end-to-end via supertest against the production errorHandler so
 * the 422 BODY SHAPE is asserted through the actual response path, not by
 * catching a service-thrown HttpError.
 */
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const CYCLE_MESSAGE = "Blocking relations cannot contain cycles";

type Db = ReturnType<typeof createDb>;

type Edge = { blocker: string; blocked: string };

describeEmbeddedPostgres("PATCH /api/issues/:id direct blocking-cycle 422 contract", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: Db;
  let testApp: express.Express;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-relation-cycle-422-");
    db = createDb(tempDb.connectionString, { maxConnections: 4 });
    testApp = express();
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
    testApp.use("/api", issueRoutes(db, {} as never));
    testApp.use(errorHandler);
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  /** Seeds one company with three issues A, B, C (mirrors the route-test exemplar). */
  async function seedTrio() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Cycle422Co",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 7).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Cycle 422 contract agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const [A, B, C] = [randomUUID(), randomUUID(), randomUUID()];
    await db.insert(issues).values(
      [A, B, C].map((id, i) => ({
        id,
        companyId,
        title: `cycle-422-${"ABC"[i]}`,
        status: "todo",
        priority: "medium",
      })),
    );
    return { companyId, A, B, C };
  }

  async function readEdges(companyId: string): Promise<Edge[]> {
    const rows = await db
      .select({ blocker: issueRelations.issueId, blocked: issueRelations.relatedIssueId, type: issueRelations.type })
      .from(issueRelations)
      .where(eq(issueRelations.companyId, companyId));
    return rows
      .filter((row) => row.type === "blocks")
      .map(({ blocker, blocked }) => ({ blocker, blocked }));
  }

  /** Deterministic order for MULTI-row edge comparisons: readEdges has no
   *  ORDER BY, so Postgres heap order is not stable across runs. */
  const edgeCmp = (a: Edge, b: Edge): number =>
    a.blocker < b.blocker ? -1 : a.blocker > b.blocker ? 1 : a.blocked < b.blocked ? -1 : a.blocked > b.blocked ? 1 : 0;
  const sortEdges = (edges: Edge[]): Edge[] => [...edges].sort(edgeCmp);

  const patchBlockedBy = (id: string, blockedByIssueIds: string[]) =>
    request(testApp).patch(`/api/issues/${id}`).send({ blockedByIssueIds });

  it("accepts the legal edge (A blockedBy B), then rejects B blockedBy A with 422 and the exact body shape, writing nothing", async () => {
    const { companyId, A, B } = await seedTrio();

    // 1. Legal edge first: A blockedBy B -> B blocks A.
    const legal = await patchBlockedBy(A, [B]);
    expect(legal.status, `PATCH A blockedBy B failed: ${JSON.stringify(legal.body)}`).toBeLessThan(300);
    expect(await readEdges(companyId)).toEqual([{ blocker: B, blocked: A }]);
    const countBeforeRejectedWrite = (await readEdges(companyId)).length;

    // 2. Direct cycle attempt: B blockedBy A -> must be 422 with EXACTLY
    //    `{ error: <message> }`; any extra key (code/details/…) fails this.
    const rejected = await patchBlockedBy(B, [A]);
    expect(rejected.status).toBe(422);
    expect(rejected.body).toEqual({ error: CYCLE_MESSAGE });
    expect(rejected.body.error, "cycle message must be verbatim").toBe(
      "Blocking relations cannot contain cycles",
    );

    // 3. Post-state: no A-blocks-B row, B-blocks-A intact, count unchanged.
    const edges = await readEdges(companyId);
    expect(edges).toEqual([{ blocker: B, blocked: A }]);
    expect(edges.length).toBe(countBeforeRejectedWrite);
    expect(edges.some((e) => e.blocker === A && e.blocked === B)).toBe(false);
  }, 60_000);

  it("control: a legal non-cycle write (C blockedBy A) still succeeds after the cycle guard rejected B blockedBy A", async () => {
    const { companyId, A, B, C } = await seedTrio();

    const legalFirst = await patchBlockedBy(A, [B]);
    expect(legalFirst.status, `PATCH A blockedBy B failed: ${JSON.stringify(legalFirst.body)}`).toBeLessThan(300);
    const rejected = await patchBlockedBy(B, [A]);
    expect(rejected.status, "precondition: the direct cycle must be rejected here").toBe(422);

    // The rejection must have been the cycle guard, not a broken route:
    // a non-cyclic write on the same company still commits.
    const legalAfter = await patchBlockedBy(C, [A]);
    expect(legalAfter.status, `PATCH C blockedBy A failed: ${JSON.stringify(legalAfter.body)}`).toBeLessThan(300);
    expect(sortEdges(await readEdges(companyId))).toEqual(
      sortEdges([
        { blocker: B, blocked: A },
        { blocker: A, blocked: C },
      ]),
    );
  }, 60_000);
});
