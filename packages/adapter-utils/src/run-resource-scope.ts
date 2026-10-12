import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";

const defaults = { tasks: 2048, memory: 16 * 1024 ** 3 };

/**
 * SPA-11948. `scopedRunCommand` names every unit `paperclip-agent-<uuid>.scope`,
 * so the NAME carries no run identity — nothing can map a unit back to a run by
 * name. This pattern is the only thing that makes a unit ours at all: any other
 * `--user` scope on the same manager (a login session, another tool) must never
 * be enumerated, correlated or stopped by this reaper.
 */
const AGENT_SCOPE_UNIT_PATTERN = /^paperclip-agent-[0-9a-f]+\.scope$/;

export function isAgentRunScopeUnit(unit: string): boolean {
  return AGENT_SCOPE_UNIT_PATTERN.test(unit);
}

function limit(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error("invalid_run_resource_limit");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("invalid_run_resource_limit");
  return parsed;
}

export function scopedRunCommand(_runId: string, command: string, args: string[]) {
  if (process.platform !== "linux") return { command, args, unit: null, env: {} };
  const tasks = limit(process.env.PAPERCLIP_RUN_TASKS_MAX, defaults.tasks);
  const memory = limit(process.env.PAPERCLIP_RUN_MEMORY_MAX_BYTES, defaults.memory);
  const unit = `paperclip-agent-${randomUUID().replace(/-/g, "")}.scope`;
  const script = 'set -eu; group=$(cut -d: -f3 /proc/self/cgroup); case "$group" in *"/$PAPERCLIP_RESOURCE_UNIT") ;; *) exit 125;; esac; root="/sys/fs/cgroup$group"; test "$(cat "$root/pids.max")" = "$PAPERCLIP_RESOURCE_TASKS"; test "$(cat "$root/memory.max")" = "$PAPERCLIP_RESOURCE_MEMORY"; exec "$@"';
  return {
    command: "systemd-run",
    args: ["--user", "--scope", "--quiet", "--collect", `--unit=${unit}`, `--property=TasksMax=${tasks}`, `--property=MemoryMax=${memory}`, "--", "/bin/sh", "-c", script, "paperclip-run", command, ...args],
    unit,
    tasks,
    memory,
    env: { PAPERCLIP_RESOURCE_UNIT: unit, PAPERCLIP_RESOURCE_TASKS: String(tasks), PAPERCLIP_RESOURCE_MEMORY: String(memory) },
  };
}

export async function stopRunScope(unit: string | null): Promise<void> {
  if (!unit) return;
  await new Promise<void>((resolve, reject) => {
    const control = spawn("systemctl", ["--user", "stop", unit], { stdio: "ignore" });
    control.once("error", reject);
    control.once("close", (code) => code === 0 || code === 5 ? resolve() : reject(new Error(`run_scope_stop_failed:${code}`)));
  });
}

/**
 * One `running` run row, projected onto the only identity it persisted at spawn
 * time. A pid on its own is not an identity: the kernel recycles pids, so the
 * start instant recorded alongside it is what makes the pid safe to act on.
 */
export type StaleRunScopeCandidate = {
  runId: string;
  processPid: number | null;
  processGroupId: number | null;
  processStartedAt: string | null;
};

/** One `--user` scope unit as systemd reports it. */
export type AgentRunScopeUnit = {
  unit: string;
  /** systemd's MainPID; `0` once the scope leader has exited. */
  mainPid: number;
  /**
   * The unit's COMPLETE cgroup membership (`cgroup.procs`) — never a sample and
   * never a representative leader pid. A leader-only pid is not a tree.
   */
  controlGroupPids: number[];
};

export type ReconcileStaleRunScopesInput = {
  runs: StaleRunScopeCandidate[];
  /** Runs this engine instance owns: started here, or hot-restart adopted. */
  ownedRunIds: string[];
  listUnits: () => Promise<AgentRunScopeUnit[]>;
  /**
   * The start instant of a LIVE pid, or `null` when no such process exists.
   * `null` never authorizes a kill; it only means the pid path does not apply.
   */
  readProcessIdentity: (pid: number) => Promise<{ startedAt: string } | null>;
  /** Live members of a process group, for a unit whose leader already exited. */
  listGroupMembers: (pgid: number) => Promise<number[]>;
  stopUnit: (unit: string) => Promise<void>;
  killProcessTree: (pids: number[]) => void;
};

export type ReconcileStaleRunScopesResult = {
  /** Units stopped because they were stale and unowned. */
  units: string[];
  /** Runs whose whole tree was reaped, so their rows must leave `running`. */
  detachedRunIds: string[];
};

function toEpochMs(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** `true` for an integer pid / pgid that could name a real process. */
function isLiveProcessId(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Whether one run row claims one unit.
 *
 * Two paths, because either identity can be the only survivor:
 *
 *   pid path — the recorded pid is in the unit's COMPLETE membership, and when
 *     the row also recorded a start instant the live pid's start instant must
 *     equal it. A MISMATCH means the pid was recycled by an unrelated process:
 *     correlation for that run STOPS there, because a recorded pid that was
 *     recycled makes the recorded group exactly as untrustworthy, so the group
 *     path must not rescue it. A row with no recorded start instant (written
 *     before the identity was persisted) falls back to containment alone.
 *
 *   group path — systemd reports MainPID=0 once a scope leader exits while its
 *     cgroup members survive, and a leader pid recorded before the restart
 *     names a process that no longer exists. The recorded group is then the
 *     identity, and it claims the unit only when at least one LIVE member of
 *     that group is in the unit's complete membership.
 */
type RunUnitClaim = {
  members: Set<number>;
  /** A present recorded pid had a mismatched or unreadable start identity. */
  identityRejected: boolean;
};

async function runUnitClaim(
  run: StaleRunScopeCandidate,
  members: ReadonlySet<number>,
  input: Pick<
    ReconcileStaleRunScopesInput,
    "readProcessIdentity" | "listGroupMembers"
  >,
): Promise<RunUnitClaim> {
  const claimed = new Set<number>();

  if (isLiveProcessId(run.processPid) && members.has(run.processPid)) {
    if (run.processStartedAt !== null) {
      const live = await input
        .readProcessIdentity(run.processPid)
        .catch(() => null);
      const recorded = toEpochMs(run.processStartedAt);
      const observed = live === null ? null : toEpochMs(live.startedAt);
      if (recorded === null || observed === null || recorded !== observed) {
        // A present pid with the wrong (or unreadable) start identity may have
        // been recycled. The persisted group cannot rescue that row: doing so
        // would let a recycled leader authorize killing its new process tree.
        return { members: claimed, identityRejected: true };
      }
    }
    claimed.add(run.processPid);
  }

  if (isLiveProcessId(run.processGroupId)) {
    const groupMembers = await input
      .listGroupMembers(run.processGroupId)
      .catch(() => [] as number[]);
    for (const pid of groupMembers) {
      if (members.has(pid)) claimed.add(pid);
    }
  }

  return { members: claimed, identityRejected: false };
}

/**
 * SPA-11948. Reap the `paperclip-agent-*.scope` units a previous engine left
 * behind across a restart, and report the runs whose whole tree went with them.
 *
 * The reaper is deliberately unwilling. It stops a unit only when a run row
 * this engine does NOT own claims it, and only through the correlation rules in
 * `runUnitClaim`. Four refusals are load-bearing, because each one protects
 * live work from an unforced kill:
 *
 *   - a unit whose name is not ours is never selected for reconciliation;
 *   - a unit NO run row claims is skipped — stopping it would kill work the
 *     engine cannot attribute;
 *   - a unit with even one live member no run row claims is skipped WHOLE;
 *   - a unit claimed by an OWNED run as well is skipped WHOLE rather than
 *     resolved in favour of the reaper, because the shared cgroup would take
 *     adopted live work down with it.
 *
 * The unit is handed to `killProcessTree` as its COMPLETE cgroup membership
 * exactly as reported, because a leader-only pid is not a tree.
 */
export async function reconcileStaleRunScopes(
  input: ReconcileStaleRunScopesInput,
): Promise<ReconcileStaleRunScopesResult> {
  const owned = new Set(input.ownedRunIds);
  const enumerated = await input
    .listUnits()
    .catch(() => [] as AgentRunScopeUnit[]);
  const units: string[] = [];
  const detachedRunIds: string[] = [];

  for (const unit of enumerated) {
    if (!isAgentRunScopeUnit(unit.unit)) continue;
    const members = new Set(
      (unit.controlGroupPids ?? []).filter((pid) => Number.isInteger(pid) && pid > 0),
    );

    const claims: string[] = [];
    const attributedMembers = new Set<number>();
    let identityRejected = false;
    for (const run of input.runs) {
      const claim = await runUnitClaim(run, members, input);
      if (claim.identityRejected) identityRejected = true;
      if (claim.members.size === 0) continue;
      claims.push(run.runId);
      for (const pid of claim.members) attributedMembers.add(pid);
    }
    if (claims.length === 0 || identityRejected) continue;
    if (claims.some((runId) => owned.has(runId))) continue;
    // A scope is an indivisible kill boundary. If even one live cgroup member
    // cannot be attributed to a correlated run row, skip the WHOLE scope rather
    // than kill an unrelated process that happens to share the cgroup.
    if ([...members].some((pid) => !attributedMembers.has(pid))) continue;

    // Fail closed on the stop: a unit this pass could not stop is left for the
    // next pass rather than reported as reaped, so no run row is durably
    // detached behind a process that is still holding its cap slot.
    try {
      await input.stopUnit(unit.unit);
    } catch {
      continue;
    }
    input.killProcessTree([...members]);
    units.push(unit.unit);
    detachedRunIds.push(...claims);
  }

  return { units, detachedRunIds };
}

/** Run `systemctl --user` and capture stdout; rejects on any nonzero exit. */
async function readUserSystemctl(args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const control = spawn("systemctl", ["--user", ...args], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    control.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    control.once("error", reject);
    control.once("close", (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`run_scope_systemctl_failed:${code}`)),
    );
  });
}

function readSystemctlProperty(show: string, property: string): string | null {
  for (const line of show.split("\n")) {
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    if (line.slice(0, separator) !== property) continue;
    const value = line.slice(separator + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

/** The COMPLETE membership of a cgroup, read from its `cgroup.procs`. */
async function readCgroupProcs(controlGroup: string): Promise<number[]> {
  try {
    const raw = await fs.readFile(`/sys/fs/cgroup${controlGroup}/cgroup.procs`, "utf8");
    return raw
      .split("\n")
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

/**
 * Every live `paperclip-agent-*.scope` unit on this user's manager, with
 * systemd's MainPID and the unit's complete cgroup membership. Enumeration is
 * name-filtered BEFORE anything else, so a foreign scope is never correlated.
 * Any systemd/proc failure degrades to "cannot see it", never to "not there".
 */
export async function listAgentRunScopeUnits(): Promise<AgentRunScopeUnit[]> {
  if (process.platform !== "linux") return [];

  let listing: string;
  try {
    listing = await readUserSystemctl([
      "list-units",
      "--type=scope",
      "--all",
      "--no-legend",
      "--no-pager",
      "--plain",
    ]);
  } catch {
    return [];
  }

  const names = listing
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[0] ?? "")
    .filter((name) => name.length > 0 && isAgentRunScopeUnit(name));

  const units: AgentRunScopeUnit[] = [];
  for (const unit of names) {
    let show: string;
    try {
      show = await readUserSystemctl(["show", unit, "--no-pager"]);
    } catch {
      continue;
    }
    const controlGroup = readSystemctlProperty(show, "ControlGroup");
    const mainPid = Number.parseInt(readSystemctlProperty(show, "MainPID") ?? "", 10);
    if (!controlGroup || !Number.isInteger(mainPid) || mainPid < 0) continue;
    units.push({
      unit,
      mainPid,
      controlGroupPids: await readCgroupProcs(controlGroup),
    });
  }
  return units;
}

/**
 * The start instant of a LIVE pid, read from `/proc` exactly as the server's
 * `readProcessStartedAt` reads it, so the two seams answer the same identity
 * question. `null` means "no such process", never "assume it is ours".
 */
export async function readRunScopeProcessIdentity(
  pid: number,
): Promise<{ startedAt: string } | null> {
  try {
    const stat = await fs.stat(`/proc/${pid}`);
    return { startedAt: new Date(stat.ctimeMs).toISOString() };
  } catch {
    return null;
  }
}

/** Live members of a process group, read from the real process table. */
export async function listRunScopeGroupMembers(pgid: number): Promise<number[]> {
  const entries = await fs.readdir("/proc").catch(() => [] as string[]);
  const members: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = await fs.readFile(`/proc/${entry}/stat`, "utf8");
      // `comm` may contain spaces and parentheses, so parse after the LAST ')':
      // what follows is `state ppid pgrp session ...`.
      const commEnd = stat.lastIndexOf(")");
      if (commEnd < 0) continue;
      if (Number.parseInt(stat.slice(commEnd + 2).split(" ")[2] ?? "", 10) !== pgid) {
        continue;
      }
      members.push(Number.parseInt(entry, 10));
    } catch {
      // The process exited while the table was being scanned.
    }
  }
  return members;
}

/**
 * Signal EVERY reported member directly. The caller hands over the unit's
 * complete cgroup membership precisely so a single signal cannot be mistaken
 * for the whole tree.
 */
export function killRunScopeProcessTree(pids: number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone, or never ours to signal.
    }
  }
}
