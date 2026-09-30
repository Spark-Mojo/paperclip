// SPA-9283 — non-destructive proof against the LIVE engine's own built dist.
//
// Replays the exact inputs of failed run a3173c97 (2026-09-29T00:10Z) through the guard that
// produced `workspace_validation_failed`, using the build that is actually serving runs today
// (~/.paperclip/cli/current). No database, no board write, no engine restart.
//
// The positive and the three negatives differ in exactly one variable — the requested mode — so a
// green run proves the mode is honoured rather than the harness being vacuous. `--negative-only`
// inverts the positive assertion and must exit 1, which is what makes the green run meaningful.
//
// Usage: node .unlazy/SPA-9283/probe-live-engine.mjs [--negative-only]

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const DIST = join(
  homedir(),
  ".paperclip/cli/current/node_modules/@paperclipai/server/dist",
);

// This probe asserts against the engine build that is actually serving runs, which exists only
// on a Paperclip host. A CI runner or a bare checkout cannot satisfy it, and an absent payload must
// never read as a pass — so it exits 2 with an explicit NOT RUN verdict instead.
if (!existsSync(join(DIST, "services/heartbeat.js"))) {
  console.error(
    `UNVERIFIABLE: server dist not found at ${DIST}. This probe asserts against the live built ` +
      "engine and cannot be satisfied from a bare checkout. Treat as NOT RUN, not as passing.",
  );
  process.exit(2);
}

const { assertGitSensitiveAdapterWorkspaceValid } = await import(
  join(DIST, "services/heartbeat.js")
);
const { resolveDefaultAgentWorkspaceDir } = await import(join(DIST, "home-paths.js"));

// Values lifted verbatim from the failed run a3173c97 and its persisted workspace row.
const AGENT_ID = "5f006ee1-0723-4512-bbed-ac0203f746af";
const ISSUE_ID = "51519792-d3a3-45a9-a618-3ca7042e5eb9";
const ISSUE_IDENTIFIER = "SPA-9283";
const PROJECT_ID = "eb4b407a-ab35-49ac-96e2-790fb2f79757";
const PROJECT_WORKSPACE_ID = "6e9b73d2-5309-4ba2-a753-41ac528f4a6b";
const PERSISTED_WORKSPACE_ID = "2409491f-a8e5-4b0b-903a-8f1738bf45b1";

const agentFallbackCwd = resolveDefaultAgentWorkspaceDir(AGENT_ID);
const negativeOnly = process.argv.includes("--negative-only");

function buildInput(mode) {
  return {
    adapterType: "opencode_local",
    agentId: AGENT_ID,
    issue: {
      id: ISSUE_ID,
      identifier: ISSUE_IDENTIFIER,
      projectId: PROJECT_ID,
      projectWorkspaceId: PROJECT_WORKSPACE_ID,
    },
    resolvedWorkspace: {
      cwd: agentFallbackCwd,
      source: "agent_home",
      projectId: PROJECT_ID,
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      workspaceHints: [],
      warnings: [],
      baseCwdFallback: false,
      materializationFailures: [],
      additionalWorkspaces: [],
    },
    executionWorkspace: {
      strategy: "project_primary",
      cwd: agentFallbackCwd,
      projectId: PROJECT_ID,
      workspaceId: null,
      worktreePath: null,
      branchName: null,
      created: false,
    },
    persistedExecutionWorkspace: {
      id: PERSISTED_WORKSPACE_ID,
      mode: "adapter_managed",
      strategyType: "project_primary",
      providerType: "local_fs",
      cwd: agentFallbackCwd,
      projectId: PROJECT_ID,
      projectWorkspaceId: PROJECT_WORKSPACE_ID,
      providerRef: null,
    },
    executionTarget: null,
    environmentDriver: "local",
    leaseMetadata: {},
    requestedExecutionWorkspaceMode: mode,
  };
}

async function probe(label, mode) {
  try {
    await assertGitSensitiveAdapterWorkspaceValid(buildInput(mode));
    console.log(`ALLOW  ${label}  (mode=${mode})`);
    return "ALLOW";
  } catch (error) {
    const detail = error?.resultJson?.workspaceValidation;
    console.log(
      `REFUSE ${label}  (mode=${mode})  code=${error?.code ?? "n/a"} reason=${detail?.reason ?? "n/a"}`,
    );
    console.log(`       msg=${String(error?.message ?? error).slice(0, 200)}`);
    return "REFUSE";
  }
}

const results = {};
results.positive_agent_default = await probe(
  "agent_default from agent-home cwd",
  "agent_default",
);
// The guard's real job: a code card that would commit into agent home must still be refused.
results.negative_isolated = await probe(
  "isolated_workspace from agent-home cwd",
  "isolated_workspace",
);
results.negative_operator = await probe(
  "operator_branch from agent-home cwd",
  "operator_branch",
);
results.negative_shared = await probe(
  "shared_workspace from agent-home cwd",
  "shared_workspace",
);

const expected = {
  positive_agent_default: negativeOnly ? "REFUSE" : "ALLOW",
  negative_isolated: "REFUSE",
  negative_operator: "REFUSE",
  negative_shared: "REFUSE",
};

let ok = true;
for (const [name, want] of Object.entries(expected)) {
  if (results[name] !== want) {
    console.log(`GATE FAIL ${name}: expected ${want} got ${results[name]}`);
    ok = false;
  }
}
console.log(
  ok
    ? "GATE PASS: agent_default ALLOWs, every non-agent_default mode still REFUSEs"
    : "GATE FAIL",
);
process.exit(ok ? 0 : 1);
