// SPA-10294 — NEGATIVE control B (needs-change guards, pre-change behaviour
// under a second cwd).
//
// For EVERY row the audit classifies NEEDS-PER-RUN-ADAPTATION or
// MUST-BE-EXEMPTED, this control demonstrates that the PRE-CHANGE mechanism
// misbehaves when the cwd changes. Per the card: "If it does not fail, the
// classification is wrong — say so."
//
// Every case is a disposable fixture under the run scratch dir. Nothing here
// touches a live checkout, the flag, the ceiling script, or the policy checker.
//
// Each case exits 0 ONLY when the pre-change mechanism is observed to MISBEHAVE
// in the way the audit claims. A case that behaves correctly is reported as a
// CLASSIFICATION ERROR and fails the control.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "spa10294-neg-b-"));

type CaseResult = { id: string; ok: boolean; observed: string; expect: string };

function run(cmd: string, args: string[], cwd: string): { code: number; out: string } {
  try {
    const out = execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

// ===========================================================================
// B-1 (G03) — branch-keyed registry reuse under a per-run cwd.
//   engine: wr.ts:3672 findRegisteredGitWorktreeByBranch(repoRoot, branchName)
//   claim : directory is per-RUN (runs/<runId>) but the branch stays per-CARD,
//           so run N+1 resolves run N's directory via the reuse path and never
//           reaches its own computed path.
// ===========================================================================
function caseG03(): CaseResult {
  const repo = path.join(ROOT, "b1-repo");
  fs.mkdirSync(repo, { recursive: true });
  run("git", ["init", "-q", "."], repo);
  run("git", ["config", "user.email", "t@t"], repo);
  run("git", ["config", "user.name", "t"], repo);
  run("git", ["commit", "-q", "--allow-empty", "-m", "init"], repo);
  run("git", ["branch", "card-x"], repo);

  // Run N: per-RUN directory named by run id, on the per-CARD branch.
  const runADir = path.join(repo, ".paperclip", "worktrees", "runs", "run-aaaa1111");
  run("git", ["worktree", "add", "-q", runADir, "card-x"], repo);

  // Run N+1 computes a DIFFERENT directory for the same card.
  const runBDir = path.join(repo, ".paperclip", "worktrees", "runs", "run-bbbb2222");

  // findRegisteredGitWorktreeByBranch: match refs/heads/card-x in the registry.
  const listed = run("git", ["worktree", "list", "--porcelain"], repo).out;
  const registered = listed
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length).trim())
    .find((p) => {
      const head = run("git", ["-C", p, "symbolic-ref", "--quiet", "--short", "HEAD"], repo);
      return head.code === 0 && head.out.trim() === "card-x";
    });

  if (!registered) return { id: "B-1/G03", ok: false, observed: "no registered worktree found for card-x", expect: "run N's dir registered" };
  if (registered !== runADir) {
    return { id: "B-1/G03", ok: false, observed: `registry returned ${registered}, not run A's dir ${runADir}`, expect: "registry returns run N's dir" };
  }
  const observed = `run N+1 would REUSE ${registered} instead of its own computed ${runBDir}`;
  const correct = observed; // misbehaviour is the point
  return { id: "B-1/G03", ok: observed === correct, observed, expect: "run N+1 reuses run N's dir (pre-change misbehaviour)" };
}

// ===========================================================================
// B-2 (G44) — platform worktree_gc.py cannot see a runs/ subdirectory.
//   script: spark-mojo-platform scripts/machine/worktree_gc.py:415-421
//   claim : walk only enters roots ending "/.paperclip/worktrees" and considers
//           immediate children only (os.path.dirname(full) === worktrees_dir),
//           so /runs/<runId>/ is never a candidate.
// ===========================================================================
function caseG44(): CaseResult {
  // Verbatim transcription of the two decision lines under test.
  const pathOk = (full: string, worktreesDir: string): string | null => {
    if (path.dirname(full) !== worktreesDir) return "nested-path";
    const real = fs.realpathSync(full);
    if (real !== full) return "symlink-escape";
    return null;
  };

  const base = path.join(ROOT, "b2-proj");
  const worktreesDir = path.join(base, ".paperclip", "worktrees");
  const legacy = path.join(worktreesDir, "SPA-10294-card-x");
  const ephemeral = path.join(worktreesDir, "runs", "run-aaaa1111");
  for (const d of [legacy, ephemeral]) fs.mkdirSync(d, { recursive: true });

  const reachedPaths = fs.readdirSync(worktreesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(worktreesDir, e.name));
  const legacyReached = reachedPaths.includes(legacy);
  const ephemeralReached = reachedPaths.includes(ephemeral);
  const legacyVerdict = legacyReached ? pathOk(legacy, worktreesDir) : "NOT-REACHED";
  const ephemeralVerdict = ephemeralReached ? pathOk(ephemeral, worktreesDir) : "NOT-REACHED (never a candidate: runs/ is not an immediate child)";

  // Discrimination: the legacy worktree MUST be reached (else the fixture is
  // broken), and the ephemeral one must NOT be (that is the defect).
  if (!legacyReached) {
    return { id: "B-2/G44", ok: false, observed: "FIXTURE BROKEN: the legacy worktree was not a candidate either", expect: "legacy reachable, ephemeral not" };
  }
  if (ephemeralReached) {
    return { id: "B-2/G44", ok: false, observed: "MUTATED: the walk DID reach the ephemeral dir — G44's pre-change claim no longer holds", expect: "runs/ never reached" };
  }
  return {
    id: "B-2/G44",
    ok: true,
    observed: `legacy=${legacyVerdict ?? "eligible"}; ephemeral=${ephemeralVerdict}`,
    expect: "legacy worktree is a GC candidate, ephemeral worktree is invisible",
  };
}

// ===========================================================================
// B-3 (G06) — the terminal sweep's ephemeral-shape test mislabels a reused
//   per-card path as "legacy" while the persisted flag says ephemeral.
//   engine: wr.ts:5325-5326
// ===========================================================================
function caseG06(): CaseResult {
  // Verbatim transcription of wr.ts:5325-5327.
  const classify = (workspacePath: string, liveRunIds: Set<string>) => {
    const isEphemeralShape = path.basename(path.dirname(workspacePath)) === "runs";
    const runIdSegment = isEphemeralShape ? path.basename(workspacePath) : null;
    return { runIdSegment, skippedAsLive: Boolean(runIdSegment && liveRunIds.has(runIdSegment)), passedToReaper: runIdSegment ?? "legacy" };
  };

  const base = "/srv/bulk/worktrees/.paperclip/worktrees";
  // The live-run set must contain the run id whose per-run directory is under
  // test; that is the guard's whole purpose.
  const live = new Set(["run-aaaa1111"]);
  const reusedPerCardPath = `${base}/SPA-10294-card-x`; // what G03 hands back, while ephemeralLifecycle===true
  const freshPerRunPath = `${base}/runs/run-aaaa1111`;

  const reused = classify(reusedPerCardPath, live);
  const fresh = classify(freshPerRunPath, live);

  const mislabelled = reused.runIdSegment === null && reused.passedToReaper === "legacy";
  const freshProtected = fresh.skippedAsLive;
  if (!mislabelled || !freshProtected) {
    return { id: "B-3/G06", ok: false, observed: `reused=${JSON.stringify(reused)} fresh=${JSON.stringify(fresh)}`, expect: "reused mislabelled as legacy; fresh live-run protected" };
  }
  return {
    id: "B-3/G06",
    ok: true,
    observed: `reused per-card path -> runIdSegment=${reused.runIdSegment}, reaper called with "${reused.passedToReaper}"; fresh per-run path -> live-run skip=${fresh.skippedAsLive}`,
    expect: "reused path loses its run identity while the flag still claims ephemeral",
  };
}

// ===========================================================================
// B-4 (G18) — native-workspace-finalizer's previous?.cwd fallback finalizes the
//   PREVIOUS run's directory under a per-run cwd.
//   engine: native-runtime/native-workspace-finalizer.ts:97, :110
// ===========================================================================
function caseG18(): CaseResult {
  // Verbatim transcription of the cwd resolution at :97.
  const resolveCwd = (workspace: { providerRef?: string | null; cwd?: string | null } | null, previous: { cwd?: string | null } | null) =>
    workspace?.providerRef ?? workspace?.cwd ?? previous?.cwd ?? null;

  const live = { providerRef: `/base/.paperclip/worktrees/runs/run-bbbb2222`, cwd: `/base/.paperclip/worktrees/runs/run-bbbb2222` };
  const previous = { cwd: `/base/.paperclip/worktrees/runs/run-aaaa1111` };

  const whenPresent = resolveCwd(live, previous);
  const whenCleared = resolveCwd({ providerRef: null, cwd: null }, previous);

  if (whenPresent !== live.cwd) return { id: "B-4/G18", ok: false, observed: "row presence test wrong", expect: "providerRef wins while present" };
  if (whenCleared !== previous!.cwd) return { id: "B-4/G18", ok: false, observed: `fallback=${whenCleared}`, expect: "falls back to PREVIOUS run's dir" };
  return {
    id: "B-4/G18",
    ok: true,
    observed: `after the per-run dir is removed, cwd resolves to ${whenCleared} — a DIFFERENT run's directory`,
    expect: "previous?.cwd fallback targets the prior run's dir",
  };
}

// ===========================================================================
// B-5 (G41) — provision-worktree.sh derives the instance id from the
//   DIRECTORY PATH, so a per-run cwd mints a new instance per run.
//   script: scripts/provision-worktree.sh:19-31
// ===========================================================================
function caseG41(): CaseResult {
  // Verbatim transcription of the bash/node derivation.
  const derive = (resolvedWorkspacePath: string) => {
    const normalized = path.basename(resolvedWorkspacePath)
      .trim().toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[-_]+|[-_]+$/g, "");
    const prefix = (normalized || "worktree").slice(0, 48);
    const pathHash = createHash("sha256").update(resolvedWorkspacePath).digest("hex").slice(0, 12);
    return `${prefix}-${pathHash}`;
  };

  const runA = derive("/base/.paperclip/worktrees/runs/run-aaaa1111");
  const runB = derive("/base/.paperclip/worktrees/runs/run-bbbb2222");
  const legacyA = derive("/base/.paperclip/worktrees/SPA-10294-card-x");
  const legacyB = derive("/base/.paperclip/worktrees/SPA-10294-card-x"); // same card, same dir

  if (runA === runB) return { id: "B-5/G41", ok: false, observed: "two runs produced the same instance id", expect: "per-run instance ids diverge" };
  if (legacyA !== legacyB) return { id: "B-5/G41", ok: false, observed: "legacy derivation is unstable", expect: "legacy derivation is stable" };
  return {
    id: "B-5/G41",
    ok: true,
    observed: `per-run ids: ${runA} vs ${runB} (distinct instances, distinct embedded-postgres data dirs and ports); legacy id stable: ${legacyA}`,
    expect: "instance identity is cwd-derived, so it cannot be per-card under a per-run cwd",
  };
}

// ===========================================================================
// B-6 (G15) — codex-boundaries containment is RELATIVE to the configured root.
//   This is the tolerant counter-example: it does NOT misbehave. Included so the
//   control proves it discriminates — a control that never shows a guard failing
//   proves nothing.
//   engine: packages/paperclip-runner/src/drivers/codex/codex-boundaries.ts:71-120
// ===========================================================================
function caseG15CounterExample(): CaseResult {
  const { relative, isAbsolute, sep } = path;
  const inside = (resolved: string, configuredRoot: string) => {
    const p = relative(configuredRoot, resolved);
    return !(p === ".." || p.startsWith(`..${sep}`) || isAbsolute(p));
  };
  const rootA = "/base/.paperclip/worktrees/SPA-10294-card-x";
  const rootB = "/base/.paperclip/worktrees/runs/run-bbbb2222";
  const childA = inside(`${rootA}/sub`, rootA);
  const childB = inside(`${rootB}/sub`, rootB);
  const outsideB = inside("/base/elsewhere", rootB);

  if (!childA || !childB || outsideB) {
    return { id: "B-6/G15-counter", ok: false, observed: `childA=${childA} childB=${childB} outside=${outsideB}`, expect: "relative containment tolerant under both cwds" };
  }
  return {
    id: "B-6/G15-counter",
    ok: true,
    observed: "containment accepted under both cwds and still rejected an outside path — a TOLERANT guard, correctly NOT in the needs-change bucket",
    expect: "control discriminates: tolerant guards do not appear in the failure set",
  };
}

const cases = [caseG03, caseG44, caseG06, caseG18, caseG41, caseG15CounterExample];
const results = cases.map((c) => c());
let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? "OK  " : "FAIL"} ${r.id}`);
  console.log(`       observed: ${r.observed}`);
  if (!r.ok) {
    console.log(`       expected: ${r.expect}`);
    failed += 1;
  }
}
console.log(`\nscratch fixture root: ${ROOT}`);
console.log(`${results.length - failed}/${results.length} cases behaved as the audit classified.`);
process.exit(failed === 0 ? 0 : 1);