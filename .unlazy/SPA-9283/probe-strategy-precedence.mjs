// SPA-9283 — settles whether an explicit `workspaceStrategy.type` can defeat `agent_default`.
//
// A reviewer noted that both resolvers short-circuit on an explicit type *before* reaching the
// `agent_default` default, and that this would return `project_primary` for an `agent_default` card.
// That is true when the resolver is called directly, but the dispatch path never hands it such a
// config: `buildExecutionWorkspaceAdapterConfig` deletes `workspaceStrategy` for every mode except
// `isolated_workspace` (execution-workspace-policy.ts:448), and heartbeat.ts:21511 calls it.
//
// Both halves are printed so the distinction is visible rather than asserted: the resolver's
// isolated behaviour, then the config the dispatch path actually produces.
//
// Requires the built server dist to be present. Exits 2 with an explicit message when it is not,
// so a CI run without the payload cannot be mistaken for a passing one.
//
// Usage: node .unlazy/SPA-9283/probe-strategy-precedence.mjs

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const DIST = join(
  homedir(),
  ".paperclip/cli/current/node_modules/@paperclipai/server/dist",
);

if (!existsSync(join(DIST, "services/execution-workspace-policy.js"))) {
  console.error(
    `UNVERIFIABLE: server dist not found at ${DIST}. This probe asserts against the built ` +
      "engine and cannot be satisfied from a bare checkout. Treat as NOT RUN, not as passing.",
  );
  process.exit(2);
}

const policy = await import(join(DIST, "services/execution-workspace-policy.js"));

const MODE = "agent_default";
const explicit = { type: "project_primary" };

// 1. Resolver in isolation: an explicit type does win here.
const isolatedConfig = { workspaceStrategy: explicit };
const directEffective = policy.resolveEffectiveWorkspaceStrategyType(
  MODE,
  isolatedConfig,
);
const directPinned = policy.resolvePinnedIssueWorkspaceStrategyType({
  mode: MODE,
  issueSettings: { mode: MODE, workspaceStrategy: explicit },
});

console.log("-- resolver called directly with explicit project_primary --");
console.log("resolveEffectiveWorkspaceStrategyType:", directEffective);
console.log("resolvePinnedIssueWorkspaceStrategyType:", directPinned);

// 2. The dispatch path: buildExecutionWorkspaceAdapterConfig strips the key first.
const dispatched = policy.buildExecutionWorkspaceAdapterConfig({
  agentConfig: {
    workspaceStrategy: explicit,
    workspaceRuntime: { probe: true },
    preservedKey: "me",
  },
  projectPolicy: { enabled: true, defaultMode: "adapter_default" },
  issueSettings: { mode: MODE, workspaceStrategy: explicit },
  mode: MODE,
  legacyUseProjectWorkspace: null,
});

const stripped = !Object.prototype.hasOwnProperty.call(dispatched, "workspaceStrategy");
const effective = policy.resolveEffectiveWorkspaceStrategyType(MODE, dispatched);

console.log("\n-- does buildExecutionWorkspaceAdapterConfig strip it? --");
console.log("adapterConfig.workspaceStrategy =", JSON.stringify(dispatched.workspaceStrategy));
console.log("has workspaceStrategy key:", Object.prototype.hasOwnProperty.call(dispatched, "workspaceStrategy"));
console.log("agentDefault wins ->", effective);
console.log(
  "unrelated keys preserved:",
  dispatched.preservedKey === "me",
  "| workspaceRuntime stripped:",
  dispatched.workspaceRuntime === undefined,
);

const checks = [
  ["resolver honours an explicit type in isolation", directEffective === "project_primary" && directPinned === "project_primary"],
  ["dispatch path removes workspaceStrategy", stripped],
  ["dispatched config resolves to adapter_managed", effective === "adapter_managed"],
  ["unrelated agent config keys survive the strip", dispatched.preservedKey === "me"],
  ["agent_default still drops workspaceRuntime", dispatched.workspaceRuntime === undefined],
];

console.log("\n=== SUMMARY ===");
let ok = true;
for (const [label, pass] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}`);
  if (!pass) ok = false;
}
console.log(
  ok
    ? "GATE PASS: an explicit strategy type cannot defeat agent_default on the dispatch path"
    : "GATE FAIL",
);
process.exit(ok ? 0 : 1);
