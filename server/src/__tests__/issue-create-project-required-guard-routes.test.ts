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
  heartbeatRuns,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { AGENT_ROOT_ISSUE_REQUIRES_PROJECT_CODE } from "../services/execution-workspace-policy.js";

// SPA-9498 (leaf of SPA-9495, R1/R2/R3). An agent-created ROOT issue that
// names no project and carries nothing to infer one from is refused at create
// time with a 4xx that names `projectId`, instead of being stored with
// `projectId` null and spawning a later workspace-repair task.
//
// Every arm runs against a disposable embedded Postgres created by this file.
// No live board write.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres project-required guard route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("agent-authored root issue project guard", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-issue-project-required-guard-",
    );
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // The create route reads the actor off the request. The board arm and the
  // agent arm differ only in `req.actor`, which is what R3 scopes on.
  function createApp(actor: "agent" | "board", context: {
    companyId: string;
    agentId: string;
    runId: string;
  }) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor =
        actor === "agent"
          ? ({
              type: "agent",
              agentId: context.agentId,
              companyId: context.companyId,
              runId: context.runId,
              source: "agent_jwt",
            } as never)
          : ({
              type: "board",
              userId: "local-board",
              companyIds: [context.companyId],
              memberships: [
                {
                  companyId: context.companyId,
                  membershipRole: "owner",
                  status: "active",
                },
              ],
              isInstanceAdmin: true,
              source: "local_implicit",
            } as never);
      next();
    });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Project guard",
      issuePrefix: `PG${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string) {
    const [agent] = await db
      .insert(agents)
      .values({
        companyId,
        name: "Guard fixture agent",
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })
      .returning();
    return agent!;
  }

  // The create route stamps the authenticated run id onto the activity log it
  // writes, and `activity_log.run_id` is a real FK. An agent arm therefore
  // needs a persisted run row, not a random uuid.
  async function seedRun(companyId: string, agentId: string) {
    const [run] = await db
      .insert(heartbeatRuns)
      .values({ companyId, agentId, status: "running", contextSnapshot: {} })
      .returning();
    return run!;
  }

  async function seedProject(companyId: string) {
    const [project] = await db
      .insert(projects)
      .values({ companyId, name: "Guard project", status: "in_progress" })
      .returning();
    return project!;
  }

  async function seedProjectWorkspace(companyId: string, projectId: string) {
    const [workspace] = await db
      .insert(projectWorkspaces)
      .values({
        companyId,
        projectId,
        name: "guard-workspace",
        sourceType: "local_path",
        cwd: "/srv/bulk/worktrees/guard-fixture",
        isPrimary: true,
      })
      .returning();
    return workspace!;
  }

  it("refuses an agent-created root create that names no project", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    const run = await seedRun(companyId, agent.id);
    const app = createApp("agent", {
      companyId,
      agentId: agent.id,
      runId: run.id,
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Root task with nothing named" });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    // R1: the refusal names the field the caller must set.
    expect(res.body.error).toContain("projectId");
    expect(res.body.details?.code).toBe(
      AGENT_ROOT_ISSUE_REQUIRES_PROJECT_CODE,
    );
    // Nothing was stored: the card is refused, not born unbound.
    expect(
      await db.select().from(issues).where(eq(issues.companyId, companyId)),
    ).toHaveLength(0);
  });

  it("refuses an agent-created root create that names only an unrelated project reference", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    const run = await seedRun(companyId, agent.id);
    const app = createApp("agent", {
      companyId,
      agentId: agent.id,
      runId: run.id,
    });

    // A goal is not a project. The create still resolves no project, so it is
    // still the refused case.
    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Root task naming only a goal", goalId: null });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("projectId");
  });

  it("creates an agent root task that names a project", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    const project = await seedProject(companyId);
    const run = await seedRun(companyId, agent.id);
    const app = createApp("agent", {
      companyId,
      agentId: agent.id,
      runId: run.id,
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Root task that names its project", projectId: project.id })
      .expect(201);

    expect(res.body.projectId).toBe(project.id);
  });

  it("infers the project from an explicit projectWorkspaceId", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    const project = await seedProject(companyId);
    const workspace = await seedProjectWorkspace(companyId, project.id);
    const run = await seedRun(companyId, agent.id);
    const app = createApp("agent", {
      companyId,
      agentId: agent.id,
      runId: run.id,
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Root task naming only a project workspace",
        projectWorkspaceId: workspace.id,
      })
      .expect(201);

    // R2: inference wins over the refusal.
    expect(res.body.projectId).toBe(project.id);
  });

  it("inherits the project from a parent issue", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    const project = await seedProject(companyId);
    const [parent] = await db
      .insert(issues)
      .values({
        companyId,
        projectId: project.id,
        title: "Parent with a project",
        status: "todo",
        priority: "medium",
      })
      .returning();
    const run = await seedRun(companyId, agent.id);
    const app = createApp("agent", {
      companyId,
      agentId: agent.id,
      runId: run.id,
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Child inheriting its project", parentId: parent!.id })
      .expect(201);

    // R2: the parent inheritance path is unchanged.
    expect(res.body.projectId).toBe(project.id);
  });

  it("inherits the project from an explicit inheritance source issue", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    const project = await seedProject(companyId);
    const [source] = await db
      .insert(issues)
      .values({
        companyId,
        projectId: project.id,
        title: "Inheritance source",
        status: "todo",
        priority: "medium",
      })
      .returning();
    const run = await seedRun(companyId, agent.id);
    const app = createApp("agent", {
      companyId,
      agentId: agent.id,
      runId: run.id,
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Root task inheriting via an explicit source",
        inheritExecutionWorkspaceFromIssueId: source!.id,
      })
      .expect(201);

    expect(res.body.projectId).toBe(project.id);
  });

  it("keeps the board-actor root create unchanged", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    const run = await seedRun(companyId, agent.id);
    const app = createApp("board", {
      companyId,
      agentId: agent.id,
      runId: run.id,
    });

    // R3: the human path is untouched — same projectless payload, 201, and
    // the stored card keeps projectId null exactly as before this change.
    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Board-authored root task with no project" })
      .expect(201);

    expect(res.body.projectId).toBeNull();
    const [stored] = await db
      .select()
      .from(issues)
      .where(eq(issues.companyId, companyId));
    expect(stored).toMatchObject({
      projectId: null,
      createdByUserId: "local-board",
      createdByAgentId: null,
    });
  });

  it("creates a projectless child under a projectless parent for an agent", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    const [parent] = await db
      .insert(issues)
      .values({
        companyId,
        title: "Projectless parent",
        status: "todo",
        priority: "medium",
      })
      .returning();
    const run = await seedRun(companyId, agent.id);
    const app = createApp("agent", {
      companyId,
      agentId: agent.id,
      runId: run.id,
    });

    // A child create is not the unbound-at-birth case: it inherits linkage
    // from its parent, and the guard is root-only. This is unchanged
    // behaviour, recorded so the root-only scoping is explicit.
    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Child of a projectless parent", parentId: parent!.id })
      .expect(201);

    expect(res.body.projectId).toBeNull();
  });
});
