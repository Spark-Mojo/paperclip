import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agents, companies, createDb, issueComments, issues } from "@paperclipai/db";
import { issueService } from "../services/issues.ts";
import { readCommentIdempotencyKey } from "../routes/issues.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// SPA-9687. These assertions drive the PRODUCTION service
// (issueService(db).addComment) and the PRODUCTION route key reader. An earlier
// draft of this file reimplemented the replay lookup in a local helper, and a
// control run proved it: deleting the service change left the test green, because
// the assertions never touched the code they claimed to cover. Keep every
// assertion bound to real production entry points.
//
// What is under test: an agent retrying a comment after an ambiguous failure
// (reset, proxy 502, read timeout landing after the server committed) must not
// insert a second comment. The engine enforces that with a partial unique index
// plus ON CONFLICT DO NOTHING, not a read-then-write, because two concurrent
// identical retries both miss a pre-SELECT and both reach the insert.
//
// Negative controls (each must be able to FAIL, and is proven failing below by
// running it against a deliberately broken build):
//   SPA9687_NEGATIVE=replay-key-mismatch  same key, DIFFERENT body -> rejected,
//                                         nothing extra stored.
//   SPA9687_NEGATIVE=distinct-keys        two different keys -> two rows; a global
//                                         dedupe is the bug this guards.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const negativeMode = process.env.SPA9687_NEGATIVE ?? "";
const isMismatchControl = negativeMode === "replay-key-mismatch";
const isDistinctKeysControl = negativeMode === "distinct-keys";

if (negativeMode && !isMismatchControl && !isDistinctKeysControl) {
  throw new Error(
    `SPA9687_NEGATIVE must be replay-key-mismatch or distinct-keys, got ${negativeMode}`,
  );
}

describe("readCommentIdempotencyKey (SPA-9687)", () => {
  it("keeps a caller-supplied key for every actor, not just board users", () => {
    // The pre-fix route read `actor.actorType === "user" ? ... : undefined`, which
    // is what stripped the key from agents. This is the pure function that now
    // decides, and it is actor-blind by construction.
    const key = randomUUID();
    expect(readCommentIdempotencyKey({ clientRequestId: key })).toBe(key);
  });

  it("treats a blank, whitespace, or non-string key as absent", () => {
    expect(readCommentIdempotencyKey({ clientRequestId: "" })).toBeUndefined();
    expect(readCommentIdempotencyKey({ clientRequestId: "   " })).toBeUndefined();
    expect(readCommentIdempotencyKey({ clientRequestId: 42 })).toBeUndefined();
    expect(readCommentIdempotencyKey({})).toBeUndefined();
    expect(readCommentIdempotencyKey(null)).toBeUndefined();
    expect(readCommentIdempotencyKey(undefined)).toBeUndefined();
  });
});

describeEmbeddedPostgres("agent comment idempotency (SPA-9687)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let agentId!: string;
  let issueId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-comment-idempotency-");
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
      .values({
        name: `Idem ${randomUUID()}`,
        issuePrefix: `IDM${randomUUID().slice(0, 4).toUpperCase()}`,
      })
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
        title: "Idempotency fixture",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agent!.id,
      })
      .returning();
    agentId = agent!.id;
    issueId = issue!.id;
  });

  /** The production write path, exactly as the comments route calls it. */
  function postAgentComment(body: string, clientRequestId?: string) {
    return svc.addComment(
      issueId,
      body,
      { agentId },
      { authorType: "agent", clientRequestId },
    );
  }

  async function storedCount() {
    const rows = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    return rows.length;
  }

  if (isMismatchControl) {
    it("rejects the same key with a different body and stores no second row", async () => {
      const key = randomUUID();
      await postAgentComment("original body", key);

      let rejected: { status?: number; message: string } | null = null;
      try {
        await postAgentComment("DIFFERENT body", key);
      } catch (err) {
        rejected = err as { status?: number; message: string };
      }

      console.log(
        `NEGATIVE replay-key-mismatch: rejected=${rejected?.status} message=${rejected?.message} rows=${await storedCount()}`,
      );
      expect(rejected).not.toBeNull();
      expect(rejected!.status).toBe(409);
      expect(await storedCount()).toBe(1);
      console.log("NEGATIVE-OK replay-key-mismatch rejected the differing body; rows=1");
    });
    return;
  }

  if (isDistinctKeysControl) {
    it("keeps two different keys as two distinct comments", async () => {
      const first = await postAgentComment("body under key A", randomUUID());
      const second = await postAgentComment("body under key B", randomUUID());

      console.log(
        `NEGATIVE distinct-keys: first=${first.id} second=${second.id} rows=${await storedCount()}`,
      );
      expect(first.id).not.toBe(second.id);
      // The assertion a global dedupe fails: it would return the same row twice
      // and leave the count at 1.
      expect(await storedCount()).toBe(2);
      console.log("NEGATIVE-OK distinct-keys stored both rows");
    });
    return;
  }

  it("G1: an agent retry under the same key returns the committed comment, stored once", async () => {
    const key = randomUUID();
    const body = "Closing comment body that a retry would duplicate.";

    const first = await postAgentComment(body, key);
    const replay = await postAgentComment(body, key);

    expect(replay.id).toBe(first.id);
    expect(await storedCount()).toBe(1);
    const [row] = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.id, first.id));
    expect(row!.body).toBe(body);
    expect(row!.clientRequestId).toBe(key);
    expect(row!.createdByRunId).toBeNull();
    console.log(`G1-OK replay returned the first comment ${first.id}; stored rows=1`);
  });

  it("G1b: concurrent identical retries both resolve, and exactly one row exists", async () => {
    const key = randomUUID();
    const body = "Concurrent retry body that both racers will attempt.";

    // Both racers reach the insert; the DB index is what makes this safe. A
    // pre-SELECT implementation would insert twice here.
    const results = await Promise.allSettled([
      postAgentComment(body, key),
      postAgentComment(body, key),
    ]);
    const rejected = results
      .filter((r) => r.status === "rejected")
      .map((r) => String((r as PromiseRejectedResult).reason));

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const ids = new Set(
      fulfilled.map(
        (r) => (r as PromiseFulfilledResult<{ id: string }>).value.id,
      ),
    );

    console.log(
      `G1b concurrent: fulfilled=${fulfilled.length} rejected=${rejected.length} distinctIds=${ids.size} rows=${await storedCount()}`,
    );
    // The invariant that matters: one row, no matter how the race interleaves.
    expect(await storedCount()).toBe(1);
    // And the loser must not have surfaced an error to the caller — a 23505
    // escaping here would be the phantom 500 this ticket is about.
    expect(rejected).toEqual([]);
    expect(fulfilled.length).toBe(2);
    expect(ids.size).toBe(1);
    console.log("G1b-OK both racers resolved to the same comment; no caller-visible error");
  });

  it("G2: writes normally when no idempotency key is supplied (no regression)", async () => {
    const first = await postAgentComment("no key, first write");
    const second = await postAgentComment("no key, second write");

    expect(first.id).not.toBe(second.id);
    expect(await storedCount()).toBe(2);
    const rows = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(rows.every((r) => r.clientRequestId === null)).toBe(true);
    console.log("G2-OK keyless writes stored two distinct rows");
  });
});
