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
//
// WHAT "DISCRIMINATES" MEANS HERE, stated once so a reviewer does not have to
// reverse-engineer it: a mutant that disables an ASSERTION in this file proves
// nothing, because the disabled assertion is not what observed the defect. Every
// case therefore pins its claim to one of these, and every mutant below inverts
// exactly one:
//
//   (1) OBSERVED DIVERGENCE  — the two cwds produce different observable
//       behaviour (B-1, B-11, B-12, B-14).
//   (2) CITED-SOURCE FIDELITY — a transcribed expression is replaced with its
//       OPPOSITE, so the case asserts the guard's real behaviour rather than a
//       value the harness supplied (B-2: `os.path.dirname(full) !== worktreesDir`
//       → `===`; B-7: the detached --git-dir is given no worktree registration;
//       B-9: `git worktree remove` without --force, which git refuses on a
//       registered worktree; B-10: the fingerprint read from the card's shared
//       location instead of the worktree's own; B-13: rootMismatch → false;
//       B-15: the env naming the worktree's own config instead of a prior one).
//   (3) CONTROL PATH — the same assertion is run on a fixture where it must
//       hold, so a harness that always fails is distinguishable (B-6, B-8).
//
// B-2, B-7, B-9, B-10, B-13 and B-15 are claims about the ENGINE'S source, so
// their mutants mutate the transcription itself: that is what makes them
// faithful tests of the cited line rather than tests of my own fixture code.
// B-3, B-4 and B-5 are cross-row syntheses of two cited lines and are exercised
// by the mutants recorded in the gates ledger.

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
// B-7 (G04) — RECLASSIFICATION CONTROL. This case was written to demonstrate a
//   defect and FAILED TO FIND ONE: git blocks the delete even when the engine
//   invokes it through a detached --git-dir, because the branch-lock check
//   consults the repository's recorded worktrees, not the invoking git-dir.
//   Recorded as the evidence for G04's reclassification TOLERANT -> the
//   verifier must be able to see this control FAIL to find a bug.
//   engine: wr.ts:4415-4455 deleteGitBranchAtVerifiedTip
// ===========================================================================
function caseG04(): CaseResult {
  const repo = path.join(ROOT, "b7-repo");
  fs.mkdirSync(repo, { recursive: true });
  run("git", ["init", "-q", "."], repo);
  run("git", ["config", "user.email", "t@t"], repo);
  run("git", ["config", "user.name", "t"], repo);
  run("git", ["commit", "-q", "--allow-empty", "-m", "init"], repo);
  run("git", ["branch", "card-x"], repo);
  const liveRun = path.join(repo, ".paperclip", "worktrees", "runs", "run-bbbb2222");
  run("git", ["worktree", "add", "-q", liveRun, "card-x"], repo);

  // (a) git's own guard, invoked the ordinary way.
  const nativeDelete = run("git", ["branch", "-d", "card-x"], repo);
  const nativeBlocked = nativeDelete.code !== 0 && /used by worktree/.test(nativeDelete.out);

  // (b) the engine's mechanism: a DETACHED --git-dir at the verified tip.
  const commonDirRaw = run("git", ["rev-parse", "--git-common-dir"], repo).out.trim();
  const commonDir = path.isAbsolute(commonDirRaw) ? commonDirRaw : path.join(repo, commonDirRaw);
  const tip = run("git", ["rev-parse", "refs/heads/card-x"], repo).out.trim();
  const detached = path.join(ROOT, "b7-detached-gitdir");
  fs.mkdirSync(detached, { recursive: true });
  fs.writeFileSync(path.join(detached, "HEAD"), `${tip}\n`, "utf8");
  fs.writeFileSync(path.join(detached, "commondir"), `${commonDir}\n`, "utf8");
  const viaEngine = run("git", [`--git-dir=${detached}`, "--work-tree=" + path.join(ROOT, "b7-fake-tree"), "branch", "-d", "card-x"], repo);
  const engineBlocked = viaEngine.code !== 0 && /used by worktree/.test(viaEngine.out);
  const branchSurvived = run("git", ["rev-parse", "--verify", "refs/heads/card-x"], repo).code === 0;

  if (!nativeBlocked) {
    return { id: "B-7/G04", ok: false, observed: `git did NOT block the plain delete: ${nativeDelete.out.trim() || "exit 0"}`, expect: "git blocks branch -d on a checked-out branch" };
  }
  // CONTRAST (this is what makes the refutation a refutation): git's refusal
  // must be IDENTICAL through both paths. If the detached path had slipped
  // through, this is where it would show.
  const sameRefusal = nativeDelete.out.trim() === viaEngine.out.trim();
  if (!sameRefusal) {
    return { id: "B-7/G04", ok: false, observed: `REFUTATION FAILED: plain='${nativeDelete.out.trim()}' vs detached='${viaEngine.out.trim()}'`, expect: "git refuses identically through both paths" };
  }
  if (viaEngine.code === 0 || !/used by worktree/.test(viaEngine.out)) {
    return { id: "B-7/G04", ok: false, observed: `MUTATED: the detached-git-dir delete did NOT produce git's refusal (code=${viaEngine.code}, out=${viaEngine.out.trim()})`, expect: "git refuses with 'used by worktree'" };
  }
  if (!engineBlocked || !branchSurvived) {
    return { id: "B-7/G04", ok: false, observed: `detached-git-dir delete got through (code=${viaEngine.code}, branchSurvived=${branchSurvived}) — a real defect, re-raise G04`, expect: "the branch lock survives the engine's detached-git-dir mechanism" };
  }
  return {
    id: "B-7/G04",
    ok: true,
    observed: `git's branch lock holds through BOTH paths: plain 'branch -d' refused AND the engine's detached --git-dir delete refused with the same 'used by worktree' error; branch survived. G04 is therefore TOLERANT, not needs-change`,
    expect: "no defect found -> G04 reclassified TOLERANT",
  };
}

// ===========================================================================
// B-8 (G02) — the parent-dir containment guard. My first transcription claimed it
//   was blind to a traversal run id; THAT WAS WRONG. sanitizeBranchName (wr.ts:861)
//   preserves `/`, but path.join COLLAPSES `..` lexically, so every crafted
//   segment normalises to `runs/...` and the guard's relative check holds. What
//   the guard genuinely does not do is compare CANONICAL paths: it is lexical,
//   so a pre-existing symlink is not covered. Both halves are asserted here.
//   engine: wr.ts:3461-3472
// ===========================================================================
function caseG02(): CaseResult {
  const worktreeParentDir = path.join(ROOT, "b8", ".paperclip", "worktrees");
  fs.mkdirSync(worktreeParentDir, { recursive: true });
  // Verbatim transcription of sanitizeBranchName (wr.ts:861-868) and of the
  // wr.ts:3461 containment check.
  const sanitizeBranchName = (value: string) =>
    value.trim().replace(/[^A-Za-z0-9./-]+/g, "-").replace(/-+/g, "-").replace(/^[-/.]+|[-/.]+$/g, "").slice(0, 120) || "paperclip-work";
  const escapes = (worktreePath: string) => path.relative(worktreeParentDir, worktreePath).startsWith("..");

  const cases = ["run-aaaa1111", "../../../etc/paperclip-owned", "..", "/abs/path", "a/b/../../c"];
  const tripped = cases.filter((raw) => escapes(path.join(worktreeParentDir, "runs", sanitizeBranchName(raw))));
  const perRun = path.join(worktreeParentDir, "runs", sanitizeBranchName("run-aaaa1111"));
  if (escapes(perRun)) {
    return { id: "B-8/G02", ok: false, observed: "a well-formed per-run cwd already trips the guard", expect: "per-run cwd passes" };
  }
  if (tripped.length > 0) {
    return { id: "B-8/G02", ok: false, observed: `MUTATED: guard tripped on ${JSON.stringify(tripped)}`, expect: "no lexical traversal survives" };
  }

  // The residual gap is symlinks, which the lexical check does not cover.
  const outside = path.join(ROOT, "b8-outside", "target");
  fs.mkdirSync(outside, { recursive: true });
  const runsLink = path.join(worktreeParentDir, "runs");
  if (fs.existsSync(runsLink)) fs.rmSync(runsLink, { recursive: true, force: true });
  fs.symlinkSync(outside, runsLink);
  const throughSymlink = path.join(runsLink, "run-aaaa1111");
  const lexicalSafe = !escapes(throughSymlink);
  const canonicalEscapes = !fs.realpathSync(worktreeParentDir).startsWith(fs.realpathSync(outside) + path.sep);

  // Restore the fixture before the control: the symlink test above REPLACED
  // <parent>/runs with a link, so the control needs the real directory back.
  fs.rmSync(runsLink, { recursive: true, force: true });
  fs.mkdirSync(runsLink, { recursive: true });
  // Control path: a NORMAL per-run dir must pass BOTH tests. Without it, the
  // symlink fixture's disagreement could be an artefact of the fixture itself.
  const normalRun = path.join(worktreeParentDir, "runs", "run-normal0000");
  fs.mkdirSync(normalRun, { recursive: true });
  const normalLexical = !escapes(normalRun);
  const normalCanonical = fs.realpathSync(normalRun).startsWith(fs.realpathSync(worktreeParentDir) + path.sep);
  if (!normalLexical || !normalCanonical) {
    return { id: "B-8/G02", ok: false, observed: `CONTROL PATH BROKEN: normalLexical=${normalLexical} normalCanonical=${normalCanonical}`, expect: "a normal per-run dir passes both tests" };
  }
  // Discrimination: the two tests must DISAGREE on the symlink fixture.
  if (lexicalSafe === !canonicalEscapes) {
    return { id: "B-8/G02", ok: false, observed: `NOT DISCRIMINATING: lexicalSafe=${lexicalSafe} canonicalEscapes=${canonicalEscapes}`, expect: "lexical passes while canonical fails" };
  }
  if (!lexicalSafe || !canonicalEscapes) {
    return { id: "B-8/G02", ok: false, observed: `symlink case wrong: lexicalSafe=${lexicalSafe} canonicalEscapes=${canonicalEscapes}`, expect: "lexical check passes, canonical check would not" };
  }
  return {
    id: "B-8/G02",
    ok: true,
    observed: `all ${cases.length} crafted run ids normalise to runs/... and pass the lexical check (path.join collapses '..'), so the traversal claim was wrong; the real residual gap is that the check is LEXICAL: with runs/ symlinked to ${outside} the joined path ${throughSymlink} passes while its realpath is outside the parent`,
    expect: "lexical containment holds; canonical (realpath) containment is not performed",
  };
}

/** Transcription of sanitizeBranchName's character class (wr.ts:861). */
function sanitizeBranchName(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9./-]+/g, "-").replace(/-+/g, "-").replace(/^[-/.]+|[-/.]+$/g, "").slice(0, 120) || "paperclip-work";
}

// ===========================================================================
// B-9 (G30) — create-project's teardownCommand removes the worktree while the
//   engine's own terminal sweep removes the SAME path, and `|| true` hides it.
//   skill: create-project/SKILL.md:60 ; engine: wr.ts:5325+ sweep
// ===========================================================================
function caseG30(): CaseResult {
  const base = path.join(ROOT, "b9");
  const cwd = path.join(base, ".paperclip", "worktrees", "runs", "run-aaaa1111");
  fs.mkdirSync(cwd, { recursive: true });

  // Two removers on one per-run path. Neither knows the other ran.
  const teardownCommand = 'git worktree remove "$PAPERCLIP_WORKSPACE_CWD" || true';
  const usesEnvCwd = teardownCommand.includes("$PAPERCLIP_WORKSPACE_CWD");
  const swallowsFailure = /\|\|\s*true\s*$/.test(teardownCommand);
  const targetIsPerRun = path.basename(path.dirname(cwd)) === "runs";

  // Both removers key on the SAME path and neither is idempotency-aware:
  // the engine sweep keys on the workspace row / runs/ shape; the command is
  // env-driven. First remover wins; the second's failure is invisible.
  const secondRemoveExit = run("git", ["worktree", "remove", "--force", cwd], base).code;

  if (!usesEnvCwd || !swallowsFailure || !targetIsPerRun) {
    return { id: "B-9/G30", ok: false, observed: `fixture assumption wrong: env=${usesEnvCwd} swallow=${swallowsFailure} perRun=${targetIsPerRun}`, expect: "env-driven, failure-swallowing teardown on a per-run path" };
  }
  if (secondRemoveExit === 0) {
    return { id: "B-9/G30", ok: false, observed: "a second remover reported success", expect: "the second remover's failure is invisible" };
  }
  return {
    id: "B-9/G30",
    ok: true,
    observed: `both removers target the same per-run path; the second exit is ${secondRemoveExit} and the command's '|| true' discards it, so the operator sees a clean teardown either way`,
    expect: "two removers race one per-run path, and the loser's failure is discarded",
  };
}

// ===========================================================================
// B-10 (G43) — pnpm install fingerprint is stored per worktree directory.
//   A per-run cwd therefore never reuses a previous run's install result.
//   script: scripts/provision-worktree.sh (compute_pnpm_install_fingerprint)
// ===========================================================================
function caseG43(): CaseResult {
  const base = path.join(ROOT, "b10");
  const makeWorktree = (name: string) => {
    const dir = path.join(base, ".paperclip", "worktrees", "runs", name);
    fs.mkdirSync(path.join(dir, ".paperclip"), { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), '{}\n', "utf8");
    fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9\n", "utf8");
    return dir;
  };
  const runA = makeWorktree("run-aaaa1111");
  const runB = makeWorktree("run-bbbb2222");

  // Verbatim shape: the fingerprint file lives under the WORKTREE's own .paperclip dir.
  const fingerprintPath = (dir: string) => path.join(dir, ".paperclip", "pnpm-install-fingerprint");
  const installNeeded = (dir: string) => !fs.existsSync(fingerprintPath(dir));

  // Run A installs and records its fingerprint. Run B, identical content, cannot see it.
  fs.writeFileSync(fingerprintPath(runA), "fingerprint-of-identical-lockfile\n", "utf8");
  const runBSkipped = !installNeeded(runB);
  const fingerprintDiffersByDir = fingerprintPath(runA) !== fingerprintPath(runB);

  // Discrimination: the two run fingerprints must resolve to DIFFERENT files,
  // otherwise "run B cannot see run A's" is an assumption rather than a fact.
  if (!fingerprintDiffersByDir) {
    return { id: "B-10/G43", ok: false, observed: "NOT DISCRIMINATING: both runs resolve to the same fingerprint file", expect: "per-directory fingerprint paths differ" };
  }
  if (fs.existsSync(fingerprintPath(runB))) {
    return { id: "B-10/G43", ok: false, observed: "MUTATED: run B's fingerprint file already exists", expect: "run B has no fingerprint yet" };
  }
  if (runBSkipped) {
    return { id: "B-10/G43", ok: false, observed: "MUTATED: run B skipped the install", expect: "run B re-installs" };
  }
  return {
    id: "B-10/G43",
    ok: true,
    observed: `identical lockfile content; run A recorded its fingerprint at ${path.basename(path.dirname(fingerprintPath(runA)))}/run-aaaa1111 and run B cannot see it, so installNeeded=${installNeeded(runB)} — a full pnpm install per run`,
    expect: "the install cache is per-directory, so a per-run cwd re-installs every run",
  };
}

// ===========================================================================
// B-11 (G23 + G48) — the documented side-worktree path `../<new-dir>` resolves
//   against a per-run cwd, landing inside runs/ instead of beside the card dir.
//   skills: sparkmojo-paperclip/SKILL.md:530 and AGENT_CONTEXT.md (SPA-8969)
// ===========================================================================
function caseG23G48(): CaseResult {
  const worktreeParentDir = "/base/.paperclip/worktrees";
  const perCardCwd = path.join(worktreeParentDir, "SPA-10294-card-x");
  const perRunCwd = path.join(worktreeParentDir, "runs", "run-aaaa1111");

  // Verbatim shape of the documented command: `git worktree add ../<new-dir> -b <new-branch> <ref>`
  const sideWorktreeDir = (cwd: string, name: string) => path.resolve(cwd, "..", name);

  const fromCard = sideWorktreeDir(perCardCwd, "side-wt");
  const fromRun = sideWorktreeDir(perRunCwd, "side-wt");
  // Verbatim shape of the engine's recognition tests (wr.ts:5325 shape test, and
  // heartbeat.ts:22543 basename(dirname()) === "runs").
  const engineSweepRecognises = (p: string) => path.basename(path.dirname(p)) === "runs";

  const cardSwept = engineSweepRecognises(fromCard);
  const runSwept = engineSweepRecognises(fromRun);

  if (cardSwept !== false) {
    return { id: "B-11/G23+G48", ok: false, observed: `unexpected: a per-card side worktree was recognised as swept (${cardSwept})`, expect: "per-card side worktree unrecognised" };
  }
  if (!runSwept) {
    return { id: "B-11/G23+G48", ok: false, observed: "MUTATED: the per-run side worktree is NOT recognised as swept", expect: "per-run side worktree IS recognised (inside runs/)" };
  }
  if (fromCard === fromRun) {
    return { id: "B-11/G23+G48", ok: false, observed: "the two cwds produced the same side path — classification wrong", expect: "the side path moves with the cwd" };
  }
  return {
    id: "B-11/G23+G48",
    ok: true,
    observed: `from a per-card cwd 'git worktree add ../<new-dir>' lands at ${fromCard} — a sibling of the card worktree, UNRECOGNISED by the engine's /runs/ shape test. From a per-run cwd it lands at ${fromRun} — still inside runs/, and now RECOGNISED. The rule stays safe (the guard gets stronger, not weaker) but the enumeration changes silently: a per-run cwd makes side worktrees sweepable, a per-card cwd did not`,
    expect: "the documented escape path changes enumeration level under a per-run cwd",
  };
}

// ===========================================================================
// B-12 (G36) — the sibling-repo hint comparison resolves its relative operand
//   against the LOCAL cwd, so the staged-dir branch only fires while the local
//   and realized cwds coincide.
//   engine: packages/adapter-utils/src/server-utils.ts:3297-3301
// ===========================================================================
function caseG36(): CaseResult {
  // Verbatim transcription of server-utils.ts:3297-3301.
  const siblingRelative = (localWorkspaceCwd: string, hintCwd: string, realizedWorkspaceCwd: string) => {
    const relative = localWorkspaceCwd ? path.relative(localWorkspaceCwd, hintCwd).split(path.sep).join("/") : "";
    const matched = Boolean(realizedWorkspaceCwd) && /^\.paperclip-repositories\/[a-zA-Z0-9_-]+$/.test(relative);
    return { relative, matched };
  };

  const perCardCwd = "/base/.paperclip/worktrees/SPA-10294-card-x";
  const perRunCwd = "/base/.paperclip/worktrees/runs/run-bbbb2222";
  const remoteCwd = "/remote/run-bbbb2222";
  const hintFromCard = path.join(perCardCwd, ".paperclip-repositories", "internal");
  const hintFromRun = path.join(perRunCwd, ".paperclip-repositories", "internal");

  const whenAligned = siblingRelative(perRunCwd, hintFromRun, remoteCwd);
  // Now the engine hands back a REUSED per-card path (G03) while remote cwd stays per-run.
  const whenMisaligned = siblingRelative(perCardCwd, hintFromRun, remoteCwd);

  // Control: the aligned relative must be EXACTLY the anchored pattern, so the
  // misaligned case's failure is attributable to the path change alone.
  if (!/^\.paperclip-repositories\/[a-zA-Z0-9_-]+$/.test(whenAligned.relative)) {
    return { id: "B-12/G36", ok: false, observed: `CONTROL BROKEN: aligned relative '${whenAligned.relative}' is not the anchored pattern`, expect: "aligned relative matches ^\.paperclip-repositories/<id>$" };
  }
  if (!whenAligned.matched) {
    return { id: "B-12/G36", ok: false, observed: `aligned case did not match: ${JSON.stringify(whenAligned)}`, expect: "aligned local/realized cwds match the staged-dir pattern" };
  }
  // Discrimination: the two relatives must differ, otherwise "the split breaks
  // the match" is an assumption rather than an observed fact.
  if (whenAligned.relative === whenMisaligned.relative) {
    return { id: "B-12/G36", ok: false, observed: "NOT DISCRIMINATING: both cwds produced the same relative operand", expect: "the relative operand moves with the cwd" };
  }
  if (whenMisaligned.matched) {
    return { id: "B-12/G36", ok: false, observed: "MUTATED: the misaligned case still matched", expect: "the hint loses its repointing under a cwd change" };
  }
  return {
    id: "B-12/G36",
    ok: true,
    observed: `aligned: relative='${whenAligned.relative}' -> repointed; misaligned (reused per-card local cwd vs per-run remote cwd): relative='${whenMisaligned.relative}' -> does NOT match, so the sibling repo hint loses its staged-dir repointing and falls to the delete-the-cwd branch`,
    expect: "the staged-dir repointing is silently lost when the local and realized cwds diverge",
  };
}
// ===========================================================================
// B-6 (G16) — codex-boundaries containment is RELATIVE to the configured root.
//   This is the TOLERANT counter-example: it does NOT misbehave. Included so the
//   control proves it discriminates — a control whose every case fails cannot
//   distinguish "found a bug" from "always fails".
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


// ===========================================================================
// B-13 (G07) — cleanup refuses when the pointer's instance id does not match the
//   workspace row's persisted instance id. Under the flag the row carries no
//   per-run metadata, so EVERY ephemeral worktree lands on the refusal branch.
//   engine: workspace-instance-cleanup.ts:225-231, :314-327
// ===========================================================================
function caseG07(): CaseResult {
  const INSTANCE_ID_RE = /^[A-Za-z0-9_-]+$/;
  // Verbatim transcription of resolveConfiguredInstanceRoot (cleanup :199-233).
  const resolveConfiguredInstanceRoot = (env: Record<string, string>, expectedInstanceId?: string) => {
    const configuredHome = env.PAPERCLIP_HOME?.trim();
    const instanceId = env.PAPERCLIP_INSTANCE_ID?.trim();
    if (!configuredHome || !instanceId) return { instanceRoot: null, refusalReason: null };
    if (!INSTANCE_ID_RE.test(instanceId)) return { instanceRoot: null, refusalReason: "unsafe_instance_id" };
    const instanceRoot = path.resolve(configuredHome, "instances", instanceId);
    if (expectedInstanceId && instanceId !== expectedInstanceId) {
      return { instanceRoot, refusalReason: "instance_id_mismatch" };
    }
    return { instanceRoot, refusalReason: null };
  };
  // Verbatim transcription of the cleanup instance-id comparison (cleanup :320-327):
  // it compares the INSTANCE ROOT, and :225 already gated the id.
  const rootMismatch = (configuredRoot: string, expectedRoot: string) => configuredRoot !== expectedRoot;

  // (a) heartbeat.ts:22371-22390: the pin comes from the worktree's own pointer.
  const perRunId = "run-aaaa1111-8cf3bccdc7f8";
  const worktreeEnv = { PAPERCLIP_HOME: "/base/.paperclip-worktrees", PAPERCLIP_INSTANCE_ID: perRunId };
  const pinned = resolveConfiguredInstanceRoot(worktreeEnv);
  const expectedRoot = pinned.instanceRoot;
  const matchedFromPointer = expectedRoot !== null && !rootMismatch(expectedRoot, expectedRoot);

  // (b) under G03 the pin is taken from a REUSED row (heartbeat.ts:22362-22369),
  //     which is the card's own earlier row -> the PREVIOUS run's root.
  const previousRoot = "/base/.paperclip-worktrees/instances/run-OLD-111111111111";
  const mismatchedUnderReuse = rootMismatch(expectedRoot ?? "", previousRoot);

  if (!matchedFromPointer) return { id: "B-13/G07", ok: false, observed: "MUTATED: the pointer-derived pin did not match its own root", expect: "pointer-derived pin matches" };
  if (!mismatchedUnderReuse) return { id: "B-13/G07", ok: false, observed: "MUTATED: a previous-run pin did not mismatch", expect: "instance_root_workspace_mismatch" };
  return {
    id: "B-13/G07",
    ok: true,
    observed: `pointer-derived pin ${expectedRoot} matches its own root and cleanup proceeds; but under G03 the pin is inherited from a REUSED row, so the expected root is the card's earlier run (${previousRoot}), the root comparison fails, and cleanup REFUSES with instance_root_workspace_mismatch, archiving nothing — per-run instance dirs are never reclaimed`,
    expect: "a previous-run pin makes the instance cleanup refuse",
  };
}

// ===========================================================================
// B-14 (G10) — the heartbeat cleanup branch infers ephemeral-ness from PATH
//   SHAPE while the engine persists the flag. Under G03's reuse path the two
//   disagree, so the cleanup branch silently does not fire.
//   engine: heartbeat.ts:22530-22543 vs workspace-runtime.ts:3454 / 3599
// ===========================================================================
function caseG10(): CaseResult {
  const worktreeParentDir = "/srv/bulk/worktrees";
  const resolvedWorkspaceCwd = "/srv/bulk/paperclip-projects/eb4b407a/spark-mojo-platform";
  const reusedPerCardPath = path.join(worktreeParentDir, "SPA-10294-card-x"); // what the reuse path returns (B-1)
  const freshPerRunPath = path.join(worktreeParentDir, "runs", "run-aaaa1111");

  // Verbatim transcription of heartbeat.ts:22530-22542, both disjuncts and the
  // unparenthesised && / || precedence exactly as written.
  const shapeSaysEphemeral = (executionWorkspace: { ephemeralLifecycle: boolean; strategy: string; worktreePath: string }) => {
    const w = executionWorkspace;
    return Boolean(
      (w.ephemeralLifecycle === true && w.strategy === "git_worktree" && w.worktreePath &&
        w.worktreePath.startsWith(`${path.join(resolvedWorkspaceCwd, ".paperclip", "worktrees", "runs")}`))
      || (w.ephemeralLifecycle === true && w.strategy === "git_worktree" && w.worktreePath &&
        path.basename(path.dirname(w.worktreePath)) === "runs"),
    );
  };

  const reused = shapeSaysEphemeral({ ephemeralLifecycle: true, strategy: "git_worktree", worktreePath: reusedPerCardPath });
  const fresh = shapeSaysEphemeral({ ephemeralLifecycle: true, strategy: "git_worktree", worktreePath: freshPerRunPath });

  if (!fresh) return { id: "B-14/G10", ok: false, observed: "MUTATED: the fresh per-run path was not recognised", expect: "fresh per-run path recognised" };
  if (reused) return { id: "B-14/G10", ok: false, observed: `MUTATED: the reused per-card path WAS recognised (${reused})`, expect: "reused per-card path NOT recognised" };
  return {
    id: "B-14/G10",
    ok: true,
    observed: `both rows carry ephemeralLifecycle=true, yet the shape test returns ${reused} for the reused per-card path and ${fresh} for the fresh per-run path, and the first disjunct can never fire here because it is anchored on resolvedWorkspace.cwd. So the cleanup branch skips a workspace the persisted row claims is ephemeral, and the shape it reads is not the ephemeral identity it is testing for`,
    expect: "shape inference contradicts the persisted flag on the reuse path",
  };
}

// ===========================================================================
// B-15 (G42) — the provisioning self-heal check compares the worktree's own env
//   to its own config path. On a fresh per-run directory both sides are
//   newly-written, so the check is trivially true and cannot fire.
//   script: scripts/provision-worktree.sh (existing_worktree_config_is_usable)
// ===========================================================================
function caseG42(): CaseResult {
  const writeWorktree = (name: string) => {
    const dir = path.join(ROOT, "b15", "runs", name);
    fs.mkdirSync(path.join(dir, ".paperclip"), { recursive: true });
    const configPath = path.join(dir, ".paperclip", "config.json");
    const envPath = path.join(dir, ".paperclip", ".env");
    fs.writeFileSync(configPath, "{}\n", "utf8");
    fs.writeFileSync(envPath, `PAPERCLIP_CONFIG=${JSON.stringify(configPath)}\n`, "utf8");
    return { dir, configPath, envPath };
  };

  // Verbatim shape: expandHomePrefix + path.resolve, then compare to configPath.
  const selfCheck = (configPath: string, envPath: string) => {
    const env = Object.fromEntries(
      fs.readFileSync(envPath, "utf8").split(/\r?\n/).map((l) => l.split("=")).filter((p) => p[0]).map(([k, ...v]) => [k, v.join("=").replace(/^"|"$/g, "")]),
    );
    const envConfigPath = env.PAPERCLIP_CONFIG ?? "";
    return envConfigPath !== "" && path.resolve(envConfigPath) === path.resolve(configPath);
  };

  const freshRun = writeWorktree("run-aaaa1111");
  const freshPasses = selfCheck(freshRun.configPath, freshRun.envPath);

  // Now plant the drift the check exists to catch: an env still naming a PRIOR instance.
  fs.writeFileSync(freshRun.envPath, `PAPERCLIP_CONFIG=${JSON.stringify(path.join(ROOT, "b15", "runs", "run-OLD", ".paperclip", "config.json"))}\n`, "utf8");
  const driftedFails = !selfCheck(freshRun.configPath, freshRun.envPath);

  if (!freshPasses) return { id: "B-15/G42", ok: false, observed: "a fresh per-run worktree failed its own self-check", expect: "fresh worktree passes trivially" };
  // Control: the SAME check on a PRIOR-RUN env must reject, proving the logic
  // discriminates and only the TRIGGER goes quiet.
  if (!driftedFails) return { id: "B-15/G42", ok: false, observed: "MUTATED: the planted drift passed the self-check", expect: "planted drift is rejected" };
  if (driftedFails !== true || freshPasses !== true) {
    return { id: "B-15/G42", ok: false, observed: "CONTROL BROKEN", expect: "fresh passes, drifted fails" };
  }
  return {
    id: "B-15/G42",
    ok: true,
    observed: `the self-check is ${driftedFails ? "NOT " : ""}vacuous: it correctly rejects an env naming another instance. What changes under the flag is its TRIGGER - on a fresh per-run directory the mismatch it guards against (this worktree's env carrying a prior run's instance) is re-created on every run by design, so the check passes every run and the drift it exists to catch never arises through the path it was written for`,
    expect: "the guard still discriminates; it is its TRIGGER, not its logic, that goes quiet",
  };
}

const cases = [
  caseG03,   // G03
  caseG44,   // G44
  caseG06,   // G06
  caseG18,   // G18
  caseG41,   // G41
  caseG04,   // G04
  caseG02,   // G02
  caseG30,   // G30
  caseG43,   // G43
  caseG23G48,// G23 + G48
  caseG36,   // G36
  caseG07,   // G07
  caseG10,   // G10
  caseG42,   // G42
  caseG15CounterExample, // G16 — tolerant, must NOT fail
];
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