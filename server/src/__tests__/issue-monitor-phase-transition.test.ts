import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

const AUTHORIZED_USER_ID = "monitor-operator";
const UNAUTHORIZED_USER_ID = "monitor-observer";
const GRANTED_BY_USER_ID = "monitor-grant-admin";
const HISTORICAL_AUTHORIZED_USER_ID = "retired-monitor-operator";
const HISTORICAL_GRANTED_BY_USER_ID = "retired-grant-admin";
const PRIOR_PREDICATE = "queue_depth > 50 for 10m";
const NEXT_PREDICATE = "error_rate > 0.01 for 5m";
const PRIOR_NOTES = "Terminal third attempt: queue remained above the recovery threshold.";
const NEXT_NOTES = "Fresh phase requested after the queue monitor exhausted.";

function boardActor(companyId: string, userId: string): Express.Request["actor"] {
  return {
    type: "board",
    userId,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "operator", status: "active" }],
    isInstanceAdmin: false,
    source: "session",
  };
}

function createApp(db: ReturnType<typeof createDb>, actor: Express.Request["actor"]) {
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

describeDatabase("issue monitor phase transition route", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-monitor-phase-");
    db = createDb(temporary.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await temporary?.cleanup();
  }, 20_000);

  async function seedExhaustedIssue() {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const issueId = randomUUID();
    const phaseId = randomUUID();
    const grantId = randomUUID();
    const historicalGrantId = randomUUID();
    const currentAuthorizationProvenance = {
      principalType: "user",
      principalId: AUTHORIZED_USER_ID,
      permissionKey: "tools:manage_runtime",
      grantId,
      grantedByUserId: GRANTED_BY_USER_ID,
      authorizationReason: "allow_explicit_grant",
    };
    const historicalAuthorizationProvenance = {
      principalType: "user",
      principalId: HISTORICAL_AUTHORIZED_USER_ID,
      permissionKey: "tools:manage_runtime",
      grantId: historicalGrantId,
      grantedByUserId: HISTORICAL_GRANTED_BY_USER_ID,
      authorizationReason: "allow_explicit_grant",
    };
    const exhaustedPhaseBefore = {
      phaseId,
      status: "cleared",
      nextCheckAt: null,
      lastTriggeredAt: "2026-11-06T10:00:00.000Z",
      attemptCount: 3,
      maxAttempts: 3,
      clearReason: "max_attempts_exhausted",
      clearedAt: "2026-11-06T10:01:00.000Z",
      predicate: PRIOR_PREDICATE,
      notes: PRIOR_NOTES,
      scheduledBy: "board",
      authorizationProvenance: historicalAuthorizationProvenance,
    };

    await db.insert(companies).values({
      id: companyId,
      name: "Monitor phase integration",
      issuePrefix: `MP${companyId.slice(0, 5).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "Monitor owner",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: AUTHORIZED_USER_ID, status: "active", membershipRole: "operator" },
      { companyId, principalType: "user", principalId: UNAUTHORIZED_USER_ID, status: "active", membershipRole: "operator" },
    ]);
    await db.insert(principalPermissionGrants).values({
      id: grantId,
      companyId,
      principalType: "user",
      principalId: AUTHORIZED_USER_ID,
      permissionKey: "tools:manage_runtime",
      scope: null,
      grantedByUserId: GRANTED_BY_USER_ID,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Exhausted monitor remains on the same issue",
      status: "in_progress",
      priority: "high",
      assigneeAgentId,
      executionPolicy: { mode: "normal", commentRequired: true, stages: [], monitor: null },
      executionState: {
        status: "idle",
        currentStageId: null,
        currentStageIndex: null,
        currentStageType: null,
        currentParticipant: null,
        returnAssignee: null,
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: exhaustedPhaseBefore,
      },
      monitorAttemptCount: 3,
      monitorNotes: PRIOR_NOTES,
      monitorScheduledBy: "board",
      monitorNextCheckAt: null,
    });

    return {
      companyId,
      issueId,
      phaseId,
      grantId,
      currentAuthorizationProvenance,
      historicalAuthorizationProvenance,
      exhaustedPhaseBefore,
    };
  }

  it("archives the exhausted phase and creates one fresh bound-3 phase through one authorized API operation", async () => {
    const fixture = await seedExhaustedIssue();

    const response = await request(createApp(db, boardActor(fixture.companyId, AUTHORIZED_USER_ID)))
      .post(`/api/issues/${fixture.issueId}/monitor/phase-transition`)
      .send({ predicate: NEXT_PREDICATE, notes: NEXT_NOTES, maxAttempts: 3 });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.archivedPhase).toEqual(fixture.exhaustedPhaseBefore);

    const expectedActivePhase = {
      phaseId: response.body.activePhase.phaseId,
      status: "active",
      attemptCount: 0,
      maxAttempts: 3,
      clearReason: null,
      predicate: NEXT_PREDICATE,
      notes: NEXT_NOTES,
      scheduledBy: "board",
      authorizationProvenance: fixture.currentAuthorizationProvenance,
    };
    expect(expectedActivePhase.phaseId).toEqual(expect.any(String));
    expect(expectedActivePhase.phaseId).not.toBe(fixture.phaseId);
    expect(expectedActivePhase.authorizationProvenance).not.toEqual(fixture.historicalAuthorizationProvenance);
    expect(response.body.activePhase).toEqual(expectedActivePhase);
    expect(response.body.ledger).toEqual([fixture.exhaustedPhaseBefore, expectedActivePhase]);

    const persisted = await db.select().from(issues).where(eq(issues.id, fixture.issueId)).then((rows) => rows[0]!);
    expect((persisted as any).monitorPhaseHistory).toEqual([fixture.exhaustedPhaseBefore, expectedActivePhase]);
    expect((persisted as any).monitorActivePhase).toEqual(expectedActivePhase);
    expect(persisted.monitorAttemptCount).toBe(0);
  });

  it("denies an operator without the enforced runtime grant and leaves the exhausted issue byte-for-byte unchanged", async () => {
    const fixture = await seedExhaustedIssue();
    const before = await db.select().from(issues).where(eq(issues.id, fixture.issueId)).then((rows) => rows[0]!);

    const response = await request(createApp(db, boardActor(fixture.companyId, UNAUTHORIZED_USER_ID)))
      .post(`/api/issues/${fixture.issueId}/monitor/phase-transition`)
      .send({ predicate: NEXT_PREDICATE, notes: NEXT_NOTES, maxAttempts: 3 });

    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body).toEqual({
      error: "Missing permission: tools:manage_runtime.",
      details: { reason: "deny_missing_grant" },
    });
    const after = await db.select().from(issues).where(eq(issues.id, fixture.issueId)).then((rows) => rows[0]!);
    expect(after).toEqual(before);
  });
});
