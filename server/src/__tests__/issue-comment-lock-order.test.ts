/**
 * SPA-9396 — binding-row lock order on the comment-removal writers.
 *
 * The premerge approval transaction takes locks in the order
 * `issues` -> `issue_work_products` -> `issue_comments`. `removeComment` and
 * `tombstoneComment` mutate an `issue_comments` row and then touch `issues`,
 * which is the reverse: an approval holding the issue row while waiting for a
 * comment row, and a tombstone holding that comment row while waiting for the
 * issue row, is a 40P01 deadlock. Both writers must take the parent issue row
 * first, which is the order `addComment` already uses.
 *
 * The oracle measures ACQUISITION order, not merely that the writer eventually
 * blocks. Connection A holds only the issue row (the approval's first lock).
 * Connection B runs the writer. Connection C then tries to take the comment row
 * lock: it succeeds only if B is still waiting on the issue row holding nothing,
 * and blocks only if B already took the comment row and is now waiting on the
 * issue row — the inversion itself. The positive control holds the comment row
 * outright, so the probe is proven able to detect a held lock.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const WAIT_MS = 750;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describeEmbeddedPostgres("comment removal lock order", () => {
  let db!: ReturnType<typeof createDb>;
  let probeDb!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-9396-comment-order-");
    db = createDb(tempDb.connectionString);
    probeDb = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCard() {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Order Co ${randomUUID().slice(0, 6)}`,
      issuePrefix: `O${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "lock order",
      status: "in_review",
    });
    const commentId = randomUUID();
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorUserId: "board-user-1",
      body: "binding prose",
    });
    return { companyId, issueId, commentId };
  }

  /**
   * Whether a third connection can take the comment row lock inside WAIT_MS.
   * The returned promise settles once the claim completes, so the caller must
   * release whatever holds the lock before awaiting it.
   */
  async function commentRowLockIsHeld(commentId: string) {
    let settled = false;
    const done = probeDb
      .transaction(async (tx) => {
        await tx
          .select({ id: issueComments.id })
          .from(issueComments)
          .where(eq(issueComments.id, commentId))
          .for("update");
      })
      .catch(() => undefined)
      .then(() => {
        settled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
    return { held: !settled, done };
  }

  it("tombstoneComment does not hold the comment row while waiting for the issue row", async () => {
    const { issueId, commentId } = await seedCard();
    const locked = deferred<void>();
    const release = deferred<void>();

    const holder = db.transaction(async (tx) => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, issueId)).for("update");
      locked.resolve();
      await release.promise;
    });
    await locked.promise;

    let settled = false;
    let rejection: unknown = null;
    const tombstone = issueService(db)
      .tombstoneComment(commentId, { actorType: "user", userId: "board-user-1" })
      .then(
        () => {
          settled = true;
        },
        (error: unknown) => {
          settled = true;
          rejection = error;
        },
      );
    await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
    expect(settled).toBe(false);
    expect(rejection).toBeNull();

    const { held, done } = await commentRowLockIsHeld(commentId);

    release.resolve();
    await holder;
    await tombstone;
    await done;

    expect(held).toBe(false);
    const tombstoned = await db
      .select({ deletedAt: issueComments.deletedAt })
      .from(issueComments)
      .where(eq(issueComments.id, commentId));
    expect(tombstoned[0]!.deletedAt).not.toBeNull();
  }, 60_000);

  it("removeComment does not hold the comment row while waiting for the issue row", async () => {
    const { issueId, commentId } = await seedCard();
    const locked = deferred<void>();
    const release = deferred<void>();

    const holder = db.transaction(async (tx) => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, issueId)).for("update");
      locked.resolve();
      await release.promise;
    });
    await locked.promise;

    let settled = false;
    let rejection: unknown = null;
    const removal = issueService(db)
      .removeComment(commentId)
      .then(
        () => {
          settled = true;
        },
        (error: unknown) => {
          settled = true;
          rejection = error;
        },
      );
    await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
    expect(settled).toBe(false);

    const { held, done } = await commentRowLockIsHeld(commentId);

    release.resolve();
    await holder;
    await removal;
    await done;

    expect(held).toBe(false);
    expect(await issueService(db).getComment(commentId)).toBeNull();
  }, 60_000);

  it("positive control: the probe detects a comment-row lock that IS held", async () => {
    const { commentId } = await seedCard();
    const locked = deferred<void>();
    const release = deferred<void>();
    const holder = db.transaction(async (tx) => {
      await tx
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(eq(issueComments.id, commentId))
        .for("update");
      locked.resolve();
      await release.promise;
    });
    await locked.promise;

    const { held, done } = await commentRowLockIsHeld(commentId);

    release.resolve();
    await holder;
    await done;
    expect(held).toBe(true);
  }, 60_000);
});
