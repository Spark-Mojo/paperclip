import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// SPA-12085 R2: the drain-then-restart operator command. These tests drive the
// script in --stub mode (canned API responses, no systemctl, no network) so a
// dry run and a drain timeout are exercised end-to-end without touching a live
// engine. The timeout negative asserts the script exits nonzero, names the
// still-live runs, restores the cap, and never issues a kill.
// Run: node --test ./scripts/__tests__/drain-then-restart.test.mjs

const SCRIPT = fileURLToPath(new URL("../drain-then-restart.sh", import.meta.url));
const SCRIPT_SOURCE = readFileSync(SCRIPT, "utf8");

function runScript(fixture, extraArgs = []) {
  const dir = mkdtempSync(path.join(tmpdir(), "drain-then-restart-"));
  const fixturePath = path.join(dir, "fixture.json");
  writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));
  const result = spawnSync("bash", [SCRIPT, "--stub", "--poll-seconds", "1", ...extraArgs], {
    env: {
      ...process.env,
      DRAIN_STUB_FIXTURE: fixturePath,
      // Keep the stub away from any real board token.
      PAPERCLIP_API_KEY: "",
      PAPERCLIP_API_URL: "http://127.0.0.1:1",
    },
    encoding: "utf8",
    timeout: 120_000,
  });
  return { ...result, fixturePath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function happyFixture(overrides = {}) {
  return {
    cap: { before: 8, afterPause: 0 },
    drain: { quiescentAfter: 1, stuckRunIds: "run-alive-1\trunning\n" },
    ui: { body: '<!DOCTYPE html><html><body><div id="root"></div></body></html>' },
    health: { body: '{"status":"ok"}' },
    restore: { status: 8 },
    ...overrides,
  };
}

test("drain-then-restart stub mode runs the full sequence and restores the cap", () => {
  const result = runScript(happyFixture());
  try {
    assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    const out = result.stdout;
    assert.match(out, /recorded cap: value=8/);
    assert.match(out, /admissions paused \(cap=0\)/);
    assert.match(out, /drained: 0 active runs/);
    assert.match(out, /STUB: would run: systemctl --user restart paperclip\.service/);
    assert.match(out, /probe OK: board UI served/);
    assert.match(out, /probe OK: health endpoint/);
    assert.match(out, /cap restored to value=8/);
    assert.match(out, /DONE/);
  } finally {
    result.cleanup();
  }
});

test("dry-run prints the plan and executes no restart", () => {
  const result = runScript(happyFixture(), ["--dry-run"]);
  try {
    assert.equal(result.status, 0);
    assert.match(result.stdout, /DRY-RUN: would run: systemctl --user restart/);
    assert.match(result.stdout, /DRY-RUN: would PATCH/);
  } finally {
    result.cleanup();
  }
});

test("drain timeout exits nonzero, names live runs, restores the cap, restarts nothing", () => {
  // quiescentAfter stays above 0 forever: every poll re-arms it.
  const fixture = happyFixture({
    drain: { quiescentAfter: 10_000, stuckRunIds: "run-alive-1\trunning\nrun-alive-2\tqueued\n" },
  });
  const result = runScript(fixture, ["--timeout-seconds", "2", "--poll-seconds", "1"]);
  try {
    assert.notEqual(result.status, 0);
    const out = result.stdout + result.stderr;
    assert.match(out, /DRAIN TIMEOUT/);
    assert.match(out, /run-alive-1/);
    assert.match(out, /run-alive-2/);
    assert.match(out, /nothing was restarted, nothing was killed/);
    assert.match(out, /restoring the recorded cap/);
    assert.doesNotMatch(out, /would run: systemctl --user restart/);
  } finally {
    result.cleanup();
  }
});

test("UI probe fails loudly on a UI-less response (SPA-11913)", () => {
  const fixture = happyFixture({ ui: { body: "404 Not Found" } });
  const result = runScript(fixture);
  try {
    assert.notEqual(result.status, 0);
    const out = result.stdout + result.stderr;
    assert.match(out, /probe FAILED: GET \//);
    assert.match(out, /id="root"/);
  } finally {
    result.cleanup();
  }
});

test("cap restore failure fails the run loudly", () => {
  const fixture = happyFixture({ restore: { status: 0 } });
  const result = runScript(fixture);
  try {
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /cap restore did not land/);
  } finally {
    result.cleanup();
  }
});

test("the script source contains no force-kill path", () => {
  // The ruling this script implements: timeout reports which runs are still
  // live and does NOT force-kill. Guard the source itself.
  assert.doesNotMatch(SCRIPT_SOURCE, /(^|\s)kill\s+-/);
  assert.doesNotMatch(SCRIPT_SOURCE, /systemctl\s+--user\s+kill/);
  assert.doesNotMatch(SCRIPT_SOURCE, /pkill|killall/);
});
