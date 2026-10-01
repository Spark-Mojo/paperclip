/**
 * SPA-9396 — production lock discipline for the premerge stage-approval paths.
 *
 * The approval reads a card's binding surface (`issue_work_products` plus the
 * live `issue_comments` the canonical pull-request set is derived from), then
 * persists an approval against it. Locking the ISSUE row alone is not that
 * fence: an INSERT of a new binding row is blocked by the issues foreign key,
 * but an UPDATE of an EXISTING binding row (a work product's URL, a comment
 * soft-delete that unbinds a PR) takes no issue-row lock and commits freely
 * under it. This file pins the production helper against a real PostgreSQL
 * instance, with concurrent writers on separate connections.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  issueComments,
  issueWorkProducts,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { lockStageApprovalBindingRows } from "../services/issue-stage-approvals.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const WAIT_MS = 1500;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("stage approval binding locks — lock contract", () => {
  it("locks work products before comments, each ordered by id", async () => {
    const calls: string[] = [];
    const tableName = (table: unknown) =>
      (table as Record<symbol, string>)[Symbol.for("drizzle:Name")];
    const handle = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            orderBy: () => ({
              for: (lock: string) => {
                calls.push(`${tableName(table)}:${lock}`);
                return { then: (on: (rows: unknown[]) => unknown) => on([]) };
              },
            }),
          }),
        }),
      }),
    };

    await lockStageApprovalBindingRows(handle as never, {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
    });

    expect(calls).toEqual([
      "issue_work_products:update",
      "issue_comments:update",
    ]);
  });
});

describeEmbeddedPostgres("stage approval binding locks — concurrent writers", () => {
  it("blocks every binding writer class while the approval transaction holds them", async () => {
    const tempDb = await startEmbeddedPostgresTestDatabase("paperclip-9396-binding-");
    const db = createDb(tempDb.connectionString);
    const other = createDb(tempDb.connectionString);

    const company = await db
      .insert(companies)
      .values({ name: `P ${randomUUID()}`, issuePrefix: `P${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: `owner-${randomUUID()}`,
      status: "active",
      membershipRole: "owner",
    });
    await db.insert(agents).values({ companyId: company.id, name: `a-${randomUUID().slice(0, 8)}`, role: "engineer" });
    const card = await db
      .insert(issues)
      .values({ companyId: company.id, title: "approval", status: "in_review" })
      .returning()
      .then((rows) => rows[0]!);

    const workProduct = await db
      .insert(issueWorkProducts)
      .values({
        companyId: company.id,
        issueId: card.id,
        type: "pull_request",
        provider: "github",
        title: "PR 1",
        url: "https://github.com/Spark-Mojo/paperclip/pull/1",
        status: "open",
      })
      .returning()
      .then((rows) => rows[0]!);
    const comment = await db
      .insert(issueComments)
      .values({
        companyId: company.id,
        issueId: card.id,
        body: "see https://github.com/Spark-Mojo/paperclip/pull/2",
      })
      .returning()
      .then((rows) => rows[0]!);

    async function probe(
      lock: (tx: never) => Promise<unknown>,
      write: () => Promise<unknown>,
    ) {
      const locked = deferred<void>();
      const release = deferred<void>();
      let settled = false;
      let error: unknown = null;

      const holder = db.transaction(async (tx) => {
        await lock(tx as never);
        locked.resolve();
        await release.promise;
      });

      await locked.promise;
      const concurrent = write().then(
        () => {
          settled = true;
        },
        (reason) => {
          error = reason;
          settled = true;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
      const blockedWhileHeld = !settled;
      release.resolve();
      await holder;
      await concurrent;
      if (error) throw error;
      return blockedWhileHeld;
    }

    const lockIssueRow = (tx: never) =>
      tx
        .select()
        .from(issues)
        .where(eq(issues.id, card.id))
        .for("update");
    const lockBindingRows = (tx: never) =>
      lockStageApprovalBindingRows(tx, { id: card.id, companyId: company.id });

    const insertWorkProduct = () =>
      other.insert(issueWorkProducts).values({
        companyId: company.id,
        issueId: card.id,
        type: "pull_request",
        provider: "github",
        title: "PR 3",
        url: "https://github.com/Spark-Mojo/paperclip/pull/3",
        status: "open",
      });
    const insertComment = () =>
      other.insert(issueComments).values({
        companyId: company.id,
        issueId: card.id,
        body: "https://github.com/Spark-Mojo/paperclip/pull/4",
      });
    const updateWorkProductUrl = () =>
      other
        .update(issueWorkProducts)
        .set({ url: "https://github.com/Spark-Mojo/paperclip/pull/19" })
        .where(eq(issueWorkProducts.id, workProduct.id));
    const softDeleteComment = () =>
      other
        .update(issueComments)
        .set({ deletedAt: new Date() })
        .where(eq(issueComments.id, comment.id));

    try {
      const lockBoth = async (tx: never) => {
        await lockIssueRow(tx);
        await lockBindingRows(tx);
      };
      const writers = [insertWorkProduct, insertComment, updateWorkProductUrl, softDeleteComment];
      for (const write of writers) {
        expect(await probe(lockBoth, write)).toBe(true);
      }
      // The negative control for the whole guard: the issue row alone is NOT
      // the fence. Without the binding locks an unbind lands under it.
      expect(await probe(lockIssueRow, updateWorkProductUrl)).toBe(false);
      expect(await probe(lockIssueRow, softDeleteComment)).toBe(false);
      expect(await probe(lockIssueRow, insertWorkProduct)).toBe(true);
    } finally {
      await tempDb.cleanup();
    }
  }, 180_000);
});
