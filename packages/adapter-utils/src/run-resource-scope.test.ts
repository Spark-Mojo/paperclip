import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import * as runResourceScope from "./run-resource-scope.js";

const runScopeApi = runResourceScope as unknown as Record<string, unknown>;

/**
 * SPA-11948 R1 — the stale-run-scope reconciliation contract this card
 * specifies.
 *
 * Declared LOCALLY rather than imported from `./run-resource-scope.js`. The
 * production export does not exist yet, and a type-only import of a missing
 * member is a hard tests-only-commit `tsc` failure. Declaring the shape here
 * keeps the file typechecking while still specifying the API precisely: the
 * tests drive the real implementation through the namespace cast above, so a
 * missing export surfaces as ONE precise assertion failure
 * (`missing_run_scope_api:reconcileStaleRunScopes`) rather than a module link
 * error that would take every other case in the file down with it.
 *
 * ## What a reaper is allowed to kill
 *
 * `systemd-run --scope` unit names are random (`paperclip-agent-<uuid>.scope`),
 * so NOTHING maps a unit back to a run by name. The only correlation available
 * is (a) the unit's COMPLETE cgroup membership and (b) the pid / pgid / start
 * instant the run row persisted at spawn time. A unit is claimed by a run only
 * when every one of these holds:
 *
 *   pid path — the run records `processPid`, that pid is a member of the unit's
 *              COMPLETE cgroup membership, and — when the run also recorded a
 *              `processStartedAt` — the live pid's start instant equals it. A
 *              MISMATCH means the pid was recycled by an unrelated process, and
 *              correlation for that run STOPS there: the recorded group is just
 *              as untrustworthy as the recorded pid, so the group path must not
 *              rescue it. A run with no recorded `processStartedAt` (a row
 *              written before the identity was persisted) falls back to cgroup
 *              containment alone.
 *
 *   group path — systemd reports MainPID=0 once a scope leader exits while
 *              cgroup members survive, and a leader pid recorded before the
 *              restart names a process that no longer exists. The run's
 *              recorded `processGroupId` is then the identity, and it claims
 *              the unit only when at least one LIVE member of that group
 *              (`listGroupMembers`) is in the unit's complete membership.
 *
 * A reaped unit is handed to `killProcessTree` as its COMPLETE cgroup
 * membership exactly as reported — every live member, never a single
 * representative pid — because a leader-only pid is not a tree.
 *
 * Anything this engine still owns — adopted across the restart, or present in
 * the live registry — is never claimed, and an AMBIGUOUS unit (one that an
 * owned and an unowned run both claim) is skipped WHOLE rather than resolved in
 * favour of the reaper. A unit no run row claims is skipped too: stopping it
 * would be an unforced kill of live work the engine cannot attribute.
 *
 * ## Oracles
 *
 * Every fixture below is a REAL leader plus a REAL descendant sharing one real
 * process group, and every "the tree died" assertion is made against the
 * DESCENDANT. A leader-only pid is never a complete tree: a kill seam that
 * stopped at the direct pid would pass a fixture that never happened in
 * production. The descendant's pid and start instant are the process's own
 * self-reported identity, captured from the fixture itself, and
 * `readProcessIdentity` is the injectable seam that answers "what is the start
 * instant of the live pid N?" — injected so PID reuse is a deterministic,
 * first-class case instead of a race nobody can reproduce.
 *
 * systemd scope units and `/proc` are Linux-only concepts, hence the platform
 * gate on the whole suite.
 */
type StaleRunScopeCandidate = {
  runId: string;
  /** The pid the engine recorded at spawn time; `null` once it is unknown. */
  processPid: number | null;
  /** The process group the run's tree leads, when one was recorded. */
  processGroupId: number | null;
  /**
   * The start instant of the recorded pid, as persisted at spawn time; `null`
   * when the row predates it. This is what makes a recycled pid safe to refuse.
   */
  processStartedAt: string | null;
};

/** One `--user` unit as `systemctl list-units` reports it. */
type ScopeUnit = {
  unit: string;
  /** systemd's MainPID; `0` once the scope leader has exited. */
  mainPid: number;
  /** The unit's COMPLETE cgroup membership (`cgroup.procs`), not a sample. */
  controlGroupPids: number[];
};

type ReconcileStaleRunScopesInput = {
  runs: StaleRunScopeCandidate[];
  /** Runs this engine instance owns — started here, or hot-restart adopted. */
  ownedRunIds: string[];
  listUnits: () => Promise<ScopeUnit[]>;
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

type ReconcileStaleRunScopesResult = {
  /** Units stopped because they were stale and unowned. */
  units: string[];
  /** Runs marked durable-detached because their tree was reaped. */
  detachedRunIds: string[];
};

type ReconcileStaleRunScopes = (
  input: ReconcileStaleRunScopesInput,
) => Promise<ReconcileStaleRunScopesResult>;

/**
 * Fixture processes and directories are tracked at module scope so a
 * vitest-level timeout — which kills a test WITHOUT unwinding its `finally` —
 * still cannot strand a detached child. The `afterEach` sweep is the backstop
 * for that path; the per-test `finally` is the fast path.
 */
const scopeFixturePids = new Set<number>();
const scopeFixtureDirs = new Set<string>();

afterEach(() => {
  for (const pid of scopeFixturePids) {
    killProcessTree([pid]);
  }
  scopeFixturePids.clear();
  for (const dir of scopeFixtureDirs) {
    void fs.rm(dir, { recursive: true, force: true });
  }
  scopeFixtureDirs.clear();
});

type ScopeTree = {
  child: ChildProcess;
  /** The unit's MainPID while the leader lives; the pgid either way. */
  leaderPid: number;
  groupId: number;
  /** A REAL descendant in the same process group — the process-tree oracle. */
  descendantPid: number;
  leaderStartedAt: string;
  descendantStartedAt: string;
};

/**
 * Spawns a real, killable process GROUP standing in for a live adapter child
 * inside a `paperclip-agent-*.scope` unit.
 *
 * The leader is spawned detached, so it leads its own process group exactly
 * like `scopedRunCommand` does, and it forks one descendant that is NOT
 * detached — so the descendant joins the leader's group and a group kill
 * reaches it while a bare-leader kill does not. Both processes report their own
 * `{ pid, startedAt }` to disk, which is the only identity that survives the
 * wrapper and the only way the test can name the descendant deterministically.
 *
 * `leaderExits` models the restart shape systemd reports as MainPID=0: the
 * leader is gone, the orphaned descendant still holds the group.
 */
async function spawnScopeTree(
  input: { leaderExits?: boolean } = {},
): Promise<ScopeTree> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "spa-11948-scope-"));
  scopeFixtureDirs.add(dir);
  const leaderFile = path.join(dir, "leader.json");
  const descendantFile = path.join(dir, "descendant.json");

  const descendantScript = [
    "const fs = require('node:fs');",
    "const startedAt = new Date().toISOString();",
    `fs.writeFileSync(${JSON.stringify(descendantFile)}, JSON.stringify({ pid: process.pid, startedAt }));`,
    "setInterval(() => {}, 1000);",
  ].join(" ");

  const leaderScript = [
    "const { spawn } = require('node:child_process');",
    // Not detached: the descendant inherits the leader's process group.
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { stdio: 'ignore' });`,
    "const fs = require('node:fs');",
    "const startedAt = new Date().toISOString();",
    `fs.writeFileSync(${JSON.stringify(leaderFile)}, JSON.stringify({ pid: process.pid, startedAt }));`,
    input.leaderExits === true
      ? "setTimeout(() => process.exit(0), 25);"
      : "setInterval(() => {}, 1000);",
  ].join(" ");

  const child = spawn(process.execPath, ["-e", leaderScript], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  const leaderPid = child.pid ?? 0;
  if (leaderPid <= 0) throw new Error("scope_fixture_leader_not_started");
  scopeFixturePids.add(leaderPid);

  const [leader, descendant] = await Promise.all([
    readSelfReportedIdentity(leaderFile),
    readSelfReportedIdentity(descendantFile),
  ]);
  scopeFixturePids.add(descendant.pid);

  return {
    child,
    leaderPid,
    groupId: leaderPid,
    descendantPid: descendant.pid,
    leaderStartedAt: leader.startedAt,
    descendantStartedAt: descendant.startedAt,
  };
}

async function readSelfReportedIdentity(
  file: string,
  timeoutMs = 10_000,
): Promise<{ pid: number; startedAt: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8")) as {
        pid?: unknown;
        startedAt?: unknown;
      };
      const pid = typeof parsed.pid === "number" ? parsed.pid : Number.NaN;
      const startedAt = typeof parsed.startedAt === "string" ? parsed.startedAt : "";
      if (pid > 0 && startedAt) return { pid, startedAt };
    } catch {
      // Not written (or still being written) yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`scope_fixture_identity_never_written:${file}`);
}

/**
 * Live members of a process group, read from the REAL process table
 * (`/proc/<pid>/stat`, field `pgrp`). This is the oracle behind the injectable
 * group lookup: the leader-dead case can only claim to be exercised if the
 * group genuinely still has a surviving member while systemd reports MainPID=0.
 */
async function listProcGroupMembers(pgid: number): Promise<number[]> {
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
      const fields = stat.slice(commEnd + 2).split(" ");
      if (Number.parseInt(fields[2] ?? "", 10) !== pgid) continue;
      members.push(Number.parseInt(entry, 10));
    } catch {
      // The process exited while the table was being scanned.
    }
  }
  return members;
}

/**
 * The injectable "what is the start instant of the live pid N?" seam, answered
 * from the ground truth the fixtures reported about themselves. An unknown pid
 * answers `null`, which is exactly the "no such live process" case a real
 * `/proc` read produces.
 */
function makeProcessIdentityReader(known: ReadonlyMap<number, string>) {
  return async (pid: number): Promise<{ startedAt: string } | null> => {
    const startedAt = known.get(pid);
    return startedAt === undefined ? null : { startedAt };
  };
}

function isPidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isPidAlive(pid);
}

/**
 * Scope unit names are random (`paperclip-agent-<uuid hex>.scope`), so nothing
 * can map a unit back to a run by name. The only correlation available is the
 * unit's MainPID plus its complete cgroup member list, which is what these
 * fixtures model.
 */
function agentScopeUnit() {
  return `paperclip-agent-${randomUUID().replace(/-/g, "")}.scope`;
}

function foreignScopeUnit() {
  return `session-${randomUUID().replace(/-/g, "")}.scope`;
}

function killProcessTree(pids: number[]) {
  for (const pid of pids) {
    try {
      process.kill(-pid, "SIGKILL");
      continue;
    } catch {
      // Not a process group leader; fall through to the direct pid.
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already dead.
    }
  }
}

/**
 * Production kill seam for the reconciliation tests: signal EVERY pid directly.
 * A representative leader pid cannot kill its descendant through this seam, so
 * the descendant liveness assertions prove that the reconciler supplied the
 * unit's complete cgroup membership rather than relying on a group-side effect.
 */
function killEveryReportedPid(pids: number[]) {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already dead.
    }
  }
}

function releaseFixtures(...trees: ScopeTree[]) {
  for (const tree of trees) {
    // The group kill reaches the descendant too; both pids are also tracked
    // module-side so the `afterEach` sweep can finish the job.
    if (isPidAlive(tree.descendantPid)) killProcessTree([tree.descendantPid]);
    if (isPidAlive(tree.leaderPid)) killProcessTree([tree.leaderPid]);
    try {
      tree.child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

describe.skipIf(process.platform !== "linux")(
  "agent run scope reconciliation (SPA-11948)",
  () => {
    it("reaps a stale agent scope by its complete process tree and leaves an adopted and a foreign scope untouched", async () => {
      const reconcile = runScopeApi.reconcileStaleRunScopes as
        | ReconcileStaleRunScopes
        | undefined;
      expect(
        typeof reconcile,
        "missing_run_scope_api:reconcileStaleRunScopes",
      ).toBe("function");

      // A scope left across a restart: the child is still alive and its run row
      // is still `running`, but this engine instance never started it.
      const orphan = await spawnScopeTree();
      // A scope this engine still owns (started here, or explicitly adopted by
      // the hot-restart path). Reaping it would kill live work.
      const adopted = await spawnScopeTree();
      // A non-Paperclip unit that shares the user manager. The reaper must not
      // touch it.
      const foreign = await spawnScopeTree();

      const orphanUnit = agentScopeUnit();
      const adoptedUnit = agentScopeUnit();
      const foreignUnit = foreignScopeUnit();
      const orphanRunId = randomUUID();
      const adoptedRunId = randomUUID();
      const foreignRunId = randomUUID();
      const stoppedUnits: string[] = [];
      const killedPids: number[] = [];

      try {
        const reconciliation = await reconcile!({
          runs: [
            {
              runId: orphanRunId,
              processPid: orphan.leaderPid,
              processGroupId: orphan.groupId,
              processStartedAt: orphan.leaderStartedAt,
            },
            {
              runId: adoptedRunId,
              processPid: adopted.leaderPid,
              processGroupId: adopted.groupId,
              processStartedAt: adopted.leaderStartedAt,
            },
            {
              // Deliberately correlates to a NON-Paperclip scope. Name filtering,
              // not lack of a run match, is what must preserve this unit.
              runId: foreignRunId,
              processPid: foreign.leaderPid,
              processGroupId: foreign.groupId,
              processStartedAt: foreign.leaderStartedAt,
            },
          ],
          ownedRunIds: [adoptedRunId],
          listUnits: async () => [
            {
              unit: orphanUnit,
              mainPid: orphan.leaderPid,
              controlGroupPids: [orphan.leaderPid, orphan.descendantPid],
            },
            {
              unit: adoptedUnit,
              mainPid: adopted.leaderPid,
              controlGroupPids: [adopted.leaderPid, adopted.descendantPid],
            },
            {
              unit: foreignUnit,
              mainPid: foreign.leaderPid,
              controlGroupPids: [foreign.leaderPid, foreign.descendantPid],
            },
          ],
          readProcessIdentity: makeProcessIdentityReader(
            new Map([
              [orphan.leaderPid, orphan.leaderStartedAt],
              [adopted.leaderPid, adopted.leaderStartedAt],
              [foreign.leaderPid, foreign.leaderStartedAt],
            ]),
          ),
          listGroupMembers: (pgid) => listProcGroupMembers(pgid),
          stopUnit: async (unit: string) => {
            stoppedUnits.push(unit);
          },
          killProcessTree: (pids: number[]) => {
            killedPids.push(...pids);
            killEveryReportedPid(pids);
          },
        });

        expect(reconciliation.units).toEqual([orphanUnit]);
        expect(stoppedUnits).toEqual([orphanUnit]);
        expect(reconciliation.detachedRunIds).toEqual([orphanRunId]);

        // The seam is addressed by the unit's COMPLETE membership, and the
        // DESCENDANT is the oracle: the descendant the leader forked is what
        // actually has to be gone, which a direct-leader-pid kill never achieves.
        expect([...killedPids].sort((a, b) => a - b)).toEqual(
          [orphan.leaderPid, orphan.descendantPid].sort((a, b) => a - b),
        );
        expect(
          await waitForPidExit(orphan.descendantPid),
          "stale_scope_descendant_survived_the_reaper",
        ).toBe(true);
        expect(await waitForPidExit(orphan.leaderPid)).toBe(true);

        // Intentional hot-restart adoption and the foreign unit survive whole.
        expect(killedPids).not.toContain(adopted.leaderPid);
        expect(killedPids).not.toContain(adopted.descendantPid);
        expect(killedPids).not.toContain(foreign.leaderPid);
        expect(killedPids).not.toContain(foreign.descendantPid);
        expect(isPidAlive(adopted.descendantPid)).toBe(true);
        expect(isPidAlive(foreign.descendantPid)).toBe(true);
      } finally {
        releaseFixtures(orphan, adopted, foreign);
      }
    }, 20_000);

    it("reaps a stale agent scope whose systemd MainPID is 0 by correlating the orphaned descendant through the recorded process group", async () => {
      const reconcile = runScopeApi.reconcileStaleRunScopes as
        | ReconcileStaleRunScopes
        | undefined;
      expect(
        typeof reconcile,
        "missing_run_scope_api:reconcileStaleRunScopes",
      ).toBe("function");

      // The leader exits while its descendant survives in the group: exactly
      // what systemd reports as MainPID=0, and the shape a MainPID-only or
      // leader-only reaper silently skips.
      const stale = await spawnScopeTree({ leaderExits: true });
      const staleUnit = agentScopeUnit();
      const staleRunId = randomUUID();
      const stoppedUnits: string[] = [];
      const killedPids: number[] = [];

      try {
        // Preconditions asserted against the REAL process table, so the group
        // path below can never pass vacuously: the leader really is gone, the
        // descendant really is alive, and the run's recorded process group
        // really still has that descendant as a live member.
        expect(
          await waitForPidExit(stale.leaderPid),
          "stale_scope_leader_must_exit_before_the_group_path_is_exercised",
        ).toBe(true);
        expect(isPidAlive(stale.descendantPid)).toBe(true);
        expect(await listProcGroupMembers(stale.groupId)).toContain(
          stale.descendantPid,
        );

        const reconciliation = await reconcile!({
          runs: [
            // No usable leader pid survived the restart: only the recorded
            // process group identifies the tree, so the group lookup is what
            // makes this correlation implementable rather than aspirational.
            {
              runId: staleRunId,
              processPid: null,
              processGroupId: stale.groupId,
              processStartedAt: null,
            },
          ],
          ownedRunIds: [],
          listUnits: async () => [
            {
              unit: staleUnit,
              mainPid: 0,
              controlGroupPids: [stale.descendantPid],
            },
          ],
          readProcessIdentity: makeProcessIdentityReader(new Map()),
          listGroupMembers: (pgid) => listProcGroupMembers(pgid),
          stopUnit: async (unit: string) => {
            stoppedUnits.push(unit);
          },
          killProcessTree: (pids: number[]) => {
            killedPids.push(...pids);
            killEveryReportedPid(pids);
          },
        });

        expect(reconciliation.units).toEqual([staleUnit]);
        expect(stoppedUnits).toEqual([staleUnit]);
        expect(reconciliation.detachedRunIds).toEqual([staleRunId]);
        // The complete membership of a leaderless unit is its surviving
        // member, and that member is what dies.
        expect(killedPids).toEqual([stale.descendantPid]);
        expect(
          await waitForPidExit(stale.descendantPid),
          "leaderless_stale_scope_descendant_survived_the_reaper",
        ).toBe(true);
      } finally {
        releaseFixtures(stale);
      }
    }, 20_000);

    it("leaves a live agent scope alone when no run row correlates to it", async () => {
      const reconcile = runScopeApi.reconcileStaleRunScopes as
        | ReconcileStaleRunScopes
        | undefined;
      expect(
        typeof reconcile,
        "missing_run_scope_api:reconcileStaleRunScopes",
      ).toBe("function");

      // Two real units: one that correlates cleanly to an unowned run row, and
      // one that correlates to nothing at all. The first proves the pass is not
      // vacuous; the second is the case under test.
      const unowned = await spawnScopeTree();
      const unmatched = await spawnScopeTree();

      const unownedUnit = agentScopeUnit();
      const unmatchedUnit = agentScopeUnit();
      const unownedRunId = randomUUID();
      const stoppedUnits: string[] = [];
      const killedPids: number[] = [];

      try {
        const reconciliation = await reconcile!({
          runs: [
            {
              runId: unownedRunId,
              processPid: unowned.leaderPid,
              processGroupId: unowned.groupId,
              processStartedAt: unowned.leaderStartedAt,
            },
          ],
          ownedRunIds: [],
          listUnits: async () => [
            {
              unit: unownedUnit,
              mainPid: unowned.leaderPid,
              controlGroupPids: [unowned.leaderPid, unowned.descendantPid],
            },
            {
              unit: unmatchedUnit,
              mainPid: unmatched.leaderPid,
              controlGroupPids: [unmatched.leaderPid, unmatched.descendantPid],
            },
          ],
          readProcessIdentity: makeProcessIdentityReader(
            new Map([
              [unowned.leaderPid, unowned.leaderStartedAt],
              [unmatched.leaderPid, unmatched.leaderStartedAt],
            ]),
          ),
          listGroupMembers: (pgid) => listProcGroupMembers(pgid),
          stopUnit: async (unit: string) => {
            stoppedUnits.push(unit);
          },
          killProcessTree: (pids: number[]) => {
            killedPids.push(...pids);
            killEveryReportedPid(pids);
          },
        });

        // Control: the cleanly-correlated unowned scope IS reaped, so a
        // pass-through implementation cannot satisfy this file.
        expect(reconciliation.units).toContain(unownedUnit);
        expect(reconciliation.detachedRunIds).toContain(unownedRunId);
        expect(await waitForPidExit(unowned.descendantPid)).toBe(true);

        // The case under test: with no run row naming it, stopping the unit
        // would be an unforced kill of live work the engine cannot attribute.
        expect(reconciliation.units).not.toContain(unmatchedUnit);
        expect(stoppedUnits).not.toContain(unmatchedUnit);
        expect(killedPids).not.toContain(unmatched.leaderPid);
        expect(killedPids).not.toContain(unmatched.descendantPid);
        expect(isPidAlive(unmatched.descendantPid)).toBe(true);
      } finally {
        releaseFixtures(unowned, unmatched);
      }
    }, 20_000);

    it("skips an ambiguous correlation that would put an owned scope at risk", async () => {
      const reconcile = runScopeApi.reconcileStaleRunScopes as
        | ReconcileStaleRunScopes
        | undefined;
      expect(
        typeof reconcile,
        "missing_run_scope_api:reconcileStaleRunScopes",
      ).toBe("function");

      // `unshared` correlates to exactly one run row, which this engine does
      // NOT own: the safe reap. It is the control that keeps this case from
      // passing vacuously.
      const unshared = await spawnScopeTree();
      // `ownedChild` is named by a run this engine owns.
      const ownedTree = await spawnScopeTree();
      // `unownedChild` is named by an unowned run row — but it also shares a
      // cgroup with `ownedChild`, so the owning row claims this unit too.
      const unownedTree = await spawnScopeTree();

      const sharedUnit = agentScopeUnit();
      const unsharedUnit = agentScopeUnit();
      const ownedRunId = randomUUID();
      const unownedRunId = randomUUID();
      const unsharedRunId = randomUUID();
      const stoppedUnits: string[] = [];
      const killedPids: number[] = [];
      // The COMPLETE membership of the shared unit, leaders and descendants
      // alike: a reaper that only inspects MainPID would never see the conflict.
      const sharedMembers = [
        ownedTree.leaderPid,
        ownedTree.descendantPid,
        unownedTree.leaderPid,
        unownedTree.descendantPid,
      ];

      try {
        const reconciliation = await reconcile!({
          runs: [
            {
              runId: ownedRunId,
              processPid: ownedTree.leaderPid,
              processGroupId: ownedTree.groupId,
              processStartedAt: ownedTree.leaderStartedAt,
            },
            {
              runId: unownedRunId,
              processPid: unownedTree.leaderPid,
              processGroupId: unownedTree.groupId,
              processStartedAt: unownedTree.leaderStartedAt,
            },
            {
              runId: unsharedRunId,
              processPid: unshared.leaderPid,
              processGroupId: unshared.groupId,
              processStartedAt: unshared.leaderStartedAt,
            },
          ],
          ownedRunIds: [ownedRunId],
          listUnits: async () => [
            // MainPID 0 so correlation must come from the full cgroup member
            // list, and BOTH trees land in this one unit.
            { unit: sharedUnit, mainPid: 0, controlGroupPids: sharedMembers },
            {
              unit: unsharedUnit,
              mainPid: unshared.leaderPid,
              controlGroupPids: [unshared.leaderPid, unshared.descendantPid],
            },
          ],
          readProcessIdentity: makeProcessIdentityReader(
            new Map([
              [ownedTree.leaderPid, ownedTree.leaderStartedAt],
              [unownedTree.leaderPid, unownedTree.leaderStartedAt],
              [unshared.leaderPid, unshared.leaderStartedAt],
            ]),
          ),
          listGroupMembers: (pgid) => listProcGroupMembers(pgid),
          stopUnit: async (unit: string) => {
            stoppedUnits.push(unit);
          },
          killProcessTree: (pids: number[]) => {
            killedPids.push(...pids);
            killEveryReportedPid(pids);
          },
        });

        // Control: an unambiguous unowned scope is still reaped.
        expect(reconciliation.units).toContain(unsharedUnit);
        expect(reconciliation.detachedRunIds).toContain(unsharedRunId);
        expect(await waitForPidExit(unshared.descendantPid)).toBe(true);

        // The case under test: the shared unit is claimed by an owned run, so
        // reaping it would kill live adopted work. Both the stop and the kill
        // must be withheld, and NO member pid of the shared unit may be touched
        // — not the leaders and not either descendant.
        expect(reconciliation.units).not.toContain(sharedUnit);
        expect(stoppedUnits).not.toContain(sharedUnit);
        for (const pid of sharedMembers) {
          expect(killedPids, `shared_scope_member_${pid}_was_signalled`).not.toContain(pid);
          expect(isPidAlive(pid), `shared_scope_member_${pid}_was_killed`).toBe(true);
        }
      } finally {
        releaseFixtures(unshared, ownedTree, unownedTree);
      }
    }, 20_000);

    it("refuses to reap a scope whose recorded process identity no longer matches the live pid", async () => {
      const reconcile = runScopeApi.reconcileStaleRunScopes as
        | ReconcileStaleRunScopes
        | undefined;
      expect(
        typeof reconcile,
        "missing_run_scope_api:reconcileStaleRunScopes",
      ).toBe("function");

      // `reused` is a LIVE pid that is no longer the process the run recorded:
      // the run's process died, the kernel recycled the pid, and an unrelated
      // process now owns it. Signalling it would be an unforced kill.
      const reused = await spawnScopeTree();
      // Two controls that keep this case from passing by skipping everything:
      // `verified` records the live pid's true start instant, and `unstamped`
      // records none at all (a row written before the identity was persisted),
      // so both fall through to cgroup containment and must still be reaped.
      const verified = await spawnScopeTree();
      const unstamped = await spawnScopeTree();

      const reusedUnit = agentScopeUnit();
      const verifiedUnit = agentScopeUnit();
      const unstampedUnit = agentScopeUnit();
      const reusedRunId = randomUUID();
      const verifiedRunId = randomUUID();
      const unstampedRunId = randomUUID();
      // The stamp the run persisted belongs to a process that no longer exists,
      // so it can never equal the live pid's real start instant.
      const recycledPidStamp = new Date(
        Date.parse(reused.leaderStartedAt) - 3_600_000,
      ).toISOString();
      const stoppedUnits: string[] = [];
      const killedPids: number[] = [];

      try {
        expect(recycledPidStamp).not.toBe(reused.leaderStartedAt);

        const reconciliation = await reconcile!({
          runs: [
            {
              runId: reusedRunId,
              processPid: reused.leaderPid,
              processGroupId: reused.groupId,
              processStartedAt: recycledPidStamp,
            },
            {
              runId: verifiedRunId,
              processPid: verified.leaderPid,
              processGroupId: verified.groupId,
              processStartedAt: verified.leaderStartedAt,
            },
            {
              runId: unstampedRunId,
              processPid: unstamped.leaderPid,
              processGroupId: unstamped.groupId,
              processStartedAt: null,
            },
          ],
          ownedRunIds: [],
          listUnits: async () => [
            {
              unit: reusedUnit,
              mainPid: reused.leaderPid,
              controlGroupPids: [reused.leaderPid, reused.descendantPid],
            },
            {
              unit: verifiedUnit,
              mainPid: verified.leaderPid,
              controlGroupPids: [verified.leaderPid, verified.descendantPid],
            },
            {
              unit: unstampedUnit,
              mainPid: unstamped.leaderPid,
              controlGroupPids: [unstamped.leaderPid, unstamped.descendantPid],
            },
          ],
          readProcessIdentity: makeProcessIdentityReader(
            new Map([
              [reused.leaderPid, reused.leaderStartedAt],
              [verified.leaderPid, verified.leaderStartedAt],
              [unstamped.leaderPid, unstamped.leaderStartedAt],
            ]),
          ),
          listGroupMembers: (pgid) => listProcGroupMembers(pgid),
          stopUnit: async (unit: string) => {
            stoppedUnits.push(unit);
          },
          killProcessTree: (pids: number[]) => {
            killedPids.push(...pids);
            killEveryReportedPid(pids);
          },
        });

        // Controls: an identity-verified scope and an unstamped-but-contained
        // scope are both reaped, so the refusal below is the identity gate and
        // not a blanket skip.
        expect(reconciliation.units).toEqual(
          expect.arrayContaining([verifiedUnit, unstampedUnit]),
        );
        expect(killedPids).toContain(verified.descendantPid);
        expect(killedPids).toContain(unstamped.descendantPid);
        expect(await waitForPidExit(verified.descendantPid)).toBe(true);
        expect(await waitForPidExit(unstamped.descendantPid)).toBe(true);

        // The case under test: a recycled pid is not the recorded process, so
        // the unit is not claimed, nothing is stopped and nothing is signalled.
        expect(reconciliation.units).not.toContain(reusedUnit);
        expect(stoppedUnits).not.toContain(reusedUnit);
        expect(killedPids).not.toContain(reused.leaderPid);
        expect(killedPids).not.toContain(reused.descendantPid);
        expect(reconciliation.detachedRunIds).not.toContain(reusedRunId);
        expect(isPidAlive(reused.leaderPid)).toBe(true);
        expect(isPidAlive(reused.descendantPid)).toBe(true);
      } finally {
        releaseFixtures(reused, verified, unstamped);
      }
    }, 20_000);
  },
);
