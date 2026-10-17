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
import { instanceSettingsService } from "../services/instance-settings.ts";
import { AGENT_CODE_CARD_REQUIRES_WORKSPACE_CODE } from "../services/execution-workspace-policy.js";

// d1c. An agent-created CODE card that signals a repository workspace (via
// executionWorkspacePreference or executionWorkspaceSettings.mode) but names
// no explicit projectWorkspaceId is refused at create time with a 422 that
// names `projectWorkspaceId`, instead of being stored with a null workspace.
//
// Every arm runs against a disposable embedded Postgres created by this file.
// No live board write.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres explicit-workspace guard route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("agent-authored code card explicit workspace guard", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-issue-explicit-workspace-guard-",
    );
    db = createDb(tempDb.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
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
  // agent arm differ only in `req.actor`, which is what the guard scopes on.
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
      name: "Explicit workspace guard",
      issuePrefix: `EW${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
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

  async function seedProjectWorkspace(
    companyId: string,
    projectId: string,
    isPrimary = true,
  ) {
    const [workspace] = await db
      .insert(projectWorkspaces)
      .values({
        companyId,
        projectId,
        name: "guard-workspace",
        sourceType: "local_path",
        cwd: "/srv/bulk/worktrees/guard-fixture",
        isPrimary,
      })
      .returning();
    return workspace!;
  }

  it("refuses an agent code card via executionWorkspacePreference without an explicit workspace", async () => {
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
        title: "Agent code card naming a preference but no workspace",
        projectId: project.id,
        executionWorkspacePreference: "isolated_workspace",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("projectWorkspaceId");
    expect(res.body.details?.code).toBe(
      AGENT_CODE_CARD_REQUIRES_WORKSPACE_CODE,
    );
    expect(res.body.details?.candidateProjectWorkspaceIds).toContain(
      workspace.id,
    );
    // Nothing was stored: the card is refused, not born workspace-less.
    expect(
      await db.select().from(issues).where(eq(issues.companyId, companyId)),
    ).toHaveLength(0);
  });

  it("refuses an agent code card via executionWorkspaceSettings.mode without an explicit workspace", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    const project = await seedProject(companyId);
    await seedProjectWorkspace(companyId, project.id);
    const run = await seedRun(companyId, agent.id);
    const app = createApp("agent", {
      companyId,
      agentId: agent.id,
      runId: run.id,
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Agent code card naming a settings mode but no workspace",
        projectId: project.id,
        executionWorkspaceSettings: { mode: "operator_branch" },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("projectWorkspaceId");
    expect(res.body.details?.code).toBe(
      AGENT_CODE_CARD_REQUIRES_WORKSPACE_CODE,
    );
  });

  it("keeps the board-actor code card unchanged and default-fills the primary workspace", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    const project = await seedProject(companyId);
    const workspace = await seedProjectWorkspace(companyId, project.id);
    const run = await seedRun(companyId, agent.id);
    const app = createApp("board", {
      companyId,
      agentId: agent.id,
      runId: run.id,
    });

    // The human path is untouched: same code-signalling payload, 201, and the
    // primary workspace is default-filled.
    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Board-authored code card with a preference",
        projectId: project.id,
        executionWorkspacePreference: "isolated_workspace",
      })
      .expect(201);

    expect(res.body.projectWorkspaceId).toBe(workspace.id);
  });

  it("default-fills the primary workspace for an agent non-code card", async () => {
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

    // No workspace fields: the agent_default/non-code shape, so the primary
    // workspace is default-filled instead of refused.
    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Agent non-code card", projectId: project.id })
      .expect(201);

    expect(res.body.projectWorkspaceId).toBe(workspace.id);
  });

  it("creates an agent code card that names its workspace explicitly", async () => {
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
        title: "Agent code card with an explicit workspace",
        projectId: project.id,
        executionWorkspacePreference: "isolated_workspace",
        projectWorkspaceId: workspace.id,
      })
      .expect(201);

    expect(res.body.projectWorkspaceId).toBe(workspace.id);
  });

  it("d1d: a child inheriting an isolated execution pin with null projectWorkspaceId is not 422", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    const project = await seedProject(companyId);
    const workspace = await seedProjectWorkspace(companyId, project.id);
    const run = await seedRun(companyId, agent.id);
    // Source issue: explicit project, null workspace pin, isolated execution
    // pin bound to the same project's primary workspace.
    const activeExecutionWorkspaceId = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: activeExecutionWorkspaceId,
      companyId,
      projectId: project.id,
      projectWorkspaceId: workspace.id,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "d1d execution workspace",
      status: "active",
      providerType: "local_fs",
      cwd: "/tmp/paperclip-d1d-execution",
    });
    const [source] = await db
      .insert(issues)
      .values({
        companyId,
        title: "d1d inheritance source",
        status: "todo",
        projectId: project.id,
        projectWorkspaceId: null,
        executionWorkspaceId: activeExecutionWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "isolated_workspace" },
      })
      .returning();
    const app = createApp("agent", {
      companyId,
      agentId: agent.id,
      runId: run.id,
    });

    // The child signals no workspace intent itself: no preference, no
    // settings, no workspace fields. Any code signal comes only from the
    // inherited isolated pin, which the d1d exemption lets through.
    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "d1d inherited child",
        projectId: project.id,
        inheritExecutionWorkspaceFromIssueId: source!.id,
      })
      .expect(201);

    expect(res.body.projectWorkspaceId).toBe(workspace.id);
  });
});
