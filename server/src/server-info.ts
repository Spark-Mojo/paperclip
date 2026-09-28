import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ServerGitInfo, ServerGitLocalChanges, ServerInfoSnapshot } from "@paperclipai/shared";
import { parseBuildCommit, readBuildCommit } from "./build-commit.js";

export type { ServerGitInfo, ServerInfoSnapshot };

const execFileAsync = promisify(execFile);

type GitCommand = () => Promise<string>;
type BuildCommitCommand = () => string | null;

const SHORT_SHA_RE = /^[0-9a-f]{7,40}$/i;

// SPA-9270 fix 4: git reads run OFF the request path. The previous
// implementation called execFileSync three times per TTL refresh directly
// inside request handling; on a saturated disk each call blocked the entire
// event loop for up to its 1.5s timeout, so /api/health and every other
// request stalled 4-5s while the process stayed "healthy". The async
// commands below spawn git without blocking, and a background refresh keeps
// the module cache warm. getServerInfoSnapshot stays synchronous: it only
// reads the cache, which is seeded from the static build commit at boot.
async function defaultGitCommand() {
  const { stdout } = await execFileAsync(
    "git",
    ["show", "-s", "--format=%H%n%h%n%s%n%cI", "HEAD"],
    {
      encoding: "utf8",
      timeout: 1500,
    },
  );
  return stdout;
}

async function defaultGitStatusCommand() {
  const { stdout } = await execFileAsync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=normal"],
    {
      encoding: "utf8",
      timeout: 1500,
    },
  );
  return stdout;
}

async function defaultGitBranchCommand() {
  const { stdout } = await execFileAsync(
    "git",
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    {
      encoding: "utf8",
      timeout: 1500,
    },
  );
  return stdout;
}

function parseGitLocalChanges(output: string): ServerGitLocalChanges {
  let stagedFileCount = 0;
  let unstagedFileCount = 0;
  let untrackedFileCount = 0;

  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const indexStatus = line[0] ?? " ";
    const worktreeStatus = line[1] ?? " ";

    if (indexStatus === "?" && worktreeStatus === "?") {
      untrackedFileCount += 1;
      continue;
    }
    if (indexStatus !== " " && indexStatus !== "?") stagedFileCount += 1;
    if (worktreeStatus !== " " && worktreeStatus !== "?") unstagedFileCount += 1;
  }

  return {
    available: true,
    hasLocalChanges: stagedFileCount + unstagedFileCount + untrackedFileCount > 0,
    stagedFileCount,
    unstagedFileCount,
    untrackedFileCount,
  };
}

function getGitLocalChanges(output: string): ServerGitLocalChanges {
  try {
    return parseGitLocalChanges(output);
  } catch {
    return { available: false, unavailableReason: "git_status_unavailable" };
  }
}

function parseGitInfo(
  output: string,
  branchName: string | null,
  localChanges: ServerGitLocalChanges,
): ServerGitInfo {
  const [fullSha = "", shortSha = "", subject = "", committedAt = ""] = output
    .trimEnd()
    .split("\n");
  const parsedFullSha = parseBuildCommit(fullSha);
  const committedAtTime = Date.parse(committedAt);

  if (!parsedFullSha || !SHORT_SHA_RE.test(shortSha)) {
    return { available: false, unavailableReason: "invalid_git_metadata" };
  }

  return {
    available: true,
    fullSha: parsedFullSha,
    shortSha,
    branchName,
    subject: subject.trim() || "No commit subject",
    committedAt: Number.isNaN(committedAtTime) ? null : new Date(committedAtTime).toISOString(),
    localChanges,
  };
}

function buildCommitFallback(buildCommitCommand: BuildCommitCommand): ServerGitInfo {
  const buildCommit = parseBuildCommit(buildCommitCommand());
  if (!buildCommit) {
    return { available: false, unavailableReason: "git_unavailable" };
  }

  return {
    available: true,
    fullSha: buildCommit,
    shortSha: buildCommit.slice(0, 7),
    branchName: null,
    subject: "Source build",
    committedAt: null,
    localChanges: {
      available: false,
      unavailableReason: "git_status_unavailable",
    },
  };
}

async function readGitInfo(
  gitCommand: GitCommand,
  gitStatusCommand: GitCommand,
  gitBranchCommand: GitCommand,
  buildCommitCommand: BuildCommitCommand,
): Promise<ServerGitInfo> {
  let output: string;
  try {
    output = await gitCommand();
  } catch {
    return buildCommitFallback(buildCommitCommand);
  }
  let localChanges: ServerGitLocalChanges;
  try {
    localChanges = parseGitLocalChanges(await gitStatusCommand());
  } catch {
    localChanges = { available: false, unavailableReason: "git_status_unavailable" };
  }
  let branchName: string | null = null;
  try {
    branchName = (await gitBranchCommand()).trim() || null;
  } catch {
    branchName = null;
  }
  const parsed = parseGitInfo(output, branchName, localChanges);
  if (!parsed.available) return buildCommitFallback(buildCommitCommand);
  return parsed;
}

export async function createServerInfoSnapshot(
  opts: {
    now?: Date;
    gitCommand?: GitCommand;
    gitStatusCommand?: GitCommand;
    gitBranchCommand?: GitCommand;
    buildCommitCommand?: BuildCommitCommand;
  } = {},
): Promise<ServerInfoSnapshot> {
  return {
    processStartedAt: (opts.now ?? new Date()).toISOString(),
    git: await readGitInfo(
      opts.gitCommand ?? defaultGitCommand,
      opts.gitStatusCommand ?? defaultGitStatusCommand,
      opts.gitBranchCommand ?? defaultGitBranchCommand,
      opts.buildCommitCommand ?? readBuildCommit,
    ),
  };
}

// processStartedAt is a true boot constant, but the running commit can change
// without the Node process restarting: a managed dev-server restart re-runs
// the code while keeping this module alive, so a commit captured once at boot
// goes stale. A background refresh loop re-reads git HEAD asynchronously and
// updates this cache; request handling only READS the cache and never spawns
// git itself (SPA-9270 fix 4).
const GIT_INFO_REFRESH_INTERVAL_MS = 3_000;
const processStartedAt = new Date().toISOString();
let gitInfoCache: ServerGitInfo | null = null;

async function refreshGitInfoCache(): Promise<void> {
  gitInfoCache = await readGitInfo(
    defaultGitCommand,
    defaultGitStatusCommand,
    defaultGitBranchCommand,
    readBuildCommit,
  );
}

// Seed the cache synchronously from the static build commit so the first
// request never sees an empty snapshot, then keep it warm in the background.
gitInfoCache = buildCommitFallback(readBuildCommit);
const gitInfoRefreshTimer = setInterval(() => {
  void refreshGitInfoCache().catch(() => undefined);
}, GIT_INFO_REFRESH_INTERVAL_MS);
gitInfoRefreshTimer.unref?.();

/** Test seam: run one explicit refresh cycle (async git reads). */
export async function refreshServerInfoForTests(
  opts: {
    gitCommand?: GitCommand;
    gitStatusCommand?: GitCommand;
    gitBranchCommand?: GitCommand;
    buildCommitCommand?: BuildCommitCommand;
  } = {},
): Promise<void> {
  gitInfoCache = await readGitInfo(
    opts.gitCommand ?? defaultGitCommand,
    opts.gitStatusCommand ?? defaultGitStatusCommand,
    opts.gitBranchCommand ?? defaultGitBranchCommand,
    opts.buildCommitCommand ?? readBuildCommit,
  );
}

export function getServerInfoSnapshot(): ServerInfoSnapshot {
  return { processStartedAt, git: gitInfoCache ?? buildCommitFallback(readBuildCommit) };
}

export function resetServerInfoCacheForTests(): void {
  gitInfoCache = buildCommitFallback(readBuildCommit);
}
