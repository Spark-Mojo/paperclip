import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { assertReusableWorktreeSafe } from "../services/workspace-runtime.js";

const exec = promisify(execFile);
const roots: string[] = [];

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-reuse-gate-"));
  roots.push(root);
  await exec("git", ["init", root]);
  await exec("git", ["-C", root, "config", "user.name", "Test"]);
  await exec("git", ["-C", root, "config", "user.email", "test@example.com"]);
  await fs.writeFile(path.join(root, "tracked"), "before\n");
  await exec("git", ["-C", root, "add", "."]);
  await exec("git", ["-C", root, "commit", "-m", "initial"]);
  const { stdout } = await exec("git", ["-C", root, "rev-parse", "--absolute-git-dir"]);
  return { root, lock: path.join(stdout.trim(), "index.lock") };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("worktree reuse safety", () => {
  it("refuses a live Git process in the worktree without removing its lock", async () => {
    const { root, lock } = await fixture();
    await fs.writeFile(lock, "");
    const old = new Date(Date.now() - 660_000);
    await fs.utimes(lock, old, old);
    const writer = spawn("git", ["--no-pager", "hash-object", "--stdin"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    try {
      await new Promise<void>((resolve, reject) => {
        writer.once("spawn", resolve);
        writer.once("error", reject);
      });
      await expect(assertReusableWorktreeSafe(root)).rejects.toThrow(/live Git writer/);
      await expect(fs.stat(lock)).resolves.toBeDefined();
    } finally {
      writer.stdin.end();
      await new Promise((resolve) => writer.once("close", resolve));
    }
  });

  it("does not reclaim an aged lock held by a non-Git process", async () => {
    const { root, lock } = await fixture();
    await fs.writeFile(lock, "");
    const old = new Date(Date.now() - 660_000);
    await fs.utimes(lock, old, old);
    const holder = spawn("sh", ["-c", "exec 3<\"$1\"; exec sleep 30", "sh", lock], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    try {
      await new Promise<void>((resolve, reject) => {
        holder.once("spawn", resolve);
        holder.once("error", reject);
      });
      await expect(assertReusableWorktreeSafe(root)).rejects.toThrow(/holder could not be excluded/);
      await expect(fs.stat(lock)).resolves.toBeDefined();
    } finally {
      holder.kill();
      await new Promise((resolve) => holder.once("close", resolve));
    }
  });

  it("reclaims an aged empty unheld lock", async () => {
    const { root, lock } = await fixture();
    await fs.writeFile(lock, "");
    const old = new Date(Date.now() - 660_000);
    await fs.utimes(lock, old, old);
    await assertReusableWorktreeSafe(root);
    await expect(fs.stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  it("preserves tracked and untracked changes during aged lock reclaim", async () => {
    const { root, lock } = await fixture();
    await fs.writeFile(path.join(root, "tracked"), "after\n");
    await fs.writeFile(path.join(root, "untracked"), "keep\n");
    await fs.writeFile(lock, "");
    const old = new Date(Date.now() - 660_000);
    await fs.utimes(lock, old, old);
    await assertReusableWorktreeSafe(root);
    await expect(fs.stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(root, "tracked"), "utf8")).resolves.toBe("after\n");
    await expect(fs.readFile(path.join(root, "untracked"), "utf8")).resolves.toBe("keep\n");
  }, 60_000);

  it("rejects nonempty and young locks", async () => {
    const { root, lock } = await fixture();
    await fs.writeFile(lock, "writing");
    await expect(assertReusableWorktreeSafe(root)).rejects.toThrow(/unsafe Git index.lock/);
    await expect(fs.readFile(lock, "utf8")).resolves.toBe("writing");
    await fs.writeFile(lock, "");
    await expect(assertReusableWorktreeSafe(root)).rejects.toThrow(/unsafe Git index.lock/);
    await expect(fs.stat(lock)).resolves.toBeDefined();
  });
});
