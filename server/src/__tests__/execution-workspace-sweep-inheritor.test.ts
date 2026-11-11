import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  activityLog,
  companies,
  createDb,
  executionWorkspaces,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { executionWorkspaceService } from "../services/execution-workspaces.ts";
import { ensurePersistedExecutionWorkspaceAvailable } from "../services/workspace-runtime.ts";

const execFileAsync = promisify(execFile);

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping execution workspace sweep inheritor tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", ["-C", cwd, ...args], { cwd });
}

async function createTempRepo() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-sweep-inheritor-"));
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await runGit(repoRoot, ["config", "user.email", "test@paperclip.local"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "# Test repo\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "Initial commit"]);
  await runGit(repoRoot, ["branch", "-M", "main"]);
  return repoRoot;
}

describeEmbeddedPostgres("execution workspace sweep inheritor", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof executionWorkspaceService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempDirs = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-execution-workspace-sweep-inheritor-");
    db = createDb(tempDb.connectionString);
    svc = executionWorkspaceService(db, {
      resolvePullRequestDetails: vi.fn(async () => ({ state: "unknown", headRef: null, headSha: null })),
      workspaceReaperCooldownDays: 0,
    });
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAncestryTerminalWorkspace() {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const sourceIssueId = randomUUID();
    const issuePrefix = `P${companyId.slice(0, 8).toUpperCase()}`;
    const repoRoot = await createTempRepo();
    const worktreePath = path.join(path.dirname(repoRoot), `paperclip-inheritor-${randomUUID()}`);
    tempDirs.add(repoRoot);
    tempDirs.add(worktreePath);
    const branchName = `ancestry-${randomUUID().slice(0, 8)}`;
    await runGit(repoRoot, ["branch", branchName]);
    await runGit(repoRoot, ["worktree", "add", worktreePath, branchName]);
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Sweep inheritor",
      status: "in_progress",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: `${issuePrefix}-1`,
      status: "active",
      cwd: worktreePath,
      providerRef: worktreePath,
      providerType: "git_worktree",
      repoUrl: "https://github.com/paperclipai/paperclip.git",
      baseRef: "main",
      branchName,
    });
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      projectId,
      identifier: `${issuePrefix}-1`,
      title: "Delivered source issue",
      status: "done",
      priority: "medium",
      executionWorkspaceId,
    });
    await db
      .update(executionWorkspaces)
      .set({ sourceIssueId })
      .where(eq(executionWorkspaces.id, executionWorkspaceId));
    return { companyId, projectId, executionWorkspaceId, sourceIssueId };
  }

  it("leaves-shared-workspace-unarchived when a non-terminal separate-root inheritor shares the workspace", async () => {
    const control = await seedAncestryTerminalWorkspace();
    const shared = await seedAncestryTerminalWorkspace();
    const inheritorIssueId = randomUUID();
    const inheritorChildId = randomUUID();
    await db.insert(issues).values({
      id: inheritorIssueId,
      companyId: shared.companyId,
      projectId: shared.projectId,
      title: "Separate-root inheritor",
      status: "in_progress",
      priority: "medium",
      executionWorkspaceId: shared.executionWorkspaceId,
    });
    await db.insert(issues).values({
      id: inheritorChildId,
      companyId: shared.companyId,
      projectId: shared.projectId,
      parentId: inheritorIssueId,
      title: "Inheritor child",
      status: "in_progress",
      priority: "medium",
      executionWorkspaceId: shared.executionWorkspaceId,
    });

    const sweep = await svc.sweepTerminalWorkspaces();
    const rows = await db
      .select({
        id: executionWorkspaces.id,
        status: executionWorkspaces.status,
        closedAt: executionWorkspaces.closedAt,
      })
      .from(executionWorkspaces)
      .where(inArray(executionWorkspaces.id, [control.executionWorkspaceId, shared.executionWorkspaceId]));
    const byId = new Map(rows.map((row) => [row.id, row]));

    // Control: a fully-terminal ancestry workspace still archives, so the
    // fixture and the reaper are capable of archiving.
    expect(byId.get(control.executionWorkspaceId)?.status).toBe("archived");
    // Only the control archives; the shared workspace has a live inheritor.
    expect(sweep.archived).toBe(1);
    expect(byId.get(shared.executionWorkspaceId)?.status).toBe("active");
    expect(byId.get(shared.executionWorkspaceId)?.closedAt).toBeNull();
  }, 20_000);

  it("archived-workspace-setup names the workspace id and closed state instead of bare setup_failed", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const activeWorkspaceId = randomUUID();
    const archivedWorkspaceId = randomUUID();
    const archivedClosedAt = new Date("2026-05-23T20:00:00.000Z");
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `P${companyId.slice(0, 8).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Archived setup",
      status: "in_progress",
    });
    const activeCwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-active-setup-"));
    tempDirs.add(activeCwd);
    await db.insert(executionWorkspaces).values({
      id: activeWorkspaceId,
      companyId,
      projectId,
      mode: "isolated_workspace",
      strategyType: "project_primary",
      name: "active-workspace",
      status: "active",
      providerType: "local_fs",
      cwd: activeCwd,
    });
    // The archived worktree path stays absent from disk: the reaper removes
    // the archived worktree (see the rebuild comment in execution-workspaces
    // setup), so a setup lookup against this row mirrors production.
    const archivedCwd = path.join(os.tmpdir(), `paperclip-archived-setup-${randomUUID()}`);
    await db.insert(executionWorkspaces).values({
      id: archivedWorkspaceId,
      companyId,
      projectId,
      mode: "isolated_workspace",
      strategyType: "project_primary",
      name: "archived-workspace",
      status: "archived",
      closedAt: archivedClosedAt,
      cleanupReason: "issue_terminal",
      providerType: "local_fs",
      cwd: archivedCwd,
    });

    // Negative control: an active row restores through the real setup
    // lookup path, so restoring the archived row below exercises the same
    // seam. A setup path that reuses/resolves this workspace must surface
    // the archived id and its closed state — never a bare null with no id.
    const activeRestore = await ensurePersistedExecutionWorkspaceAvailable({
      db,
      base: {
        baseCwd: activeCwd,
        source: "task_session",
        projectId,
        workspaceId: null,
        repoUrl: null,
        repoRef: null,
      },
      workspace: {
        id: activeWorkspaceId,
        mode: "isolated_workspace",
        strategyType: "project_primary",
        cwd: activeCwd,
        providerRef: activeCwd,
        projectId,
        projectWorkspaceId: null,
        repoUrl: "https://github.com/paperclipai/paperclip.git",
        baseRef: "main",
        branchName: null,
        metadata: null,
        config: null,
      },
      issue: { id: randomUUID(), identifier: null, title: "Active setup probe" },
      agent: { id: null, name: "Agent", companyId },
    }).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
    expect(activeRestore).not.toBeNull();
    expect(activeRestore).not.toBeInstanceOf(Error);

    // Non-terminal inheritor still linked to the archived row: a setup path
    // that reuses/resolves this workspace must surface the archived id and
    // its closed state — never a bare null/skipped outcome with no id.
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      projectId,
      title: "Non-terminal inheritor of archived workspace",
      status: "in_progress",
      priority: "medium",
      executionWorkspaceId: archivedWorkspaceId,
    });

    // Automation/heartbeat setup against the archived row: drive the REAL
    // setup lookup path the setup calls (the same function heartbeat setup
    // invokes via ensurePersistedExecutionWorkspaceAvailable), capture the
    // REAL throw/return, and assert it surfaces the workspace id plus its
    // closed state.
    const archivedRow = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, archivedWorkspaceId))
      .then((rows) => rows[0] ?? null);
    expect(archivedRow?.status).toBe("archived");
    const setup = await ensurePersistedExecutionWorkspaceAvailable({
      db,
      base: {
        baseCwd: archivedRow?.cwd ?? "",
        source: "task_session",
        projectId,
        workspaceId: null,
        repoUrl: null,
        repoRef: null,
      },
      workspace: {
        id: archivedWorkspaceId,
        mode: archivedRow?.mode ?? "isolated_workspace",
        strategyType: archivedRow?.strategyType ?? "project_primary",
        cwd: archivedRow?.cwd ?? "/tmp/paperclip-archived-setup",
        providerRef: archivedRow?.providerRef ?? "/tmp/paperclip-archived-setup",
        projectId,
        projectWorkspaceId: archivedRow?.projectWorkspaceId ?? null,
        repoUrl: archivedRow?.repoUrl ?? null,
        baseRef: archivedRow?.baseRef ?? null,
        branchName: archivedRow?.branchName ?? null,
        metadata: (archivedRow?.metadata as Record<string, unknown> | null) ?? null,
        config: null,
      },
      issue: { id: randomUUID(), identifier: null, title: "Non-terminal inheritor run" },
      agent: { id: null, name: "Agent", companyId },
    }).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
    const surfaced = setup === null ? "null" : setup instanceof Error ? setup.message : JSON.stringify(setup);

    expect(surfaced).toContain(archivedWorkspaceId);
    expect(surfaced).toMatch(/archived|closed/);
  }, 20_000);
});
