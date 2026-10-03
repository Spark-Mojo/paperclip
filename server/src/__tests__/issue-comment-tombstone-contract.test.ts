import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agents, companies, createDb, issueComments, issues } from "@paperclipai/db";
import { issueService } from "../services/issues.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// SPA-9687. sparkmojo-internal#982 reported that DELETE on a comment "returns 2xx
// but GET still shows the row with an empty body", read as ghost comments. The
// read path does return soft-deleted comments, but as EXPLICIT tombstones:
// deletedAt plus the deletedBy* provenance fields, with body "" by design. That
// contract is the thing an agent needs in order to count live comments, and this
// test is what stops a future refactor from silently dropping the signal.
//
// Negative control: SPA9687_NEGATIVE=drop-tombstone-signal runs the same
// assertions against a projection that omits deletedAt, and MUST fail.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const dropTombstoneSignal = process.env.SPA9687_NEGATIVE === "drop-tombstone-signal";
if (process.env.SPA9687_NEGATIVE && !dropTombstoneSignal) {
  throw new Error(`SPA9687_NEGATIVE must be drop-tombstone-signal, got ${process.env.SPA9687_NEGATIVE}`);
}

const TOMBSTONE_FIELDS = [
  "deletedAt",
  "deletedByType",
  "deletedByAgentId",
  "deletedByUserId",
  "deletedByRunId",
  "updatedAt",
] as const;

/** The shape the comments GET route actually serializes. Under the negative
 *  control it drops the tombstone signal, modelling the regression this guards. */
function projectForRead(row: Record<string, unknown>) {
  if (!dropTombstoneSignal) return { ...row };
  const projected = { ...row };
  for (const field of TOMBSTONE_FIELDS) delete projected[field];
  return projected;
}

describeEmbeddedPostgres("issue comment tombstone read contract (SPA-9687)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;
  let issueId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-comment-tombstone-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    const [company] = await db
      .insert(companies)
      .values({ name: `Tomb ${randomUUID()}`, issuePrefix: `TOM${randomUUID().slice(0, 4).toUpperCase()}` })
      .returning();
    const [agent] = await db
      .insert(agents)
      .values({
        companyId: company!.id,
        name: `Agent ${randomUUID()}`,
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })
      .returning();
    const [issue] = await db
      .insert(issues)
      .values({
        companyId: company!.id,
        title: "Tombstone fixture",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agent!.id,
      })
      .returning();
    companyId = company!.id;
    agentId = agent!.id;
    issueId = issue!.id;
  });

  it("G3: a soft-deleted comment reads back as an explicit tombstone, a live one does not", async () => {
    const live = await svc.addComment(issueId, "live comment body", { agentId });
    const doomed = await svc.addComment(issueId, "comment that gets deleted", { agentId });
    const tombstoned = await svc.tombstoneComment(doomed.id, {
      actorType: "agent",
      agentId,
      runId: null,
    });
    expect(tombstoned).not.toBeNull();

    const rows = await svc.listComments(issueId, { order: "asc" });
    const projected = rows.map((row) => projectForRead(row as unknown as Record<string, unknown>));

    const projectedLive = projected.find((row) => row.id === live.id);
    const projectedTomb = projected.find((row) => row.id === doomed.id);

    // The tombstone must carry its own signal, not be distinguishable only by
    // an empty body — that is precisely what made #982 look like ghost rows.
    for (const field of TOMBSTONE_FIELDS) {
      expect(projectedTomb, `tombstone row is missing ${field}`).toHaveProperty(field);
    }
    expect(projectedTomb!.deletedAt).not.toBeNull();
    expect(projectedTomb!.deletedByType).toBe("agent");
    expect(projectedTomb!.deletedByAgentId).toBe(agentId);
    expect(projectedTomb!.body).toBe("");

    // The live row must be distinguishable from a tombstone.
    expect(projectedLive!.deletedAt).toBeNull();
    expect(projectedLive!.body).toBe("live comment body");

    // And counting live comments must be a filter, not a guess.
    const liveCount = projected.filter((row) => !row.deletedAt).length;
    const tombstoneCount = projected.filter((row) => row.deletedAt).length;
    console.log(
      `G3-OK live=${liveCount} tombstones=${tombstoneCount} tombstoneFields=${TOMBSTONE_FIELDS.join(",")}`,
    );
    expect(liveCount).toBe(1);
    expect(tombstoneCount).toBe(1);
  });

  it("G3b: DELETE reports success and the row is still readable as a tombstone (not gone)", async () => {
    const comment = await svc.addComment(issueId, "to be tombstoned", { agentId });
    const tombstoned = await svc.tombstoneComment(comment.id, {
      actorType: "agent",
      agentId,
      runId: null,
    });
    expect(tombstoned!.deletedAt).toBeInstanceOf(Date);

    // A second delete of the same row is a no-op that returns null: the row is
    // already tombstoned, so the guard `deletedAt IS NULL` matches nothing.
    const again = await svc.tombstoneComment(comment.id, {
      actorType: "agent",
      agentId,
      runId: null,
    });
    expect(again).toBeNull();

    const [row] = await db.select().from(issueComments).where(eq(issueComments.id, comment.id));
    expect(row).toBeDefined();
    expect(row!.deletedAt).not.toBeNull();
    expect(row!.body).toBe("");
    console.log("G3b-OK re-delete is a no-op; row retained with a tombstone marker");
  });
});
