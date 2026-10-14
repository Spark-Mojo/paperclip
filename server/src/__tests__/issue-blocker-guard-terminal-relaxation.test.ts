import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issueRelations,
  issues,
  projectWorkspaces,
  projects,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

// SPA-12197 — friction #1623. A `blocked` dependent whose blocker reached
// `cancelled` (or `done`) is wedged: EVERY transition 409s with "Issue
// follow-up blocked by unresolved blockers", including the one request that
// would clear the wedge (an explicit `blockedByIssueIds` set).
//
// The guard is NOT memoized. `assertExplicitResumeIntentAllowed`
// (routes/issues.ts) reads `svc.getDependencyReadiness(issue.id)` against the
// STORED `blocks` rows, but the relation write (`syncBlockedByIssueIds`,
// services/issues.ts) only runs later inside `svc.update`. So the request is
// judged against the pre-mutation relation set and the mutation never runs.
//
// Fix: when the request explicitly supplies an array `blockedByIssueIds`, the
// guard evaluates against the REQUESTED post-mutation set — and only relaxes
// when every blocker it would remove is already TERMINAL (done/cancelled). An
// open blocker still blocks. This mirrors the existing `enteringBlocked`
// precedent, which already judges the requested set on the way INTO blocked.
//
// Live instance this reproduces: SPA-8040 (blocked; SPA-8036 done, SPA-8037
// cancelled, SPA-8038 done) — wedged since 2026-09-24.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping SPA-12197 terminal-blocker guard tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;
type CompanyRow = typeof companies.$inferSelect;
type AgentRow = typeof agents.$inferSelect;

function createApp(db: Db, actor: Express.Request["actor"]) {
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

// The guard under repair is agent-only: `agentStatusTransitionRequiresResumeAuthority`
// (routes/issues.ts) is true only for `req.actor.type === "agent"`, so a board
// PATCH never reaches it. The repair path this card restores is therefore the
// ORDINARY AGENT PATCH — which is exactly what Juno asked for and what a
// board-only affordance would not deliver.
function agentActor(
  company: CompanyRow,
  agent: AgentRow,
  runId: string,
): Express.Request["actor"] {
  return {
    type: "agent",
    agentId: agent.id,
    companyId: company.id,
    runId,
    source: "agent_jwt",
  } as Express.Request["actor"];
}

async function seedRunningRun(
  db: Db,
  companyId: string,
  agentId: string,
  issueId: string,
) {
  const [run] = await db
    .insert(heartbeatRuns)
    .values({
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { issueId },
    })
    .returning();
  return run!;
}

async function seedCompany(db: Db, label: string) {
  const nonce = randomUUID().slice(0, 8);
  const [company] = await db.insert(companies).values({
    name: `${label} ${nonce}`,
    issuePrefix: `TG${nonce.slice(0, 4).toUpperCase()}`,
    defaultResponsibleUserId: "board-user",
  }).returning();
  return company!;
}

async function seedAgent(db: Db, companyId: string) {
  const [agent] = await db.insert(agents).values({
    companyId,
    name: `Agent ${randomUUID().slice(0, 6)}`,
    role: "engineer",
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
  }).returning();
  return agent!;
}

async function seedProject(db: Db, companyId: string) {
  const [project] = await db.insert(projects).values({
    companyId,
    name: `Project ${randomUUID().slice(0, 6)}`,
    status: "in_progress",
  }).returning();
  return project!;
}

async function seedIssue(
  db: Db,
  input: {
    companyId: string;
    title: string;
    status?: string;
    assigneeAgentId?: string | null;
    assigneeUserId?: string | null;
    projectId?: string | null;
    executionWorkspaceId?: string | null;
  },
) {
  const [issue] = await db.insert(issues).values({
    companyId: input.companyId,
    projectId: input.projectId ?? null,
    title: input.title,
    status: input.status ?? "todo",
    priority: "medium",
    assigneeAgentId: input.assigneeAgentId ?? null,
    assigneeUserId: input.assigneeUserId ?? null,
    executionWorkspaceId: input.executionWorkspaceId ?? null,
    originKind: "manual",
    originId: null,
    originFingerprint: "default",
    responsibleUserId: "board-user",
  }).returning();
  return issue!;
}

async function seedSharedWorkspace(db: Db, companyId: string, projectId: string) {
  const projectWorkspaceId = randomUUID();
  const executionWorkspaceId = randomUUID();
  await db.insert(projectWorkspaces).values({
    id: projectWorkspaceId,
    companyId,
    projectId,
    name: `PW ${randomUUID().slice(0, 6)}`,
    sourceType: "local_path",
    visibility: "default",
    isPrimary: true,
  });
  await db.insert(executionWorkspaces).values({
    id: executionWorkspaceId,
    companyId,
    projectId,
    projectWorkspaceId,
    mode: "isolated_workspace",
    strategyType: "git_worktree",
    name: `EW ${randomUUID().slice(0, 6)}`,
    status: "active",
    providerType: "git_worktree",
  });
  return { projectWorkspaceId, executionWorkspaceId };
}

async function blockEdge(
  db: Db,
  companyId: string,
  blockerIssueId: string,
  blockedIssueId: string,
) {
  await db.insert(issueRelations).values({
    companyId,
    issueId: blockerIssueId,
    relatedIssueId: blockedIssueId,
    type: "blocks",
  });
}

describeEmbeddedPostgres(
  "SPA-12197 blocked-dependent guard honours the requested terminal blocker set",
  () => {
    let db!: Db;
    let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

    beforeAll(async () => {
      tempDb = await startEmbeddedPostgresTestDatabase(
        "paperclip-spa12197-terminal-blocker-guard-",
      );
      db = createDb(tempDb.connectionString);
    }, 60_000);

    afterEach(async () => {
      await db.delete(issueRelations);
      await db.delete(workspaceOperations);
      // The transition writes activity rows keyed on the run, so the log has
      // to be cleared before the run rows it references.
      await db.delete(activityLog);
      await db.delete(heartbeatRuns);
      await db.delete(issues);
      await db.delete(executionWorkspaces);
      await db.delete(projectWorkspaces);
      await db.delete(agents);
      await db.delete(projects);
      await db.delete(companies);
    });

    afterAll(async () => {
      await tempDb?.cleanup();
    });

    // The live SPA-8040 shape: a blocked card whose blocker set is entirely
    // terminal (done + cancelled). Supplying the explicit empty set must let
    // the card move again, and must actually drop the edges.
    it("drops the terminal blocker edges and moves the blocked dependent", async () => {
      const company = await seedCompany(db, "CancelledBlocker");
      const agent = await seedAgent(db, company.id);
      const project = await seedProject(db, company.id);

      const doneBlocker = await seedIssue(db, {
        companyId: company.id,
        projectId: project.id,
        title: "done blocker",
        status: "done",
      });
      const cancelledBlocker = await seedIssue(db, {
        companyId: company.id,
        projectId: project.id,
        title: "cancelled blocker",
        status: "cancelled",
      });
      const dependent = await seedIssue(db, {
        companyId: company.id,
        projectId: project.id,
        title: "wedged dependent",
        status: "blocked",
        assigneeAgentId: agent.id,
      });

      await blockEdge(db, company.id, doneBlocker.id, dependent.id);
      await blockEdge(db, company.id, cancelledBlocker.id, dependent.id);

      const run = await seedRunningRun(db, company.id, agent.id, dependent.id);
      const app = createApp(db, agentActor(company, agent, run.id));
      const res = await request(app)
        .patch(`/api/issues/${dependent.id}`)
        .send({ status: "done", blockedByIssueIds: [] });

      // Before the fix this is a 409 "Issue follow-up blocked by unresolved
      // blockers" and no edge is ever dropped.
      expect(res.status).toBe(200);

      const [after] = await db
        .select({ status: issues.status })
        .from(issues)
        .where(eq(issues.id, dependent.id));
      expect(after!.status).toBe("done");

      const remaining = await db
        .select({ id: issueRelations.id })
        .from(issueRelations)
        .where(eq(issueRelations.relatedIssueId, dependent.id));
      expect(remaining).toHaveLength(0);

      // The guard's synthetic resolution must not leak phantom `blocks`
      // rows: the company's relation table must be empty after the repair
      // (the dependent's own edges were dropped; the synthetic rows key on a
      // random id no real issue can collide with, so anything left is a leak).
      const leftover = await db
        .select({ id: issueRelations.id })
        .from(issueRelations)
        .where(eq(issueRelations.companyId, company.id));
      expect(leftover).toHaveLength(0);
    });

    // The integrity half: a still-OPEN blocker must keep refusing, even when
    // the request tries to drop it in the same PATCH. The relaxation is
    // terminal-only, so this must stay a 409.
    it("still refuses when a blocker being dropped is NOT terminal", async () => {
      const company = await seedCompany(db, "OpenBlocker");
      const agent = await seedAgent(db, company.id);
      const project = await seedProject(db, company.id);

      const openBlocker = await seedIssue(db, {
        companyId: company.id,
        projectId: project.id,
        title: "open blocker",
        status: "in_progress",
      });
      const dependent = await seedIssue(db, {
        companyId: company.id,
        projectId: project.id,
        title: "still blocked",
        status: "blocked",
        assigneeAgentId: agent.id,
      });
      await blockEdge(db, company.id, openBlocker.id, dependent.id);

      const run = await seedRunningRun(db, company.id, agent.id, dependent.id);
      const app = createApp(db, agentActor(company, agent, run.id));
      const res = await request(app)
        .patch(`/api/issues/${dependent.id}`)
        .send({ status: "done", blockedByIssueIds: [] });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/unresolved blockers/i);

      // The edge must survive the refusal — the guard protects it.
      const remaining = await db
        .select({ id: issueRelations.id })
        .from(issueRelations)
        .where(eq(issueRelations.relatedIssueId, dependent.id));
      expect(remaining).toHaveLength(1);

      const [after] = await db
        .select({ status: issues.status })
        .from(issues)
        .where(eq(issues.id, dependent.id));
      expect(after!.status).toBe("blocked");
    });

    // A blocked card with NO blockers at all must keep behaving exactly as
    // before: the relaxation must not change the no-blocker path.
    it("leaves a blocker-free blocked card untouched by the relaxation", async () => {
      const company = await seedCompany(db, "NoBlocker");
      const agent = await seedAgent(db, company.id);
      const project = await seedProject(db, company.id);

      const dependent = await seedIssue(db, {
        companyId: company.id,
        projectId: project.id,
        title: "blocked without blockers",
        status: "blocked",
        assigneeAgentId: agent.id,
      });

      const run = await seedRunningRun(db, company.id, agent.id, dependent.id);
      const app = createApp(db, agentActor(company, agent, run.id));
      const res = await request(app)
        .patch(`/api/issues/${dependent.id}`)
        .send({ status: "done", blockedByIssueIds: [] });

      expect(res.status).toBe(200);
      const [after] = await db
        .select({ status: issues.status })
        .from(issues)
        .where(eq(issues.id, dependent.id));
      expect(after!.status).toBe("done");
    });

    // A `done` blocker stuck behind the workspace-finalize barrier is
    // UNRESOLVED per the resolver even though its status is terminal — so
    // dropping it must NOT earn relaxation. The request keeps 409ing and the
    // edge survives; only the finalize wake clears it (Branch A, self-healing).
    it("still refuses when a dropped done blocker is pending workspace finalize", async () => {
      const company = await seedCompany(db, "PendingFinalize");
      const agent = await seedAgent(db, company.id);
      const project = await seedProject(db, company.id);
      const { executionWorkspaceId } = await seedSharedWorkspace(
        db,
        company.id,
        project.id,
      );

      const finalizeBlocker = await seedIssue(db, {
        companyId: company.id,
        projectId: project.id,
        title: "done but not finalized",
        status: "done",
        executionWorkspaceId,
      });
      const dependent = await seedIssue(db, {
        companyId: company.id,
        projectId: project.id,
        title: "finalize-gated dependent",
        status: "blocked",
        assigneeAgentId: agent.id,
      });
      await blockEdge(db, company.id, finalizeBlocker.id, dependent.id);
      // The blocker touched its workspace but never recorded a successful
      // workspace_finalize — the resolver holds the dependent.
      await db.insert(workspaceOperations).values({
        companyId: company.id,
        executionWorkspaceId,
        issueId: finalizeBlocker.id,
        phase: "worktree_prepare",
        status: "succeeded",
        startedAt: new Date("2026-10-13T20:00:00.000Z"),
      });

      const run = await seedRunningRun(db, company.id, agent.id, dependent.id);
      const app = createApp(db, agentActor(company, agent, run.id));
      const res = await request(app)
        .patch(`/api/issues/${dependent.id}`)
        .send({ status: "done", blockedByIssueIds: [] });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/unresolved blockers/i);

      const remaining = await db
        .select({ id: issueRelations.id })
        .from(issueRelations)
        .where(eq(issueRelations.relatedIssueId, dependent.id));
      expect(remaining).toHaveLength(1);
    });

    // Allow-case for the re-add path: a dropped `done` blocker that carries
    // an execution workspace but whose finalize already SUCCEEDED resolves
    // clean — the drop proceeds. Without this test a re-add that always
    // resolves unresolved would wedge (fail-closed availability bug)
    // undetected.
    it("drops a done blocker whose workspace finalize already succeeded", async () => {
      const company = await seedCompany(db, "FinalizedDrop");
      const agent = await seedAgent(db, company.id);
      const project = await seedProject(db, company.id);
      const { executionWorkspaceId } = await seedSharedWorkspace(
        db,
        company.id,
        project.id,
      );

      const finalizedBlocker = await seedIssue(db, {
        companyId: company.id,
        projectId: project.id,
        title: "done and finalized",
        status: "done",
        executionWorkspaceId,
      });
      const dependent = await seedIssue(db, {
        companyId: company.id,
        projectId: project.id,
        title: "finalized-gated dependent",
        status: "blocked",
        assigneeAgentId: agent.id,
      });
      await blockEdge(db, company.id, finalizedBlocker.id, dependent.id);
      await db.insert(workspaceOperations).values({
        companyId: company.id,
        executionWorkspaceId,
        issueId: finalizedBlocker.id,
        phase: "workspace_finalize",
        status: "succeeded",
        startedAt: new Date("2026-10-13T20:00:00.000Z"),
      });

      const run = await seedRunningRun(db, company.id, agent.id, dependent.id);
      const app = createApp(db, agentActor(company, agent, run.id));
      const res = await request(app)
        .patch(`/api/issues/${dependent.id}`)
        .send({ status: "done", blockedByIssueIds: [] });

      expect(res.status).toBe(200);
      const [after] = await db
        .select({ status: issues.status })
        .from(issues)
        .where(eq(issues.id, dependent.id));
      expect(after!.status).toBe("done");
    });

    // A request that drops a terminal blocker AND attaches a live open one
    // must still refuse: the post-mutation set contains an unresolved
    // blocker, so the transition cannot proceed. The old intersect-only logic
    // would have passed this (the added blocker was invisible to the stored
    // readiness); the synthetic resolution sees it.
    it("still refuses when the request adds a live blocker beside a terminal drop", async () => {
      const company = await seedCompany(db, "AddedBlocker");
      const agent = await seedAgent(db, company.id);
      const project = await seedProject(db, company.id);

      const cancelledBlocker = await seedIssue(db, {
        companyId: company.id,
        projectId: project.id,
        title: "cancelled blocker",
        status: "cancelled",
      });
      const liveBlocker = await seedIssue(db, {
        companyId: company.id,
        projectId: project.id,
        title: "live blocker",
        status: "in_progress",
      });
      const dependent = await seedIssue(db, {
        companyId: company.id,
        projectId: project.id,
        title: "smuggled-blocker dependent",
        status: "blocked",
        assigneeAgentId: agent.id,
      });
      await blockEdge(db, company.id, cancelledBlocker.id, dependent.id);

      const run = await seedRunningRun(db, company.id, agent.id, dependent.id);
      const app = createApp(db, agentActor(company, agent, run.id));
      const res = await request(app)
        .patch(`/api/issues/${dependent.id}`)
        .send({ status: "done", blockedByIssueIds: [liveBlocker.id] });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/unresolved blockers/i);

      const [after] = await db
        .select({ status: issues.status })
        .from(issues)
        .where(eq(issues.id, dependent.id));
      expect(after!.status).toBe("blocked");
    });

    // Omitting `blockedByIssueIds` must be behaviourally identical to before:
    // the guard still reads the stored set, so an unresolved blocker still
    // refuses. This pins the "explicit array only" requirement.
    it("does not relax when blockedByIssueIds is omitted entirely", async () => {
      const company = await seedCompany(db, "OmittedField");
      const project = await seedProject(db, company.id);
      const agent = await seedAgent(db, company.id);

      const cancelledBlocker = await seedIssue(db, {
        companyId: company.id,
        projectId: project.id,
        title: "cancelled blocker",
        status: "cancelled",
      });
      const dependent = await seedIssue(db, {
        companyId: company.id,
        projectId: project.id,
        title: "no body blockers",
        status: "blocked",
      });
      await blockEdge(db, company.id, cancelledBlocker.id, dependent.id);

      const run = await seedRunningRun(db, company.id, agent.id, dependent.id);
      const app = createApp(db, agentActor(company, agent, run.id));
      const res = await request(app)
        .patch(`/api/issues/${dependent.id}`)
        .send({ status: "done" });

      // A status-only PATCH carries no sanctioned edge-drop intent, so the
      // guard keeps refusing. Repair requires the explicit set.
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/unresolved blockers/i);
    });
  },
);