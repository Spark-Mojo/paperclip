// SPA-10357 / SPA-10429 ownership-transfer CAS — regression suite.
//
// The board-actor silent-write class was: a PATCH that moved an issue away
// from `local-board` and into `backlog` succeeded even though the actor had
// no visible signal of the row's prior state. The CAS invariant makes that
// class unrepresentable on the ownership-transmit fields: a board actor that
// changes assigneeUserId or assigneeAgentId over the HTTP PATCH path must
// supply a caller-observed expected value that the service compares against
// the locked row. Mismatch returns 409 and the row is untouched.
//
// BOUNDARY (SPA-10859): mandatory enforcement covers the OWNERSHIP fields
// only; status CAS is provided but opt-in. Under `deploymentMode:
// local_trusted` the board UI and the offending monitor sweep are the same
// actor class (type=board, source=local_implicit), so a mandatory
// expectedStatus would 409 every human status change in the in-repo board UI
// without separating the sweep. The observed damage — eight DEPLOY-GATE cards
// moved OFF local-board — is ownership departure, which is what is gated.
//
// SCOPE (SPA-10357 §5 wording): the control is on the issue PATCH write
// path — the HTTP board-actor route. Internal service callers (interaction
// accept, connection-intent delivery, execution-workspaces, email-channels,
// native-runtime tests) re-read the locked row themselves and run under the
// issue's own state-machine guards; they do not supply expected* and the
// service-layer CAS helper is a no-op for them.
//
// These tests exercise the real `issueRoutes` against an embedded Postgres
// database, so the validator schema, the route handler, the service's
// `for("update")` lock, and the `conflict()` helper all run for real. To
// keep the focus on the CAS guard, the tests use the narrowest possible
// PATCH shape (status + assigneeUserId only) so downstream guards do not
// fire first.

import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  createDb,
  issueComments,
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

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping SPA-10357 ownership-transfer CAS route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("SPA-10357 / SPA-10429 ownership-transfer CAS", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-spa-10357-ownership-cas-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    // The CAS writes can enqueue agent wakeup requests (same as any board
    // reassignment); they reference the agent row, so clear them first.
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    // The route handler validates the board actor's `memberships` claim
    // against the company_memberships row. Without this seed, every test
    // returns 403 "deny_missing_membership" before the CAS check ever runs.
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "board-user",
      status: "active",
      membershipRole: "admin",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedIssue(opts: {
    companyId: string;
    status: "todo" | "in_progress" | "blocked" | "in_review" | "done" | "cancelled" | "backlog";
    assigneeUserId: string | null;
    assigneeAgentId?: string | null;
    title?: string;
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: opts.companyId,
      title: opts.title ?? "Local-board gate",
      status: opts.status,
      priority: "medium",
      assigneeUserId: opts.assigneeUserId,
      assigneeAgentId: opts.assigneeAgentId ?? null,
    });
    return issueId;
  }

  function boardActor(companyId: string): Express.Request["actor"] {
    return {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }],
      isInstanceAdmin: false,
      source: "session",
    };
  }

  // --- the SPA-10357 named control ----------------------------------------

  it("negative: board PATCH with stale expectedStatus returns 409 with cas-mismatch code; row untouched", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const issueId = await seedIssue({
      companyId,
      status: "todo",
      assigneeUserId: "local-board",
    });

    // Caller claims to have seen (status=in_progress, assigneeUserId=null)
    // but the row is still (status=todo, assigneeUserId=local-board). The
    // CAS guard MUST 409 with code issue_write_ownership_cas_mismatch.
    const res = await request(createApp(boardActor(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "backlog",
        assigneeUserId: null,
        expectedStatus: "in_progress",
        expectedAssigneeUserId: null,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/issue_write_ownership_cas_mismatch/);
    expect(JSON.stringify(res.body)).toMatch(/expectedStatus/);

    const row = await db
      .select({ status: issues.status, assigneeUserId: issues.assigneeUserId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((r) => r[0]);
    expect(row).toEqual({ status: "todo", assigneeUserId: "local-board" });
  });

  it("negative: stale expectedAssigneeUserId returns 409; row untouched", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const issueId = await seedIssue({
      companyId,
      status: "todo",
      assigneeUserId: "local-board",
    });

    // Match status correctly but lie about assigneeUserId. CAS guard must
    // 409 on the assigneeUserId comparison specifically.
    const res = await request(createApp(boardActor(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "todo",
        assigneeUserId: null,
        expectedStatus: "todo",
        expectedAssigneeUserId: null, // <-- stale: the row still has "local-board"
      });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/issue_write_ownership_cas_mismatch/);
    expect(JSON.stringify(res.body)).toMatch(/expectedAssigneeUserId/);

    const row = await db
      .select({ status: issues.status, assigneeUserId: issues.assigneeUserId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((r) => r[0]);
    expect(row).toEqual({ status: "todo", assigneeUserId: "local-board" });
  });

  // --- the board-actor mandatory check (CAS missing on ownership fields) --

  it("boundary: status CAS is OPT-IN — a status-only board PATCH without expected succeeds", async () => {
    // SPA-10859 boundary decision. Under local_trusted the board UI and the
    // offending sweep are the same actor class (type=board, local_implicit),
    // so a mandatory expectedStatus cannot separate them; it would 409 every
    // human status change in the in-repo board UI. Mandatory enforcement
    // therefore covers the ownership-transmit fields only. This test pins
    // that status stays opt-in: `todo -> backlog` is accepted with no
    // expected fields, and the row actually moves.
    const { companyId } = await seedCompanyAndAgent();
    const issueId = await seedIssue({
      companyId,
      status: "todo",
      assigneeUserId: "local-board",
    });

    const res = await request(createApp(boardActor(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "backlog" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/issue_write_ownership_cas_/);

    const row = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((r) => r[0]);
    expect(row?.status).toBe("backlog");
  });

  it("negative: the SPA-10357 sweep shape (status + assignee off local-board) without expected is rejected 409 cas-missing", async () => {
    // The literal 2026-09-28 shape: one PATCH moves status AND the assignee
    // off local-board. The ownership-transmit fields are mandatory for a
    // board actor, so the missing expectedAssignee* fields reject the write
    // before any mutation even though the status change alone would pass.
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedIssue({
      companyId,
      status: "todo",
      assigneeUserId: "local-board",
    });

    const res = await request(createApp(boardActor(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "backlog", assigneeUserId: null, assigneeAgentId: agentId });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/issue_write_ownership_cas_missing/);
    expect(JSON.stringify(res.body)).toMatch(/expectedAssigneeUserId|expectedAssigneeAgentId/);

    const row = await db
      .select({
        status: issues.status,
        assigneeUserId: issues.assigneeUserId,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((r) => r[0]);
    expect(row).toEqual({
      status: "todo",
      assigneeUserId: "local-board",
      assigneeAgentId: null,
    });
  });

  it("positive: ownership transfer with matching expectedAssignee* and no expectedStatus succeeds", async () => {
    // Proves the two halves of the boundary at once: the ownership fields are
    // mandatory (so the transfer must carry expected) and status remains
    // opt-in (the transfer is accepted without expectedStatus).
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedIssue({
      companyId,
      status: "todo",
      assigneeUserId: "local-board",
    });

    const res = await request(createApp(boardActor(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "backlog",
        assigneeUserId: null,
        assigneeAgentId: agentId,
        expectedAssigneeUserId: "local-board",
        expectedAssigneeAgentId: null,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/issue_write_ownership_cas_/);

    const row = await db
      .select({
        status: issues.status,
        assigneeUserId: issues.assigneeUserId,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((r) => r[0]);
    expect(row).toEqual({
      status: "backlog",
      assigneeUserId: null,
      assigneeAgentId: agentId,
    });
  });

  it("negative: PATCH that changes assigneeUserId without expectedAssigneeUserId is rejected by the service with 409 cas-missing", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const issueId = await seedIssue({
      companyId,
      status: "todo",
      assigneeUserId: "local-board",
    });

    const res = await request(createApp(boardActor(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeUserId: null });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/issue_write_ownership_cas_missing/);
    expect(JSON.stringify(res.body)).toMatch(/expectedAssigneeUserId/);

    const row = await db
      .select({ assigneeUserId: issues.assigneeUserId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((r) => r[0]);
    expect(row?.assigneeUserId).toBe("local-board");
  });

  // --- back-compat --------------------------------------------------------

  it("back-compat: title-only PATCH does NOT require expected fields", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const issueId = await seedIssue({
      companyId,
      status: "todo",
      assigneeUserId: "local-board",
      title: "Original title",
    });

    const res = await request(createApp(boardActor(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Updated title via new path" });

    // Title-only edit must not be blocked by the CAS guard. Title edits do
    // not change status / assigneeUserId / assigneeAgentId, so the helper
    // returns immediately without checking expected.
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/issue_write_ownership_cas_/);
    const row = await db
      .select({ title: issues.title })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((r) => r[0]);
    expect(row?.title).toBe("Updated title via new path");
  });

  // --- positive control (the done condition the card requires) -----------

  it("positive: PATCH succeeds when caller expected matches the live row", async () => {
    // The SPA-10357 named control's done condition includes a positive
    // control: a PATCH that supplies matching expected* must succeed.
    // Ownership transfer with matching expectedAssignee* plus an opt-in
    // expectedStatus proves the full CAS path end to end.
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedIssue({
      companyId,
      status: "todo",
      assigneeUserId: "local-board",
    });

    const res = await request(createApp(boardActor(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "in_review",
        assigneeUserId: null,
        assigneeAgentId: agentId,
        expectedStatus: "todo",
        expectedAssigneeUserId: "local-board",
        expectedAssigneeAgentId: null,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/issue_write_ownership_cas_/);

    const row = await db
      .select({
        status: issues.status,
        assigneeUserId: issues.assigneeUserId,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((r) => r[0]);
    expect(row).toEqual({
      status: "in_review",
      assigneeUserId: null,
      assigneeAgentId: agentId,
    });
  });

  it("positive: TOCTOU — caller expected matches the locked snapshot even when pre-lock differs", async () => {
    // The done condition's other half: when a concurrent write has flipped
    // the row between the caller's read and the engine's lock, the CAS
    // helper uses the LOCKED snapshot for both change-detection and
    // comparison. A caller who observed `expectedStatus: "todo"` and the
    // row is now `in_progress` (because someone else moved it just now)
    // must see the CAS helper treat status as changed and reject with
    // cas-mismatch. This proves the locked snapshot is the comparison
    // surface — the pre-lock read is informational only.
    const { companyId } = await seedCompanyAndAgent();
    const issueId = await seedIssue({
      companyId,
      status: "todo",
      assigneeUserId: "local-board",
    });

    // Simulate the concurrent write: flip status to in_review BEFORE the
    // caller's PATCH lands. The caller's `expectedStatus: "todo"` is stale
    // against the locked snapshot.
    await db
      .update(issues)
      .set({ status: "in_review" })
      .where(eq(issues.id, issueId));

    const res = await request(createApp(boardActor(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "done",
        expectedStatus: "todo", // <-- stale against the now-in_review row
      });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/issue_write_ownership_cas_mismatch/);
    expect(JSON.stringify(res.body)).toMatch(/expectedStatus/);
  });

  // --- TOCTOU control is actor-agnostic -----------------------------------

  it("negative: actor-agnostic — stale expected throws conflict on the live row", async () => {
    // The CAS guard runs against the row's locked snapshot, period. We
    // exercise it directly via the exported helper, which is the same code
    // path the service uses; actor type is not a parameter of the guard.
    const { assertIssueWriteOwnershipCAS } = await import(
      "../services/issues.js"
    );

    const liveRow = {
      status: "in_progress" as const,
      assigneeUserId: null as string | null,
      assigneeAgentId: null as string | null,
    };
    const staleExpected = {
      expectedStatus: "todo", // <-- stale
      expectedAssigneeUserId: null,
      expectedAssigneeAgentId: null,
    };
    const changes = {
      statusChanged: true,
      assigneeUserIdChanged: false,
      assigneeAgentIdChanged: false,
    };

    expect(() => assertIssueWriteOwnershipCAS(liveRow, staleExpected, changes)).toThrowError(
      expect.objectContaining({
        status: 409,
        details: expect.objectContaining({
          code: "issue_write_ownership_cas_mismatch",
          field: "expectedStatus",
        }),
      }),
    );
  });

  it("negative: actor-agnostic — missing expected returns cas-missing", async () => {
    const { assertIssueWriteOwnershipCAS } = await import(
      "../services/issues.js"
    );
    const liveRow = {
      status: "todo" as const,
      assigneeUserId: "local-board" as string | null,
      assigneeAgentId: null,
    };
    const changes = {
      statusChanged: false,
      assigneeUserIdChanged: true, // <-- but expected is not supplied
      assigneeAgentIdChanged: false,
    };

    expect(() => assertIssueWriteOwnershipCAS(liveRow, {}, changes)).toThrowError(
      expect.objectContaining({
        status: 409,
        details: expect.objectContaining({
          code: "issue_write_ownership_cas_missing",
          field: "expectedAssigneeUserId",
        }),
      }),
    );
  });

  it("boundary: a status re-stamp plus a title edit without expected succeeds", async () => {
    // The board UI commonly sends status alongside a title/property edit.
    // Status is opt-in, so this must not 409.
    const { companyId } = await seedCompanyAndAgent();
    const issueId = await seedIssue({
      companyId,
      status: "todo",
      assigneeUserId: "local-board",
    });

    const res = await request(createApp(boardActor(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "todo", title: "Renamed in place" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/issue_write_ownership_cas_/);
    const row = await db
      .select({ title: issues.title, status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((r) => r[0]);
    expect(row?.title).toBe("Renamed in place");
    expect(row?.status).toBe("todo");
  });

  it("boundary (transfer-only trigger): the board UI composer shape — unchanged assignee values, no expected — succeeds", async () => {
    // The in-repo board UI's comment flow re-sends the issue's CURRENT
    // assigneeUserId/assigneeAgentId on every post (ui/src/pages/
    // IssueDetail.tsx composer). Under the transfer-only trigger an
    // unchanged value is not an ownership departure, so this must not 409.
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedIssue({
      companyId,
      status: "todo",
      assigneeUserId: "board-user",
    });

    const res = await request(createApp(boardActor(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeUserId: "board-user", assigneeAgentId: null });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/issue_write_ownership_cas_/);
    const row = await db
      .select({
        assigneeUserId: issues.assigneeUserId,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((r) => r[0]);
    expect(row).toEqual({ assigneeUserId: "board-user", assigneeAgentId: null });
  });

  it("boundary (transfer-only trigger): same-value write from the OTHER owner — agent re-stamp, no expected — succeeds", async () => {
    // Symmetric composer shape: the issue already sits on an agent and the
    // caller re-sends that same agent. No departure, no gate.
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedIssue({
      companyId,
      status: "todo",
      assigneeUserId: null,
      assigneeAgentId: agentId,
    });

    const res = await request(createApp(boardActor(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send({ comment: "a reply", assigneeUserId: null, assigneeAgentId: agentId });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/issue_write_ownership_cas_/);
  });

  it("negative: supplied-but-stale expected on an unchanged value still 409s (service CAS on opt-in expectations)", async () => {
    // A caller that opts into CAS by supplying expected* gets the full
    // locked-snapshot comparison even when the target value is unchanged —
    // a stale expectation is a stale observation and must not pass.
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedIssue({
      companyId,
      status: "todo",
      assigneeUserId: "board-user",
    });

    const res = await request(createApp(boardActor(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send({
        assigneeUserId: "board-user",
        expectedAssigneeUserId: "someone-else",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/issue_write_ownership_cas_/);
  });
});