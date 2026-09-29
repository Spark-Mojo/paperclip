import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const BASE = "694d0fbe002a7214f027a2f5d09a5b69d0686a4c";
const checks = [
  { name: "policy", command: ["node", "scripts/check-no-git-push.mjs"], timeout: 90_000 },
  { name: "serialized", command: ["pnpm", "test:run:serialized", "--", "--shard-index", "1", "--shard-count", "9"], timeout: 900_000 },
  { name: "workspaces-b", command: ["pnpm", "test:run:general", "--", "--group", "general-workspaces-b"], timeout: 900_000 },
];

function run(command, cwd, timeout) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    env: { ...process.env, CI: "true", PAPERCLIP_API_KEY: "", PAPERCLIP_RUN_ID: "", PAPERCLIP_AGENT_ID: "", PAPERCLIP_COMPANY_ID: "" },
    timeout,
    maxBuffer: 32 * 1024 * 1024,
    encoding: "utf8",
  });
  assert.equal(result.error, undefined, `${command[0]} launch/timeout failed: ${result.error?.code}`);
  assert.ok(Number.isInteger(result.status), `${command[0]} did not return an exit code`);
  return { exit: result.status, output: `${result.stdout}\n${result.stderr}` };
}

function version(cwd, binary, args) {
  const result = run([binary, ...args], cwd, 30_000);
  assert.equal(result.exit, 0);
  return result.output.trim();
}

function sha(cwd) {
  const value = run(["git", "rev-parse", "HEAD"], cwd, 30_000);
  assert.equal(value.exit, 0);
  return value.output.trim();
}

function summary(name, result) {
  const output = result.output.replace(/\x1b\[[0-9;]*m/g, "");
  const tests = [...output.matchAll(/Tests\s+(\d+) passed(?:\s*\|\s*(\d+) failed)?(?:\s*\|\s*(\d+) skipped)?/g)].at(-1);
  const files = [...output.matchAll(/Test Files\s+(\d+) passed(?:\s*\|\s*(\d+) failed)?/g)].at(-1);
  const signatures = [];
  if (name === "policy") {
    for (const match of output.matchAll(/(?:^|\n)([^\n]*workspace-runtime(?:\.test)?\.ts:\d+[^\n]*)/g)) signatures.push(match[1].trim());
  } else if (name === "serialized") {
    if (/issue-dependency-wakeups-routes\.test\.ts/.test(output) && /expected\s*200[\s\S]*?received\s*409|expected\s*409[\s\S]*?received\s*200/i.test(output)) signatures.push("issue-dependency-wakeups-routes:409/200");
  } else {
    if (/write EPIPE/.test(output) && /server-utils\.test\.ts/.test(output)) signatures.push("server-utils:write EPIPE");
    if (/process\.kill\(NaN\)/.test(output)) signatures.push("mcp-isolation:process.kill(NaN)");
  }
  return {
    exit: result.exit,
    files: files ? { passed: Number(files[1]), failed: Number(files[2] ?? 0) } : null,
    tests: tests ? { passed: Number(tests[1]), failed: Number(tests[2] ?? 0), skipped: Number(tests[3] ?? 0) } : null,
    signatures: [...new Set(signatures)].sort(),
  };
}

function validate(base, head) {
  for (const check of checks) {
    const left = base[check.name];
    const right = head[check.name];
    assert.ok(left && right, `missing ${check.name} result`);
    assert.ok(left.signatures.length && right.signatures.length, `unclassified ${check.name} failure`);
    assert.deepEqual(right, left, `head-only difference in ${check.name}`);
  }
}

if (process.argv.includes("--self-test")) {
  const fixture = {
    policy: { exit: 1, files: null, tests: null, signatures: ["workspace-runtime.ts:4884"] },
    serialized: { exit: 1, files: { passed: 14, failed: 1 }, tests: { passed: 8, failed: 1, skipped: 0 }, signatures: ["issue-dependency-wakeups-routes:409/200"] },
    "workspaces-b": { exit: 1, files: { passed: 59, failed: 0 }, tests: { passed: 1230, failed: 0, skipped: 5 }, signatures: ["server-utils:write EPIPE"] },
  };
  validate(fixture, structuredClone(fixture));
  for (const field of ["exit", "files", "tests", "signatures"]) {
    const corrupted = structuredClone(fixture);
    corrupted.serialized[field] = field === "signatures" ? ["new regression"] : null;
    assert.throws(() => validate(fixture, corrupted));
  }
  const missing = structuredClone(fixture);
  missing["workspaces-b"].signatures = [];
  assert.throws(() => validate(fixture, missing));
  process.stdout.write("BASELINE_ORACLE_NEGATIVE_CONTROLS_PASS\n");
  process.exit(0);
}

const args = process.argv.slice(2);
const baseDir = args[args.indexOf("--base-dir") + 1];
const headDir = args[args.indexOf("--head-dir") + 1];
assert.ok(args.includes("--base-dir") && args.includes("--head-dir") && baseDir && headDir, "pass --base-dir and --head-dir");
assert.equal(sha(baseDir), BASE, "base checkout must be pinned");
const headSha = sha(headDir);
assert.match(headSha, /^[0-9a-f]{40}$/);
assert.notEqual(headSha, BASE);
assert.equal(version(baseDir, "node", ["--version"]), version(headDir, "node", ["--version"]));
assert.equal(version(headDir, "node", ["--version"]), "v24.21.0", "CI used Node 24.21.0");
assert.equal(version(baseDir, "pnpm", ["--version"]), "9.15.4");
assert.equal(version(headDir, "pnpm", ["--version"]), "9.15.4");
const lock = (dir) => createHash("sha256").update(readFileSync(path.join(dir, "pnpm-lock.yaml"))).digest("hex");
assert.equal(lock(baseDir), lock(headDir), "lockfile mismatch");
const workflow = readFileSync(path.join(headDir, ".github/workflows/pr-trusted.yml"), "utf8");
assert.ok(/POLICY_RESULT:.*needs\.policy\.result/.test(workflow), "verify policy wiring changed");
assert.ok(/GENERAL_TESTS_RESULT:.*needs\.general_tests\.result/.test(workflow), "verify general tests wiring changed");
assert.ok(/E2E_SHARDS_RESULT:.*needs\.e2e_shards\.result/.test(workflow), "e2e aggregator wiring changed");
const results = { base: {}, head: {} };
for (const check of checks) {
  for (const [side, dir] of [["base", baseDir], ["head", headDir]]) {
    const result = run(check.command, dir, check.timeout);
    results[side][check.name] = summary(check.name, result);
    process.stdout.write(`${side} ${check.name} ${JSON.stringify(results[side][check.name])}\n`);
  }
}
validate(results.base, results.head);
assert.ok(!results.head["workspaces-b"].signatures.includes("mcp-isolation:process.kill(NaN)"), "local-only NaN differs from CI; require pinned-base CI evidence");
process.stdout.write(`BASELINE_EQUIVALENT policy serialized workspaces-b base=${BASE} head=${headSha}\n`);
