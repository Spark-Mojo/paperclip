import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertReusableWorktreeSafe, WorkspaceRuntimeValidationFailure } from "../services/workspace-runtime.js";
import { withWorktreeGitLease } from "../services/worktree-git-lease.js";

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
  it.skipIf(process.env.PAPERCLIP_REUSE_GATE_NEGATIVE !== "1")("negative control: live writer must not pass the reuse assertion", async () => {
    const { root, lock } = await fixture();
    await fs.writeFile(lock, "");
    const old = new Date(Date.now() - 660_000);
    await fs.utimes(lock, old, old);
    const holder = spawn("sh", ["-c", "exec 3<\"$1\"; exec sleep 30", "sh", lock], { cwd: root, stdio: "ignore" });
    try {
      await new Promise<void>((resolve, reject) => { holder.once("spawn", resolve); holder.once("error", reject); });
      await assertReusableWorktreeSafe(root);
    } finally {
      holder.kill();
      await new Promise<void>((resolve) => { if (holder.exitCode !== null || holder.signalCode !== null) resolve(); else holder.once("close", () => resolve()); });
    }
  });

  it.each(["EACCES", "EPERM"])("skips a foreign Git PID whose fd scan returns %s", async (code) => {
    const { root } = await fixture();
    const writer = spawn("git", ["--no-pager", "hash-object", "--stdin"], { cwd: os.tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      writer.once("spawn", resolve);
      writer.once("error", reject);
    });
    const stat = fs.stat.bind(fs);
    const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (target, options) => {
      const result = await stat(target, options as never);
      if (String(target) === `/proc/${writer.pid}`) return Object.assign(Object.create(Object.getPrototypeOf(result)), result, { uid: (process.getuid?.() ?? 0) + 1 });
      return result;
    });
    try {
      await expect(assertReusableWorktreeSafe(root)).resolves.toBeUndefined();
    } finally {
      statSpy.mockRestore();
      writer.stdin.end();
      await new Promise((resolve) => writer.once("close", resolve));
    }
  });

  it.each(["EACCES", "EPERM"])("refuses a same-UID Git PID whose fd scan returns %s", async (code) => {
    const { root } = await fixture();
    const writer = spawn("git", ["--no-pager", "hash-object", "--stdin"], { cwd: os.tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      writer.once("spawn", resolve);
      writer.once("error", reject);
    });
    const readdir = fs.readdir.bind(fs);
    const readdirSpy = vi.spyOn(fs, "readdir").mockImplementation(async (target, options) => {
      if (String(target) === `/proc/${writer.pid}/fd`) throw Object.assign(new Error("process fd scan unavailable"), { code });
      return readdir(target, options as never);
    });
    try {
      await expect(assertReusableWorktreeSafe(root)).rejects.toMatchObject({ code });
    } finally {
      readdirSpy.mockRestore();
      writer.stdin.end();
      await new Promise((resolve) => writer.once("close", resolve));
    }
  });

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

  it("rejects an aged lock held by a renamed process", async () => {
    const { root, lock } = await fixture();
    await fs.writeFile(lock, "");
    const old = new Date(Date.now() - 660_000);
    await fs.utimes(lock, old, old);
    const holder = spawn("bash", ["-c", "exec -a renamed-writer sh -c 'exec 3<\"$1\"; exec sleep 30' sh \"$1\"", "bash", lock], { cwd: root, stdio: "ignore" });
    try {
      await new Promise<void>((resolve, reject) => { holder.once("spawn", resolve); holder.once("error", reject); });
      await expect(assertReusableWorktreeSafe(root)).rejects.toThrow(/holder could not be excluded/);
      await expect(fs.stat(lock)).resolves.toBeDefined();
    } finally {
      holder.kill();
      await new Promise<void>((resolve) => { if (holder.exitCode !== null || holder.signalCode !== null) resolve(); else holder.once("close", () => resolve()); });
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

  it("serializes an engine Git scan against reclaim and permits nested acquisition", async () => {
    const { root, lock } = await fixture();
    await fs.writeFile(lock, "");
    const old = new Date(Date.now() - 660_000);
    await fs.utimes(lock, old, old);
    let unlock!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { unlock = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const writer = withWorktreeGitLease(root, async () => {
      entered();
      await withWorktreeGitLease(root, async () => held);
    });
    await started;
    const reclaim = assertReusableWorktreeSafe(root);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(fs.stat(lock)).resolves.toBeDefined();
    unlock();
    await writer;
    await reclaim;
    await expect(fs.stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  it("does not reuse a released lease inherited by a detached child", async () => {
    const { root } = await fixture();
    let resume!: () => void;
    let child!: Promise<void>;
    const suspended = new Promise<void>((resolve) => { resume = resolve; });
    await withWorktreeGitLease(root, async () => {
      child = suspended.then(() => withWorktreeGitLease(root, async () => {
        await fs.writeFile(path.join(root, "child"), "written");
      }));
    });
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const exclusive = withWorktreeGitLease(root, async () => { entered(); await held; }, true);
    await started;
    resume();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(fs.stat(path.join(root, "child"))).rejects.toMatchObject({ code: "ENOENT" });
    release();
    await exclusive;
    await child;
    await expect(fs.readFile(path.join(root, "child"), "utf8")).resolves.toBe("written");
  });

  it("recovers from a lease timeout only after the holder has finished", async () => {
    const { root } = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const holder = withWorktreeGitLease(root, async () => { entered(); await held; });
    await started;
    try {
      await expect(withWorktreeGitLease(root, async () => undefined, true, 10)).rejects.toThrow(/Timed out waiting/);
      await expect(withWorktreeGitLease(root, async () => undefined)).rejects.toThrow(/lease timed out/);
    } finally {
      release();
      await holder;
    }
    await expect(withWorktreeGitLease(root, async () => "recovered")).resolves.toBe("recovered");
  });

  it("refuses non-Linux reuse with a typed validation reason without touching the lock", async () => {
    const { root, lock } = await fixture();
    await fs.writeFile(lock, "");
    const old = new Date(Date.now() - 660_000);
    await fs.utimes(lock, old, old);
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    if (!platform) throw new Error("process.platform descriptor unavailable");
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    try {
      await expect(assertReusableWorktreeSafe(root)).rejects.toMatchObject({
        code: "workspace_validation_failed",
        resultJson: { workspaceValidation: { reason: "live_git_writer_probe_unavailable", worktreePath: root } },
      } satisfies Partial<WorkspaceRuntimeValidationFailure>);
      await expect(fs.stat(lock)).resolves.toBeDefined();
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

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
