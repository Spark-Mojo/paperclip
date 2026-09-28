import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const HEARTBEAT_RUN_SCRATCH_MARKER = ".paperclip-run-scratch.json";

// SPA-9270: orphaned scratch sweep bound. A scratch dir whose marker is older
// than this is eligible for orphan cleanup even when its owning run row is
// missing entirely; it also bounds the pid-recycling window for kill(-pgid).
export const RUN_SCRATCH_ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface HeartbeatRunScratchMetadata {
  version: 1;
  companyId: string;
  agentId: string;
  runId: string;
  issueId: string | null;
  issueIdentifier: string | null;
  createdAt: string;
}

export interface HeartbeatRunScratch {
  dir: string;
  markerPath: string;
  metadata: HeartbeatRunScratchMetadata;
}

export interface HeartbeatRunScratchEnvResult {
  env: Record<string, string>;
  tempKeysApplied: string[];
}

export type HeartbeatRunScratchCleanupResult =
  | { removed: true; dir: string }
  | { removed: false; dir: string; reason: "missing" | "unmarked" | "owner_mismatch" | "process_group_alive" };

const TEMP_ENV_KEYS = ["TMPDIR", "TEMP", "TMP"] as const;
const ISSUE_SEGMENT_MAX_CHARS = 32;

function sanitizePathSegment(value: string | null | undefined, fallback: string): string {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, ISSUE_SEGMENT_MAX_CHARS)
    .replace(/[.-]+$/g, "");
  return normalized || fallback;
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function readMarker(markerPath: string): Promise<HeartbeatRunScratchMetadata | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(markerPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const rec = parsed as Record<string, unknown>;
    if (
      rec.version !== 1 ||
      typeof rec.companyId !== "string" ||
      typeof rec.agentId !== "string" ||
      typeof rec.runId !== "string" ||
      typeof rec.createdAt !== "string"
    ) {
      return null;
    }
    return {
      version: 1,
      companyId: rec.companyId,
      agentId: rec.agentId,
      runId: rec.runId,
      issueId: typeof rec.issueId === "string" ? rec.issueId : null,
      issueIdentifier: typeof rec.issueIdentifier === "string" ? rec.issueIdentifier : null,
      createdAt: rec.createdAt,
    };
  } catch {
    return null;
  }
}

export async function prepareHeartbeatRunScratch(input: {
  companyId: string;
  agentId: string;
  runId: string;
  issueId?: string | null;
  issueIdentifier?: string | null;
  now?: Date;
}): Promise<HeartbeatRunScratch> {
  const issueSegment = sanitizePathSegment(input.issueIdentifier, "unassigned");
  const runSegment = sanitizePathSegment(input.runId.slice(0, 12), "run");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `paperclip-run-${issueSegment}-${runSegment}-`));
  const markerPath = path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER);
  const metadata: HeartbeatRunScratchMetadata = {
    version: 1,
    companyId: input.companyId,
    agentId: input.agentId,
    runId: input.runId,
    issueId: input.issueId ?? null,
    issueIdentifier: input.issueIdentifier ?? null,
    createdAt: (input.now ?? new Date()).toISOString(),
  };
  await fs.writeFile(markerPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  return { dir, markerPath, metadata };
}

export function buildHeartbeatRunScratchEnv(
  existingEnv: Record<string, unknown>,
  scratch: HeartbeatRunScratch,
): HeartbeatRunScratchEnvResult {
  const env: Record<string, string> = {
    PAPERCLIP_RUN_SCRATCH_DIR: scratch.dir,
    PAPERCLIP_TASK_SCRATCH_DIR: scratch.dir,
    PAPERCLIP_SCRATCH_DIR: scratch.dir,
    PAPERCLIP_TMPDIR: scratch.dir,
  };
  const tempKeysApplied: string[] = [];
  for (const key of TEMP_ENV_KEYS) {
    const existing = existingEnv[key];
    if (typeof existing === "string" && existing.trim().length > 0) continue;
    env[key] = scratch.dir;
    tempKeysApplied.push(key);
  }
  return { env, tempKeysApplied };
}

export async function cleanupHeartbeatRunScratch(input: {
  scratch: HeartbeatRunScratch;
  processGroupId?: number | null;
  isProcessGroupAlive?: (processGroupId: number | null | undefined) => boolean;
}): Promise<HeartbeatRunScratchCleanupResult> {
  const tmpRoot = path.resolve(os.tmpdir());
  const dir = path.resolve(input.scratch.dir);
  if (!isPathInside(tmpRoot, dir) || !path.basename(dir).startsWith("paperclip-run-")) {
    return { removed: false, dir, reason: "unmarked" };
  }
  try {
    const stats = await fs.stat(dir);
    if (!stats.isDirectory()) return { removed: false, dir, reason: "missing" };
  } catch {
    return { removed: false, dir, reason: "missing" };
  }

  const marker = await readMarker(path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER));
  if (!marker) return { removed: false, dir, reason: "unmarked" };
  if (
    marker.companyId !== input.scratch.metadata.companyId ||
    marker.agentId !== input.scratch.metadata.agentId ||
    marker.runId !== input.scratch.metadata.runId
  ) {
    return { removed: false, dir, reason: "owner_mismatch" };
  }
  if (input.isProcessGroupAlive?.(input.processGroupId) === true) {
    return { removed: false, dir, reason: "process_group_alive" };
  }

  await fs.rm(dir, { recursive: true, force: true });
  return { removed: true, dir };
}

export interface OrphanedRunScratchSweepResult {
  swept: number;
  killedProcessGroups: number;
  removedDirs: number;
  skipped: number;
  errors: number;
}

/**
 * SPA-9270 fix 3: sweep orphaned run scratch directories and the process
 * trees still living under them. A cancelled run whose process tree escaped
 * the termination path leaves descendants reparented to the init system with
 * TMPDIR still pointing inside the run's scratch dir; nothing else reaps
 * them. This sweep runs at server startup and on the periodic scheduler
 * tick. It is filesystem-driven (the run row is often already terminal, so
 * the DB cannot enumerate the leak) but DB-guarded: a scratch dir is only
 * reclaimed when its owning run row is terminal or missing, or when the
 * marker itself is older than the orphan age bound. A live run's scratch
 * tree — including a live process group — is never touched.
 */
export async function sweepOrphanedRunScratch(input: {
  tmpRoot?: string;
  now?: Date;
  isProcessGroupAlive?: (processGroupId: number | null | undefined) => boolean;
  killProcessGroup?: (processGroupId: number) => void;
  loadRun: (runId: string) => Promise<
    | { status: string; processGroupId: number | null; processPid: number | null }
    | null
  >;
}): Promise<OrphanedRunScratchSweepResult> {
  const tmpRoot = path.resolve(input.tmpRoot ?? os.tmpdir());
  const now = input.now ?? new Date();
  const isProcessGroupAlive =
    input.isProcessGroupAlive ?? (() => false);
  const killProcessGroup =
    input.killProcessGroup ??
    ((pgid: number) => {
      try {
        process.kill(-pgid, "SIGTERM");
      } catch {
        // Already gone or not ours.
      }
    });

  const entries = await fs.readdir(tmpRoot, { withFileTypes: true }).catch(() => []);
  const result: OrphanedRunScratchSweepResult = {
    swept: 0,
    killedProcessGroups: 0,
    removedDirs: 0,
    skipped: 0,
    errors: 0,
  };

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("paperclip-run-")) continue;
    const dir = path.join(tmpRoot, entry.name);
    result.swept += 1;
    try {
      const marker = await readMarker(path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER));
      if (!marker) {
        // No marker: not a run scratch dir (or already wiped); leave it to
        // the OS tmp reaper rather than deleting unknown content.
        result.skipped += 1;
        continue;
      }
      const run = await input.loadRun(marker.runId).catch(() => null);
      const markerAgeMs =
        now.getTime() - (Date.parse(marker.createdAt) || 0);
      const runTerminal = !!run && !["queued", "running", "scheduled_retry"].includes(run.status);
      const runMissing = !run;
      const agedOut =
        !Number.isNaN(markerAgeMs) && markerAgeMs > RUN_SCRATCH_ORPHAN_MAX_AGE_MS;
      if (!runTerminal && !runMissing && !agedOut) {
        result.skipped += 1;
        continue;
      }

      // Kill the surviving process tree when one is still attributable. Only
      // a process group recorded on the (terminal/missing) run row counts —
      // never a group guessed from the filesystem.
      const processGroupId = run?.processGroupId ?? null;
      if (processGroupId && isProcessGroupAlive(processGroupId)) {
        killProcessGroup(processGroupId);
        result.killedProcessGroups += 1;
      }

      await fs.rm(dir, { recursive: true, force: true });
      result.removedDirs += 1;
    } catch {
      result.errors += 1;
    }
  }

  return result;
}
