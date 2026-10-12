import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  closeRegisteredClients,
  companyMemberships,
  companies,
  createDb,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { buildOpenApiSpec } from "../routes/openapi.js";
import { issueRoutes } from "../routes/issues.js";
import { issueService } from "../services/issues.js";
import type { StorageService } from "../storage/types.js";

/**
 * GH #982 half D2 (SPA-11815): `GET /api/issues/{id}/comments` returns
 * soft-deleted comment tombstones in its DEFAULT read, but the documented
 * response schema never mentioned `deletedAt`. A caller reading only the
 * published schema therefore could not tell a tombstone (body "") from a
 * comment whose author genuinely wrote an empty body.
 *
 * These tests pin both halves of the contract:
 *   - the published schema surfaces `deletedAt` and states the tombstone
 *     contract, and
 *   - the default read really does return the tombstone with `deletedAt`
 *     populated and `body` blank, so the discriminator works end to end.
 *
 * Nothing here touches the live board: every fixture lives in a disposable
 * embedded Postgres database seeded per test.
 */

const externalTestDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
const embeddedPostgresSupport = externalTestDatabaseUrl
  ? { supported: true }
  : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe.sequential
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue comments tombstone tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/** What a caller is told to look at to classify a returned comment row. */
const isTombstone = (comment: { deletedAt?: string | null }) =>
  comment.deletedAt !== null && comment.deletedAt !== undefined;

function commentsReadSchema() {
  const spec = buildOpenApiSpec() as unknown as {
    paths: Record<
      string,
      {
        get: {
          responses: Record<
            string,
            { description?: string; content?: Record<string, any> }
          >;
        };
      }
    >;
  };
  const operation = spec.paths["/api/issues/{id}/comments"]?.get;
  if (!operation) throw new Error("GET /api/issues/{id}/comments is not documented");
  return operation.responses["200"];
}

describe("issue comments read contract", () => {
  it("surfaces deletedAt on the comments read schema", () => {
    const ok = commentsReadSchema();
    const schema = ok.content?.["application/json"]?.schema;
    expect(schema?.type, "the read must publish an array schema").toBe("array");

    const comment = schema.items;
    expect(comment?.type).toBe("object");
    // The tombstone marker. Nullable: a live comment reports null here.
    expect(comment?.properties?.deletedAt).toEqual({
      type: "string",
      nullable: true,
    });
    // The blanked body a tombstone carries, and the who/when of the deletion.
    expect(comment?.properties?.body?.type).toBe("string");
    expect(comment?.properties?.deletedByType).toEqual({
      type: "string",
      enum: ["agent", "user"],
      nullable: true,
    });
    for (const field of [
      "deletedByAgentId",
      "deletedByUserId",
      "deletedByRunId",
    ]) {
      expect(comment?.properties?.[field], `${field} must be documented`).toEqual(
        { type: "string", nullable: true },
      );
    }
    // The JSON columns are structured, not free-form: publishing them as an
    // open record would relocate the very defect this card fixes.
    expect(comment?.properties?.presentation?.type).toBe("object");
    expect(
      comment?.properties?.presentation?.properties?.kind?.enum,
      "presentation.kind must publish its real vocabulary",
    ).toEqual(["message", "system_notice"]);
    expect(comment?.properties?.metadata?.properties?.version).toEqual({
      type: "number",
      enum: [1],
    });
    expect(
      comment?.properties?.sourceTrust?.properties?.disposition?.enum,
      "sourceTrust.disposition must publish its real vocabulary",
    ).toEqual(["quarantined", "promoted"]);
    expect(comment?.properties?.authorType?.enum).toEqual([
      "user",
      "agent",
      "system",
    ]);
    expect(comment?.properties?.derivedAuthorSource?.enum).toEqual([
      "run_id",
      "run_log_comment_post",
    ]);
    // The schema is deliberately non-strict (see the comment on it in
    // openapi.ts). Pin that decision: a published `additionalProperties: false`
    // would be a contract the server does not enforce.
    expect(comment?.additionalProperties).toBeUndefined();
  });

  it("documents the tombstone contract on the default comments read", () => {
    const ok = commentsReadSchema();
    const description = ok.description ?? "";
    // Every clause a caller needs to use the marker correctly.
    expect(description).toMatch(/soft-deleted/i);
    expect(description).toMatch(/included by default/i);
    expect(description).toMatch(/deletedAt/);
    expect(description).toMatch(/body/i);
    expect(description).toMatch(/empty/i);
    // Pin the negations that carry the contract. Without these the assertions
    // above would still pass on prose saying tombstones are EXCLUDED.
    expect(description).not.toMatch(/excluded/i);
    expect(description).not.toMatch(/not included/i);
    expect(description).not.toMatch(/omitted/i);
    expect(description).toMatch(/applies no filter/i);
    expect(description).toMatch(/null on a live comment/i);
  });
});

describeEmbeddedPostgres("issue comments tombstone read", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;

  beforeAll(async () => {
    if (externalTestDatabaseUrl) {
      db = createDb(externalTestDatabaseUrl);
    } else {
      tempDb = await startEmbeddedPostgresTestDatabase(
        "paperclip-comments-tombstone-",
      );
      db = createDb(tempDb.connectionString);
    }
    await db.execute(sql.raw("CREATE EXTENSION IF NOT EXISTS pg_trgm"));
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    if (externalTestDatabaseUrl) {
      await closeRegisteredClients(externalTestDatabaseUrl);
    }
    await tempDb?.cleanup();
  });

  const BOARD_USER_ID = "board-user-tombstone";

  async function seedIssue() {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Comments Tombstone Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "TOM-1",
      title: "Comment tombstone read",
      status: "todo",
      priority: "medium",
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: BOARD_USER_ID,
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    return { companyId, issueId };
  }

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: BOARD_USER_ID,
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        isInstanceAdmin: false,
      };
      next();
    });
    const storage: StorageService = {
      provider: "local_disk",
      putFile: vi.fn(async () => {
        throw new Error("Unexpected storage.putFile call");
      }),
      getObject: vi.fn(async () => {
        throw new Error("Unexpected storage.getObject call");
      }),
      headObject: vi.fn(async () => ({ exists: false })),
      deleteObject: vi.fn(async () => undefined),
    };
    app.use("/api", issueRoutes(db, storage));
    app.use(errorHandler);
    return app;
  }

  async function seedComment(
    companyId: string,
    issueId: string,
    body: string,
  ) {
    const id = randomUUID();
    await db.insert(issueComments).values({
      id,
      companyId,
      issueId,
      authorUserId: BOARD_USER_ID,
      body,
    });
    return id;
  }

  it("returns a soft-deleted comment as a tombstone a caller can tell from an empty comment", async () => {
    const { companyId, issueId } = await seedIssue();
    const liveId = await seedComment(companyId, issueId, "live body");
    // A genuinely empty comment: blank body, never deleted.
    const emptyId = await seedComment(companyId, issueId, "");
    // A real tombstone: written through the production tombstone writer so the
    // read is asserted against the real row shape, not a hand-rolled stand-in.
    const tombstoneId = await seedComment(
      companyId,
      issueId,
      "body that must never survive deletion",
    );
    const tombstoned = await issueService(db).tombstoneComment(
      tombstoneId,
      { actorType: "user", userId: BOARD_USER_ID },
    );
    expect(tombstoned?.deletedAt, "fixture must tombstone the comment").toBeTruthy();

    const response = await request(createApp(companyId)).get(
      `/api/issues/${issueId}/comments`,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const rows = response.body as Array<{
      id: string;
      body: string;
      deletedAt: string | null;
      deletedByType: string | null;
      deletedByUserId: string | null;
    }>;
    expect(rows).toHaveLength(3);

    // Every row carries the marker key, so the discriminator is always usable.
    for (const row of rows) {
      expect(Object.keys(row)).toContain("deletedAt");
    }

    const byId = new Map(rows.map((row) => [row.id, row]));

    // The tombstone: blank body, marker populated.
    const tombstone = byId.get(tombstoneId)!;
    expect(tombstone.body).toBe("");
    expect(tombstone.deletedAt).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(tombstone.deletedAt!))).toBe(false);
    expect(tombstone.deletedByType).toBe("user");
    expect(tombstone.deletedByUserId).toBe(BOARD_USER_ID);
    // The pre-deletion body is gone from the read entirely.
    expect(JSON.stringify(rows)).not.toContain("body that must never survive");

    // The live comments: marker null, whether or not the body is blank.
    expect(byId.get(liveId)).toMatchObject({ body: "live body", deletedAt: null });
    expect(byId.get(emptyId)).toMatchObject({ body: "", deletedAt: null });

    // The published discriminator separates exactly the tombstone from the
    // author-written empty comment -- the distinction AC #3 requires.
    expect(rows.filter(isTombstone).map((row) => row.id).sort()).toEqual([
      tombstoneId,
    ]);
  });

  it("keeps soft-deleted comments in the default read", async () => {
    const { companyId, issueId } = await seedIssue();
    const liveId = await seedComment(companyId, issueId, "still here");
    const tombstoneId = await seedComment(companyId, issueId, "will be blanked");
    await issueService(db).tombstoneComment(tombstoneId, {
      actorType: "user",
      userId: BOARD_USER_ID,
    });

    // No filter parameter is sent: this is the DEFAULT read a caller gets.
    const response = await request(createApp(companyId)).get(
      `/api/issues/${issueId}/comments`,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const rows = response.body as Array<{ id: string; deletedAt: string | null }>;

    // The tombstone is present in the default read by contract. Filtering it
    // out would silently drop a comment the issue thread still shows.
    expect(rows.map((row) => row.id).sort()).toEqual([liveId, tombstoneId].sort());
    expect(rows.filter(isTombstone)).toHaveLength(1);

    // And a caller can still opt into live-only comments client-side, because
    // the marker travels with every row.
    expect(rows.filter((row) => !isTombstone(row))).toHaveLength(1);
  });
});