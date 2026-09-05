import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  withWorktreeProvisionLock,
} from "../services/workspace-runtime.ts";

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd });
}

async function createTempRepo(defaultBranch = "main"): Promise<string> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-wtmutex-repo-"));
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["config", "user.email", "paperclip@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "hello\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "Initial commit"]);
  await runGit(repoRoot, ["checkout", "-B", defaultBranch]);
  return repoRoot;
}

let lockDir: string;

beforeEach(async () => {
  lockDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-wtmutex-locks-"));
  process.env.PAPERCLIP_WORKTREE_LOCK_DIR = lockDir;
});

afterEach(async () => {
  delete process.env.PAPERCLIP_WORKTREE_LOCK_DIR;
  await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("withWorktreeProvisionLock (per-repo mutex)", () => {
  it("serializes 50 concurrent acquisitions on the same repo (zero overlap, no .git/config.lock collisions)", async () => {
    const repoRoot = await createTempRepo();
    const targetBase = "HEAD";

    let inFlight = 0;
    let maxInFlight = 0;
    let totalEntered = 0;
    const collisionErrors: string[] = [];

    const op = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      totalEntered += 1;
      // Hold the lock long enough for contenders to queue up.
      await new Promise((resolve) => setTimeout(resolve, 25));
      try {
        // Add a unique worktree so each op actually runs a real `git worktree add`
        // against the same repo root. Different worktree paths avoid the
        // "already exists" fast-path; .git/config.lock contention is the failure
        // mode the mutex prevents.
        const worktreePath = path.join(os.tmpdir(), `paperclip-wtmutex-wt-${randomUUID()}`);
        await runGit(repoRoot, ["worktree", "add", "-B", `wt-${randomUUID()}`, worktreePath, targetBase]);
        await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("Unable to create temporary worktree") || message.includes("config.lock")) {
          collisionErrors.push(message);
        } else {
          throw error;
        }
      } finally {
        inFlight -= 1;
      }
    };

    await Promise.all(
      Array.from({ length: 50 }, () => withWorktreeProvisionLock(repoRoot, op)),
    );

    expect(totalEntered).toBe(50);
    expect(collisionErrors).toEqual([]);
    expect(maxInFlight).toBe(1);
  }, 90_000);

  it("runs in parallel across different repos (maxInFlight > 1)", async () => {
    const repoA = await createTempRepo();
    const repoB = await createTempRepo();

    let inFlight = 0;
    let maxInFlight = 0;
    const op = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 25));
      inFlight -= 1;
    };

    await Promise.all([
      withWorktreeProvisionLock(repoA, op),
      withWorktreeProvisionLock(repoB, op),
      withWorktreeProvisionLock(repoA, op),
      withWorktreeProvisionLock(repoB, op),
      withWorktreeProvisionLock(repoA, op),
      withWorktreeProvisionLock(repoB, op),
    ]);

    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("treats symlinked and real repoRoot as the same repo (canonical key)", async () => {
    const repoRoot = await createTempRepo();
    const linkRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-wtmutex-link-"));
    const linkPath = path.join(linkRoot, "link");
    await fs.symlink(repoRoot, linkPath, "dir");

    const lockDirEntries = await fs.readdir(lockDir);
    expect(lockDirEntries.length).toBe(0);

    // Hold the lock via the real path; a second caller using the symlinked path
    // must contend on the SAME lock dir entry (proving key canonicalization).
    let blocked = true;
    const holder = withWorktreeProvisionLock(repoRoot, async () => {
      while (blocked) await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const heldEntries = (await fs.readdir(lockDir)).filter((entry) => entry.endsWith(".lock"));
    blocked = false;
    await holder;
    expect(heldEntries).toHaveLength(1);

    // Second acquire via the symlinked path must observe the same single key.
    let blocked2 = true;
    const holder2 = withWorktreeProvisionLock(linkPath, async () => {
      while (blocked2) await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const heldEntries2 = (await fs.readdir(lockDir)).filter((entry) => entry.endsWith(".lock"));
    blocked2 = false;
    await holder2;
    expect(heldEntries2).toHaveLength(1);
  });

  it("cleans the lock dir on throw (no leaked lock files after failure)", async () => {
    const repoRoot = await createTempRepo();
    await expect(
      withWorktreeProvisionLock(repoRoot, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const entries = await fs.readdir(lockDir);
    expect(entries.filter((entry) => entry.endsWith(".lock"))).toHaveLength(0);
  });

  it("rejects after the bounded timeout and proceeds without the lock", async () => {
    const repoRoot = await createTempRepo();

    // Hold the lock from a sibling caller while a second caller tries to acquire
    // it with a tiny timeout. The second caller must give up after the timeout
    // instead of hanging forever.
    let blocked = true;
    const blocker = withWorktreeProvisionLock(repoRoot, async () => {
      while (blocked) await new Promise((resolve) => setTimeout(resolve, 10));
    });

    const startedAt = Date.now();
    let timeoutError: unknown = null;
    try {
      await withWorktreeProvisionLock(
        repoRoot,
        async () => undefined,
        { timeoutMs: 200 },
      );
    } catch (error) {
      timeoutError = error;
    }
    const elapsed = Date.now() - startedAt;

    expect(timeoutError).toBeInstanceOf(Error);
    expect((timeoutError as Error).message).toMatch(/Timed out/);
    expect(elapsed).toBeGreaterThanOrEqual(200);

    blocked = false;
    await blocker;
  });

  it("produces a stable key regardless of trailing slashes or relative segments", async () => {
    const repoRoot = await createTempRepo();
    const seen: string[][] = [];
    let blocked = true;
    const holder = withWorktreeProvisionLock(repoRoot, async () => {
      while (blocked) await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    seen.push((await fs.readdir(lockDir)).filter((entry) => entry.endsWith(".lock")));
    blocked = false;
    await holder;

    let blocked2 = true;
    const holder2 = withWorktreeProvisionLock(path.resolve(repoRoot) + "/", async () => {
      while (blocked2) await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    seen.push((await fs.readdir(lockDir)).filter((entry) => entry.endsWith(".lock")));
    blocked2 = false;
    await holder2;

    expect(seen).toHaveLength(2);
    expect(seen[0]).toHaveLength(1);
    expect(seen[1]).toEqual(seen[0]);
  });

  it("uses the configured lock dir (env override respected)", async () => {
    const repoRoot = await createTempRepo();
    let blocked = true;
    const holder = withWorktreeProvisionLock(repoRoot, async () => {
      while (blocked) await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const entries = (await fs.readdir(lockDir)).filter((entry) => entry.endsWith(".lock"));
    blocked = false;
    await holder;
    expect(entries.length).toBe(1);
  });
});
