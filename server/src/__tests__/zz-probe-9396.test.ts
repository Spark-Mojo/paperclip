import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { eq, sql } from "drizzle-orm";
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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const lines: string[] = [];
const note = (line: string) => {
  lines.push(line);
  fs.writeFileSync("/tmp/probe-9396.txt", lines.join("\n") + "\n");
};

const WAIT_MS = 1500;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describeEmbeddedPostgres("PROBE 9396 writer-lock discipline v2", () => {
  it("probes each binding-write class against each candidate lock", async () => {
    const tempDb = await startEmbeddedPostgresTestDatabase("paperclip-9396-probe2-");
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
    await db
      .insert(agents)
      .values({ companyId: company.id, name: `a-${randomUUID().slice(0, 8)}`, role: "engineer" });
    const card = await db
      .insert(issues)
      .values({ companyId: company.id, title: "probe", status: "in_review" })
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

    const fk = await db.execute(sql`
      SELECT conname, condeferrable
      FROM pg_constraint
      WHERE conname IN (
        'issue_work_products_issue_id_issues_id_fk',
        'issue_comments_issue_id_issues_id_fk'
      )
    `);
    note(`fk: ${JSON.stringify(fk)}`);

    /**
     * Hold `lock` in tx1, THEN issue the concurrent write from `other`, and
     * report whether it completed before the lock was released. The write is
     * only issued after the barrier, so there is no acquisition race.
     */
    async function probe(label: string, lock: (tx: any) => Promise<unknown>, write: () => Promise<unknown>) {
      const locked = deferred<void>();
      const release = deferred<void>();
      let settled = false;
      let error: unknown = null;

      const holder = db.transaction(async (tx) => {
        await lock(tx);
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
      note(
        `${label}: blockedWhileLockHeld=${blockedWhileHeld} errorWhileBlocked=${error ? String(error).slice(0, 80) : "none"}`,
      );
      return blockedWhileHeld;
    }

    const lockIssueRow = (tx: any) =>
      tx.select().from(issues).where(eq(issues.id, card.id)).for("update");
    const lockBindingRows = async (tx: any) => {
      await tx.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, card.id)).for("update");
      await tx.select().from(issueComments).where(eq(issueComments.issueId, card.id)).for("update");
    };

    const insertWorkProduct = () =>
      other
        .insert(issueWorkProducts)
        .values({
          companyId: company.id,
          issueId: card.id,
          type: "pull_request",
          provider: "github",
          title: "PR 3",
          url: "https://github.com/Spark-Mojo/paperclip/pull/3",
          status: "open",
        });
    const updateWorkProductUrl = () =>
      other
        .update(issueWorkProducts)
        .set({ url: `https://github.com/Spark-Mojo/paperclip/pull/9${Math.floor(Math.random() * 9)}` })
        .where(eq(issueWorkProducts.id, workProduct.id));
    const softDeleteComment = () =>
      other.update(issueComments).set({ deletedAt: new Date() }).where(eq(issueComments.id, comment.id));
    const insertComment = () =>
      other
        .insert(issueComments)
        .values({ companyId: company.id, issueId: card.id, body: "https://github.com/Spark-Mojo/paperclip/pull/4" });

    note("--- lock: issues FOR UPDATE ---");
    await probe("insert work product", lockIssueRow, insertWorkProduct);
    await probe("insert comment", lockIssueRow, insertComment);
    await probe("update work product url", lockIssueRow, updateWorkProductUrl);
    await probe("soft-delete comment", lockIssueRow, softDeleteComment);

    note("--- lock: binding rows FOR UPDATE ---");
    await probe("insert work product", lockBindingRows, insertWorkProduct);
    await probe("insert comment", lockBindingRows, insertComment);
    await probe("update work product url", lockBindingRows, updateWorkProductUrl);
    await probe("soft-delete comment", lockBindingRows, softDeleteComment);

    note("--- lock: both issues row AND binding rows ---");
    const lockBoth = async (tx: any) => {
      await lockIssueRow(tx);
      await lockBindingRows(tx);
    };
    await probe("insert work product", lockBoth, insertWorkProduct);
    await probe("insert comment", lockBoth, insertComment);
    await probe("update work product url", lockBoth, updateWorkProductUrl);
    await probe("soft-delete comment", lockBoth, softDeleteComment);

    expect(true).toBe(true);
    await tempDb.cleanup();
  }, 180_000);
});
