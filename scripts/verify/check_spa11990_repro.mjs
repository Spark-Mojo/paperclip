#!/usr/bin/env node
// SPA-11990 oracle - run from the repo root:
//
//   node scripts/verify/check_spa11990_repro.mjs
//
// PROVES: when a build step (tsc, pnpm -r) fails with its diagnostic on stdout
// and NOTHING on stderr, the installer's caller (cli/src/index.ts's
// console.error) receives that diagnostic. Before the fix, execFile's message
// was only an argv echo, so the operator saw "Command failed: <argv>" and never
// the real build error.
//
// HOW IT STAYS HONEST:
//   * It imports the REAL shipped wrapper out of cli/src/commands/install.ts
//     through the workspace's TypeScript runtime (tsx). Nothing is
//     reimplemented here - a copy of the wrapper would prove nothing.
//   * The child reads its diagnostic from a FILE, so the marker can never appear
//     in execFile's argv echo. Visibility therefore proves the captured OUTPUT
//     reached the caller, not the command echo.
//   * Every input is generated at runtime under mktemp; nothing under
//     .unlazy/, scratch, or any other gitignored path is required, so the
//     oracle is runnable from a clean checkout.
//   * A negative control runs first: an output-free child failure must NOT
//     surface the marker. If the marker ever appears there, the oracle fails
//     closed rather than reporting a false green.
//
// EXIT: 0 PASS - 1 FAIL - 2 CANNOT RUN (no TypeScript runtime present).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "spa11990-oracle-"));
process.on("exit", () => fs.rmSync(sandbox, { recursive: true, force: true }));

const MARKER = "SPA11990-MARKER-7f3a91c4";
const markerFile = path.join(sandbox, "build-error.txt");
fs.writeFileSync(
  markerFile,
  [
    MARKER,
    ": src/wake-loop-guard-index-migration.test.ts(200,58): error TS2554: Expected 0 arguments, but got 1.",
    "",
  ].join("\n"),
);

// ---- locate the TypeScript runtime (never assume node_modules exists) --------
const tsxCandidates = [
  path.join(repoRoot, "cli", "node_modules", "tsx", "dist", "cli.mjs"),
  path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
];
const tsx = tsxCandidates.find((candidate) => fs.existsSync(candidate));
if (!tsx) {
  console.error(
    "SPA11990-ORACLE: CANNOT RUN - no tsx runtime in this checkout; the cli unit suite (cli/src/__tests__/install-command.test.ts) is the equivalent oracle there.",
  );
  process.exit(2);
}

// ---- the oracle: the real wrapper, the real build-failure shape --------------
const wrapper = path.join(repoRoot, "cli", "src", "commands", "install.ts");

// The child script is assembled from JSON-quoted fragments so no quoting layer
// can corrupt it: read the diagnostic from the file, write it to STDOUT, write
// nothing to stderr, exit non-zero - exactly the tsc/pnpm -r failure shape.
const childSource = [
  "const fs = require(",
  JSON.stringify("fs"),
  ");",
  "process.stdout.write(fs.readFileSync(",
  JSON.stringify(markerFile),
  ",",
  JSON.stringify("utf8"),
  "));",
  "process.exit(2);",
].join("");

const driverSource = [
  "import { runCommandWithDiagnostics } from " + JSON.stringify(wrapper) + ";",
  "const child = " + JSON.stringify(childSource) + ";",
  "try {",
  "  await runCommandWithDiagnostics(process.execPath, ['-e', child], { maxBuffer: 32 * 1024 * 1024 });",
  "  console.error('SPA11990-ORACLE: FAIL - the wrapper resolved, expected a rejection');",
  "  process.exit(1);",
  "} catch (error) {",
  "  // Exactly what cli/src/index.ts does with the install command's throw.",
  "  console.error(error instanceof Error ? error.message : String(error));",
  "}",
  "",
].join("\n");

const driver = path.join(sandbox, "driver.mts");
fs.writeFileSync(driver, driverSource);

const result = spawnSync(process.execPath, [tsx, driver], { cwd: repoRoot, encoding: "utf8" });
const seen = String(result.stdout) + String(result.stderr);
console.log("driver exit=" + result.status);
console.log(seen.trim());

if (result.status !== 0) {
  console.error("SPA11990-ORACLE: FAIL - the diagnostics driver did not run");
  process.exit(1);
}

// ---- negative control THROUGH the wrapper: an output-free failure must -----
// ---- not fabricate diagnostics ---------------------------------------------
const silentDriver = path.join(sandbox, "driver-silent.mts");
const silentSource = [
  "import { runCommandWithDiagnostics } from " + JSON.stringify(wrapper) + ";",
  "try {",
  "  await runCommandWithDiagnostics(process.execPath, ['-e', 'process.exit(2)'], { maxBuffer: 32 * 1024 * 1024 });",
  "  console.error('SPA11990-ORACLE: silent child unexpectedly succeeded');",
  "} catch (error) {",
  "  // Exactly what cli/src/index.ts does with the install command's throw.",
  "  console.error(error instanceof Error ? error.message : String(error));",
  "}",
  "",
].join("\n");
fs.writeFileSync(silentDriver, silentSource);
const silent = spawnSync(process.execPath, [tsx, silentDriver], { cwd: repoRoot, encoding: "utf8" });
const silentText = String(silent.stdout) + String(silent.stderr);
if (silentText.includes(MARKER)) {
  console.error("SPA11990-ORACLE: FAIL - the wrapper fabricated the marker for an output-free failure; the assertion cannot discriminate.");
  process.exit(1);
}
console.log("negative control: an output-free child failure carries no marker (assertion discriminates)");
if (!seen.includes(MARKER)) {
  console.error("SPA11990-ORACLE: FAIL - the build diagnostic never reached the caller's stderr");
  process.exit(1);
}
if (!/error TS2554/.test(seen)) {
  console.error("SPA11990-ORACLE: FAIL - the marker is present but the tsc diagnostic line is missing");
  process.exit(1);
}
console.log("SPA11990-ORACLE: PASS - installer caller stderr carries " + MARKER);