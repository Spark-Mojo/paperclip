import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SRC = "server/src/services/heartbeat.ts";
const src = fs.readFileSync(SRC, "utf8");
if (src.includes('".paperclip-runtime", "detached-repositories", randomUUID()')) {
  console.log("IN-WORKTREE-RETENTION");
  process.exit(1);
}

const git = (dir, args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString();

const repo = await fsp.mkdtemp(path.join(os.tmpdir(), "spa12535-repo-"));
git(repo, ["init", "-q"]);
git(repo, ["config", "user.email", "probe@example.com"]);
git(repo, ["config", "user.name", "probe"]);
await fsp.writeFile(path.join(repo, "file.txt"), "hello\n");
git(repo, ["add", "."]);
git(repo, ["commit", "-qm", "init"]);

// New behavior: retain OUTSIDE the repo (rename out).
const stale = path.join(repo, "repos", "stale-dir");
await fsp.mkdir(stale, { recursive: true });
await fsp.writeFile(path.join(stale, "work.txt"), "work\n");
const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "spa12535-outside-"));
const retained = path.join(outside, "detached-repositories", "uuid-1");
await fsp.mkdir(path.dirname(retained), { recursive: true });
try {
  await fsp.rename(stale, retained);
} catch (err) {
  if (err?.code !== "EXDEV") throw err;
  await fsp.cp(stale, retained, { recursive: true });
  await fsp.rm(stale, { recursive: true, force: true });
}
const clean = git(repo, ["status", "--porcelain"]).trim();

// Counter-demo: retaining INSIDE the repo makes status dirty.
const inner = path.join(repo, ".paperclip-runtime", "detached-repositories", "uuid-2");
await fsp.mkdir(path.dirname(inner), { recursive: true });
await fsp.mkdir(path.join(repo, "repos", "other"), { recursive: true });
await fsp.writeFile(path.join(repo, "repos", "other", "w.txt"), "w\n");
await fsp.rename(path.join(repo, "repos", "other"), inner);
const dirty = git(repo, ["status", "--porcelain"]).trim();

if (clean === "" && dirty.includes(".paperclip-runtime/")) {
  console.log("RETAINED-OUTSIDE-WORKTREE");
  process.exit(0);
}
console.log(`unexpected clean=${JSON.stringify(clean)} dirty=${JSON.stringify(dirty)}`);
process.exit(1);
