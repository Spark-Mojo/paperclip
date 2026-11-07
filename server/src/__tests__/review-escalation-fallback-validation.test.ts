import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import express from "express";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
  projects,
  workspaceOperations,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const execFileAsync = promisify(execFile);
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping review escalation fallback validation tests: ${embeddedPostgresSupport.reason ?? "embedded Postgres unavailable"}`,
  );
}

describeEmbeddedPostgres("review escalation fallback validation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempDirs = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-review-fallback-validation-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    try {
      await tempDb?.cleanup();
    } finally {
      try {
        await Promise.all([...tempDirs].map((dir) => fs.rm(dir, { recursive: true, force: true })));
      } finally {
        tempDirs.clear();
      }
    }
  }, 60_000);

  function appForAgent(companyId: string, agentId: string, runId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "agent",
        source: "agent_jwt",
        companyId,
        agentId,
        runId,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedReviewAtRoundCap(
    membership: "active_same_company" | "missing" | "inactive" | "active_foreign_company",
  ) {
    const companyId = randomUUID();
    const fallbackUserId = `fallback-${randomUUID()}`;
    const reviewerAgentId = randomUUID();
    const implementerAgentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const policy = normalizeIssueExecutionPolicy({
      stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewerAgentId }] }],
    })!;
    const stageId = policy.stages[0].id;

    await db.insert(companies).values({
      id: companyId,
      name: `Fallback ${membership}`,
      issuePrefix: `F${companyId.replaceAll("-", "").slice(0, 5).toUpperCase()}`,
      defaultResponsibleUserId: fallbackUserId,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: reviewerAgentId,
        companyId,
        name: "Fake Reviewer",
        role: "reviewer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: implementerAgentId,
        companyId,
        name: "Fake Implementer",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: reviewerAgentId,
      status: "running",
      invocationSource: "manual",
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: `Round cap ${membership}`,
      status: "in_review",
      priority: "medium",
      assigneeAgentId: reviewerAgentId,
      responsibleUserId: "local-board",
      createdByUserId: "local-board",
      checkoutRunId: runId,
      executionRunId: runId,
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerAgentId, userId: null },
        returnAssignee: { type: "agent", agentId: implementerAgentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: null,
        changesRequestedCount: 2,
      },
    });

    if (membership === "active_same_company" || membership === "inactive") {
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: fallbackUserId,
        membershipRole: "owner",
        status: membership === "active_same_company" ? "active" : "inactive",
      });
    } else if (membership === "active_foreign_company") {
      const foreignCompanyId = randomUUID();
      await db.insert(companies).values({
        id: foreignCompanyId,
        name: "Foreign fallback company",
        issuePrefix: `X${foreignCompanyId.replaceAll("-", "").slice(0, 5).toUpperCase()}`,
      });
      await db.insert(companyMemberships).values({
        companyId: foreignCompanyId,
        principalType: "user",
        principalId: fallbackUserId,
        membershipRole: "owner",
        status: "active",
      });
    }

    return { companyId, fallbackUserId, reviewerAgentId, implementerAgentId, runId, issueId };
  }

  it("passes an active same-company configured fallback through to sentinel escalation", async () => {
    const seeded = await seedReviewAtRoundCap("active_same_company");
    const response = await request(appForAgent(seeded.companyId, seeded.reviewerAgentId, seeded.runId))
      .patch(`/api/issues/${seeded.issueId}`)
      .send({ status: "in_progress", comment: "Third fake-agent review round" });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(issue).toMatchObject({
      status: "in_review",
      assigneeAgentId: null,
      assigneeUserId: seeded.fallbackUserId,
      executionState: {
        status: "pending",
        currentParticipant: { type: "user", userId: seeded.fallbackUserId },
        changesRequestedCount: 3,
      },
    });
  });

  it.each([
    ["missing membership", "missing"],
    ["inactive same-company membership", "inactive"],
    ["active foreign-company membership", "active_foreign_company"],
  ] as const)("does not turn a configured fallback with %s into a sticky human hold", async (_label, membership) => {
    const seeded = await seedReviewAtRoundCap(membership);
    const response = await request(appForAgent(seeded.companyId, seeded.reviewerAgentId, seeded.runId))
      .patch(`/api/issues/${seeded.issueId}`)
      .send({ status: "in_progress", comment: "Third fake-agent review round" });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(issue).toMatchObject({
      status: "in_progress",
      assigneeAgentId: seeded.implementerAgentId,
      assigneeUserId: null,
      executionState: {
        status: "changes_requested",
        currentParticipant: { type: "agent", agentId: seeded.reviewerAgentId },
        changesRequestedCount: 3,
      },
    });
    expect(issue.assigneeUserId).not.toBe(seeded.fallbackUserId);
    expect(JSON.stringify(issue.executionState)).not.toContain(seeded.fallbackUserId);
  });

  async function runGit(cwd: string, args: string[]) {
    await execFileAsync("git", ["-C", cwd, ...args], { cwd });
  }

  async function readGit(cwd: string, args: string[]) {
    const result = await execFileAsync("git", ["-C", cwd, ...args], { cwd });
    return result.stdout.trim();
  }

  async function snapshotGitState(worktreePath: string) {
    const [head, headRef, refs, status, diff, objects] = await Promise.all([
      readGit(worktreePath, ["rev-parse", "--verify", "HEAD"]),
      readGit(worktreePath, ["symbolic-ref", "--quiet", "HEAD"]),
      readGit(worktreePath, ["for-each-ref", "--sort=refname", "--format=%(refname)%09%(objectname)"]),
      readGit(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]),
      readGit(worktreePath, ["diff", "--binary", "HEAD", "--"]),
      readGit(worktreePath, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype) %(objectsize)"])
        .then((output) => output.split("\n").filter(Boolean).sort()),
    ]);
    return { head, headRef, refs, status, diff, objects };
  }

  it("rejects a reconciliation whose source issue belongs to another company without mutation", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-cross-company-reconcile-"));
    const worktreePath = path.join(path.dirname(repoRoot), `paperclip-cross-company-worktree-${randomUUID()}`);
    tempDirs.add(repoRoot);
    tempDirs.add(worktreePath);
    await runGit(repoRoot, ["init"]);
    await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
    await runGit(repoRoot, ["config", "user.email", "test@paperclip.invalid"]);
    await fs.writeFile(path.join(repoRoot, "README.md"), "base\n", "utf8");
    await runGit(repoRoot, ["add", "README.md"]);
    await runGit(repoRoot, ["commit", "-m", "base"]);
    await runGit(repoRoot, ["branch", "-M", "main"]);
    await runGit(repoRoot, ["branch", "feature/recorded"]);
    await runGit(repoRoot, ["worktree", "add", "-b", "feature/live", worktreePath, "feature/recorded"]);
    await fs.appendFile(path.join(worktreePath, "README.md"), "foreign-company dirty work\n", "utf8");

    const workspaceCompanyId = randomUUID();
    const sourceCompanyId = randomUUID();
    const projectId = randomUUID();
    const sourceIssueId = randomUUID();
    const workspaceId = randomUUID();
    await db.insert(companies).values([
      { id: workspaceCompanyId, name: "Workspace company", issuePrefix: "WSC" },
      { id: sourceCompanyId, name: "Source company", issuePrefix: "SRC" },
    ]);
    await db.insert(projects).values({
      id: projectId,
      companyId: workspaceCompanyId,
      name: "Workspace project",
      status: "in_progress",
    });
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId: sourceCompanyId,
      identifier: "SRC-1",
      title: "Foreign source issue",
      status: "blocked",
      priority: "medium",
    });
    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId: workspaceCompanyId,
      projectId,
      sourceIssueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "feature/recorded",
      status: "active",
      providerType: "git_worktree",
      cwd: worktreePath,
      providerRef: worktreePath,
      branchName: "feature/recorded",
      baseRef: "main",
    });

    const relevantCompanyIds = [workspaceCompanyId, sourceCompanyId];
    const snapshotRelevantRows = async () => ({
      issues: await db.select().from(issues).where(inArray(issues.companyId, relevantCompanyIds)).orderBy(issues.id),
      workspaces: await db.select().from(executionWorkspaces)
        .where(inArray(executionWorkspaces.companyId, relevantCompanyIds)).orderBy(executionWorkspaces.id),
      activity: await db.select().from(activityLog)
        .where(inArray(activityLog.companyId, relevantCompanyIds)).orderBy(activityLog.id),
      recovery: await db.select().from(issueRecoveryActions)
        .where(inArray(issueRecoveryActions.companyId, relevantCompanyIds)).orderBy(issueRecoveryActions.id),
      comments: await db.select().from(issueComments)
        .where(inArray(issueComments.companyId, relevantCompanyIds)).orderBy(issueComments.id),
      workspaceOperations: await db.select().from(workspaceOperations)
        .where(inArray(workspaceOperations.companyId, relevantCompanyIds)).orderBy(workspaceOperations.id),
    });
    const rowsBefore = await snapshotRelevantRows();
    const gitBefore = await snapshotGitState(worktreePath);

    let rejection: unknown = null;
    try {
      await executionWorkspaceService(db).reconcileExecutionWorkspaceBranch(workspaceId, {
        mode: "quarantine_restore",
        reason: "cross-company negative fixture",
        actor: { actorType: "user", actorId: "fake-operator", agentId: null, runId: null },
      });
    } catch (error) {
      rejection = error;
    }

    const rowsAfter = await snapshotRelevantRows();
    const gitAfter = await snapshotGitState(worktreePath);

    expect.soft(rejection).toMatchObject({ status: 404 });
    expect.soft(rowsAfter.issues).toStrictEqual(rowsBefore.issues);
    expect.soft(rowsAfter.workspaces).toStrictEqual(rowsBefore.workspaces);
    expect.soft(rowsAfter.activity).toStrictEqual(rowsBefore.activity);
    expect.soft(rowsAfter.recovery).toStrictEqual(rowsBefore.recovery);
    expect.soft(rowsAfter.comments).toStrictEqual(rowsBefore.comments);
    expect.soft(rowsAfter.workspaceOperations).toStrictEqual(rowsBefore.workspaceOperations);
    expect.soft(gitAfter.head).toBe(gitBefore.head);
    expect.soft(gitAfter.headRef).toBe(gitBefore.headRef);
    expect.soft(gitAfter.refs).toBe(gitBefore.refs);
    expect.soft(gitAfter.status).toBe(gitBefore.status);
    expect.soft(gitAfter.diff).toBe(gitBefore.diff);
    expect.soft(gitAfter.objects).toStrictEqual(gitBefore.objects);
  }, 20_000);
});
