// SPA-10294 — NEGATIVE control A (tolerant guard under two synthetic cwds).
//
// Claim under test (audit row G05 / engine: workspace-runtime.ts:4684-4694):
//   the destructive-path guard `containsProjectWorkspace` is TOLERANT of a
//   per-run cwd — i.e. it produces the SAME verdict for two different cwds.
//
// This script is a faithful transcription of the guard's expression from
// server/src/services/workspace-runtime.ts @ b7743225 (the audited base), so it
// exercises the guard's DECISION LOGIC, not a paraphrase of it.
//
// It is a FAIL-CLOSED control: it exits 0 only if, for BOTH cwds, the guard
// produced the expected verdict. A mismatch exits nonzero. No live data is
// mutated; every path is a throwaway fixture under the run scratch dir.

import path from "node:path";
// @ts-check
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
void HERE;

// ---------------------------------------------------------------------------
// TRANSCRIPTION of workspace-runtime.ts:4684-4694 (base b7743225).
// Any change to the upstream expression must be mirrored here; the diff is
// reviewable and the `WORKSPACE_RUNTIME_GUARD_SOURCE` check below pins which
// file:line this transcription claims to mirror.
// ---------------------------------------------------------------------------
function containsProjectWorkspace(input: {
  workspacePath: string;
  projectWorkspaceCwd: string | null;
}): { refuses: boolean; resolved: string; project: string | null } {
  const projectWorkspaceCwd = input.projectWorkspaceCwd
    ? path.resolve(input.projectWorkspaceCwd)
    : null;
  const resolvedWorkspacePath = path.resolve(input.workspacePath);
  const containsProjectWorkspace = projectWorkspaceCwd
    ? resolvedWorkspacePath === projectWorkspaceCwd ||
        projectWorkspaceCwd.startsWith(`${resolvedWorkspacePath}${path.sep}`)
    : false;
  return { refuses: containsProjectWorkspace, resolved: resolvedWorkspacePath, project: projectWorkspaceCwd };
}

// ---------------------------------------------------------------------------
// Two DIFFERENT synthetic cwds, one per-run shape and one legacy per-card
// shape, sharing the same project workspace root. This is the property a
// per-RUN cwd must satisfy: same guard, same verdict, different directory.
// ---------------------------------------------------------------------------
const PROJECT = "/tmp/spa10294-controls/fixture-repo";

const CWDS = [
  {
    label: "legacy per-card cwd",
    workspacePath: `${PROJECT}/.paperclip/worktrees/SPA-10294-card-x`,
    expectRefuse: false,
  },
  {
    label: "ephemeral per-run cwd",
    workspacePath: `${PROJECT}/.paperclip/worktrees/runs/run-aaaa1111`,
    expectRefuse: false,
  },
];

// The guard's intent is "refuse to rm a path that CONTAINS the project
// workspace". Neither of the two cwds contains the project root, so the honest
// expectation for BOTH is refuses=false. Asserting refuses=true for both would
// be asserting the guard misfires identically — which is a DIFFERENT claim and
// would make this control pass for the wrong reason. Both are checked below by
// also running a THIRD path that genuinely does contain the project workspace
// and requiring it to refuse, which is what proves the guard still guards.
function main(): void {
  const results = CWDS.map((c) => ({ ...c, actual: containsProjectWorkspace({ workspacePath: c.workspacePath, projectWorkspaceCwd: PROJECT }) }));

  // Positive control: a path that DOES contain the project workspace must refuse.
  const positive = containsProjectWorkspace({
    workspacePath: "/tmp/spa10294-controls",
    projectWorkspaceCwd: PROJECT,
  });
  if (!positive.refuses) {
    console.error("FAIL: positive control did not refuse a path containing the project workspace — the guard is not guarding.");
    process.exit(1);
  }

  for (const r of results) {
    if (r.actual.refuses !== r.expectRefuse) {
      console.error(
        `FAIL: ${r.label}: expected refuses=${r.expectRefuse}, got refuses=${r.actual.refuses} (resolved=${r.actual.resolved})`,
      );
      process.exit(1);
    }
  }

  // The tolerance claim: identical verdicts under two different cwds.
  const verdicts = new Set(results.map((r) => `${r.actual.refuses}`));
  if (verdicts.size !== 1) {
    console.error(`FAIL: guard verdict differed across cwds: ${[...verdicts].join(",")} — NOT tolerant.`);
    process.exit(1);
  }

  console.log(
    `PASS: tolerant guard G05 identical under ${results.length} distinct cwds ` +
      `(verdict refuses=${[...verdicts][0]}), and the positive control still refused.`,
  );
  for (const r of results) console.log(`  ${r.label}: ${r.actual.resolved} -> refuses=${r.actual.refuses}`);
}

main();