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

// SPA-13192 (d2, child of SPA-13186) — pins the enteringBlocked guard in
// server/src/routes/issues.ts:13779-13839. When PATCH status=blocked names
// only done/cancelled blockers, the guard has no unresolved blocker and
// refuses with a bare 422 "Entering blocked requires unresolved
// blockers...". d1 (separate deliverable) makes that 422 actionable; these
// tests pin the actionable shape (id + terminal status + drop-it
// disposition) plus the live-blocker non-terminal path. No
// lifecycle/wake-semantics changes.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping SPA-13192 blocked-via-terminal 422 tests on this host: ${
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
    issuePrefix: `TB${nonce.slice(0, 4).toUpperCase()}`,
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

describeEmbeddedPostgres(
  "SPA-13192 entering blocked with only terminal blockers returns an actionable 422",
  () => {
    let db!: Db;
    let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

    beforeAll(async () => {
      tempDb = await startEmbeddedPostgresTestDatabase(
        "paperclip-spa13192-terminal-blocked-422-",
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

    // Entering blocked naming only a done blocker has no unresolved blocker,
    // so the guard refuses — and the refusal must be actionable: it names
    // the done blocker id, its terminal status, and the drop-it disposition.
    it("returns an actionable 422 naming the done blocker id, status and drop-it disposition", async () => {
      const company = await seedCompany(db, "DoneTerminal");
      const agent = await seedAgent(db, company.id);
      const project = await seedProject(db, company.id);

      const doneBlocker = await seedIssue(db, {
        companyId: company.id,
        projectId: project.id,
        title: "done blocker",
        status: "done",
      });
      const dependent = await seedIssue(db, {
        companyId: company.id,
        projectId: project.id,
        title: "would-be blocked",
        status: "todo",
        assigneeAgentId: agent.id,
      });

      const run = await seedRunningRun(db, company.id, agent.id, dependent.id);
      const app = createApp(db, agentActor(company, agent, run.id));
      const res = await request(app)
        .patch(`/api/issues/${dependent.id}`)
        .send({ status: "blocked", blockedByIssueIds: [doneBlocker.id] });

      // Before d1 this is a bare 422 "Entering blocked requires unresolved
      // blockers..." with no mention of the terminal blocker.
      expect(res.status).toBe(422);
      const bodyText = JSON.stringify(res.body ?? {});
      expect(bodyText).toContain(doneBlocker.id);
      expect(bodyText).toMatch(/done/);
      expect(bodyText).toMatch(/drop|remove/i);

      // The refusal must not move the card.
      const [after] = await db
        .select({ status: issues.status })
        .from(issues)
        .where(eq(issues.id, dependent.id));
      expect(after!.status).toBe("todo");
    });

    // Same shape with a cancelled blocker: the actionable branch must fire
    // for both terminal statuses, not just done.
    it("returns the same actionable 422 for a cancelled blocker", async () => {
      const company = await seedCompany(db, "CancelledTerminal");
      const agent = await seedAgent(db, company.id);
      const project = await seedProject(db, company.id);

      const cancelledBlocker = await seedIssue(db, {
        companyId: company.id,
        projectId: project.id,
        title: "cancelled blocker",
        status: "cancelled",
      });
      const dependent = await seedIssue(db, {
        companyId: company.id,
        projectId: project.id,
        title: "would-be blocked",
        status: "todo",
        assigneeAgentId: agent.id,
      });

      const run = await seedRunningRun(db, company.id, agent.id, dependent.id);
      const app = createApp(db, agentActor(company, agent, run.id));
      const res = await request(app)
        .patch(`/api/issues/${dependent.id}`)
        .send({ status: "blocked", blockedByIssueIds: [cancelledBlocker.id] });

      expect(res.status).toBe(422);
      const bodyText = JSON.stringify(res.body ?? {});
      expect(bodyText).toContain(cancelledBlocker.id);
      expect(bodyText).toMatch(/cancelled/);
      expect(bodyText).toMatch(/drop|remove/i);

      const [after] = await db
        .select({ status: issues.status })
        .from(issues)
        .where(eq(issues.id, dependent.id));
      expect(after!.status).toBe("todo");
    });

    // A live in_progress blocker IS an unresolved blocker, so the request
    // must not take the actionable-terminal 422 branch: it either enters
    // blocked or returns the generic guard refusal without naming a
    // terminal blocker. Recorded actual behavior below.
    it("does not return the actionable-terminal 422 for a live blocker", async () => {
      const company = await seedCompany(db, "LiveBlocker");
      const agent = await seedAgent(db, company.id);
      const project = await seedProject(db, company.id);

      const liveBlocker = await seedIssue(db, {
        companyId: company.id,
        projectId: project.id,
        title: "live blocker",
        status: "in_progress",
      });
      const dependent = await seedIssue(db, {
        companyId: company.id,
        projectId: project.id,
        title: "would-be blocked",
        status: "todo",
        assigneeAgentId: agent.id,
      });

      const run = await seedRunningRun(db, company.id, agent.id, dependent.id);
      const app = createApp(db, agentActor(company, agent, run.id));
      const res = await request(app)
        .patch(`/api/issues/${dependent.id}`)
        .send({ status: "blocked", blockedByIssueIds: [liveBlocker.id] });

      const bodyText = JSON.stringify(res.body ?? {});
      const tookTerminalBranch =
        res.status === 422 &&
        bodyText.includes(liveBlocker.id) &&
        /terminal|done|cancelled/i.test(bodyText);
      expect(tookTerminalBranch).toBe(false);

      // A 422 here may only be the generic enteringBlocked refusal, which
      // never names a blocker id.
      if (res.status === 422) {
        expect(bodyText).not.toContain(liveBlocker.id);
      } else {
        // Otherwise the transition succeeded — the card is now blocked.
        expect(res.status).toBe(200);
        const [after] = await db
          .select({ status: issues.status })
          .from(issues)
          .where(eq(issues.id, dependent.id));
        expect(after!.status).toBe("blocked");
      }
    });
  },
);
