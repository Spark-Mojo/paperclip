import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyPaperclipWakePayloadEnv,
  PAPERCLIP_WAKE_PAYLOAD_BYTES_ENV_KEY,
  PAPERCLIP_WAKE_PAYLOAD_FILE_ENV_KEY,
  PAPERCLIP_WAKE_PAYLOAD_INLINE_MAX_BYTES,
  PAPERCLIP_WAKE_PAYLOAD_JSON_ENV_KEY,
} from "./wake-payload-env.js";

// Mirrors the real payload shape the server builds in heartbeat.ts
// (buildPaperclipWakePayload): comments dominate the byte budget.
function buildOversizedWakePayloadJson(approxBytes: number): string {
  const filler = "x".repeat(64);
  const comments = [];
  let total = 0;
  let index = 0;
  while (total < approxBytes) {
    const body = `${index}:${filler}`;
    comments.push({
      id: `comment-${index}`,
      authorType: "user",
      authorId: "local-board",
      body,
      bodyTruncated: false,
      createdAt: "2026-09-28T18:00:00.000Z",
      updatedAt: "2026-09-28T18:00:00.000Z",
      deleted: false,
      sourceTrust: null,
    });
    total += body.length + 160;
    index += 1;
  }
  return JSON.stringify({
    reason: "issue_commented",
    issue: { id: "issue-1", identifier: "SPA-9259", title: "t", description: null },
    commentIds: comments.map((entry) => entry.id),
    comments,
    commentWindow: { requestedCount: comments.length, includedCount: comments.length, missingCount: 0 },
    truncated: false,
    fallbackFetchNeeded: false,
  });
}

const scratchDirs: string[] = [];

async function makeScratchDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wake-payload-env-test-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)));
});

describe("applyPaperclipWakePayloadEnv", () => {
  it("keeps small payloads inline in PAPERCLIP_WAKE_PAYLOAD_JSON with no file", async () => {
    const env: Record<string, string> = {};
    const json = JSON.stringify({ reason: "issue_assigned", issue: { id: "i1", identifier: "X-1" } });
    const result = await applyPaperclipWakePayloadEnv(env, { runId: "run-1", wakePayloadJson: json });
    expect(result.mode).toBe("inline");
    expect(result.filePath).toBeNull();
    expect(env[PAPERCLIP_WAKE_PAYLOAD_JSON_ENV_KEY]).toBe(json);
    expect(env[PAPERCLIP_WAKE_PAYLOAD_FILE_ENV_KEY]).toBeUndefined();
    expect(env[PAPERCLIP_WAKE_PAYLOAD_BYTES_ENV_KEY]).toBeUndefined();
  });

  it("stages an oversized payload to a file and drops the env-var copy (local)", async () => {
    const scratchDir = await makeScratchDir();
    const env: Record<string, string> = { PAPERCLIP_RUN_SCRATCH_DIR: scratchDir };
    const json = buildOversizedWakePayloadJson(PAPERCLIP_WAKE_PAYLOAD_INLINE_MAX_BYTES + 64 * 1024);
    expect(Buffer.byteLength(json, "utf8")).toBeGreaterThan(PAPERCLIP_WAKE_PAYLOAD_INLINE_MAX_BYTES);

    const result = await applyPaperclipWakePayloadEnv(env, { runId: "run-2", wakePayloadJson: json });
    expect(result.mode).toBe("file");
    expect(result.filePath).toBeTruthy();
    expect(env[PAPERCLIP_WAKE_PAYLOAD_JSON_ENV_KEY]).toBeUndefined();
    expect(env[PAPERCLIP_WAKE_PAYLOAD_FILE_ENV_KEY]).toBe(result.filePath);
    expect(env[PAPERCLIP_WAKE_PAYLOAD_BYTES_ENV_KEY]).toBe(String(Buffer.byteLength(json, "utf8")));

    // File is inside the run scratch dir and byte-identical to the payload.
    expect(path.dirname(result.filePath!)).toBe(scratchDir);
    const staged = await fs.readFile(result.filePath!, "utf8");
    expect(staged).toBe(json);
    expect(JSON.parse(staged).comments.length).toBeGreaterThan(0);
  });

  it("drops the env copy entirely on a remote execution target (no unreadable host file path)", async () => {
    const env: Record<string, string> = {};
    const json = buildOversizedWakePayloadJson(PAPERCLIP_WAKE_PAYLOAD_INLINE_MAX_BYTES + 64 * 1024);
    const result = await applyPaperclipWakePayloadEnv(env, {
      runId: "run-3",
      wakePayloadJson: json,
      executionTargetIsRemote: true,
    });
    expect(result.mode).toBe("dropped");
    expect(result.filePath).toBeNull();
    expect(env[PAPERCLIP_WAKE_PAYLOAD_JSON_ENV_KEY]).toBeUndefined();
    expect(env[PAPERCLIP_WAKE_PAYLOAD_FILE_ENV_KEY]).toBeUndefined();
    expect(env[PAPERCLIP_WAKE_PAYLOAD_BYTES_ENV_KEY]).toBe(String(Buffer.byteLength(json, "utf8")));
  });

  it("clears stale wake keys when no payload exists", async () => {
    const env: Record<string, string> = {
      [PAPERCLIP_WAKE_PAYLOAD_JSON_ENV_KEY]: '{"stale":true}',
      [PAPERCLIP_WAKE_PAYLOAD_FILE_ENV_KEY]: "/old/path.json",
      [PAPERCLIP_WAKE_PAYLOAD_BYTES_ENV_KEY]: "123",
    };
    const result = await applyPaperclipWakePayloadEnv(env, { runId: "run-4", wakePayloadJson: null });
    expect(result.mode).toBe("absent");
    expect(env[PAPERCLIP_WAKE_PAYLOAD_JSON_ENV_KEY]).toBeUndefined();
    expect(env[PAPERCLIP_WAKE_PAYLOAD_FILE_ENV_KEY]).toBeUndefined();
    expect(env[PAPERCLIP_WAKE_PAYLOAD_BYTES_ENV_KEY]).toBeUndefined();
  });

  // SPA-9259 regression: a 200 KiB payload must not kill the spawn. Before the
  // fix the whole payload rode in one env string, execve rejected it with
  // E2BIG (MAX_ARG_STRLEN = 128 KiB per single argv/env string), and the run
  // died before the agent CLI started. The child here is a real `node -e`
  // process reading the payload back from the staged file.
  it("a 200 KiB payload spawns without E2BIG and the child reads it from the file", { timeout: 30_000 }, async () => {
    const scratchDir = await makeScratchDir();
    const json = buildOversizedWakePayloadJson(200 * 1024);
    const env: Record<string, string> = { PAPERCLIP_RUN_SCRATCH_DIR: scratchDir };
    const result = await applyPaperclipWakePayloadEnv(env, { runId: "run-e2big", wakePayloadJson: json });
    expect(result.mode).toBe("file");
    expect(Buffer.byteLength(json, "utf8")).toBeGreaterThanOrEqual(200 * 1024);

    const childEnv: Record<string, string> = { ...env };
    // Every single env string must stay under Linux MAX_ARG_STRLEN (131072).
    for (const [key, value] of Object.entries(childEnv)) {
      expect(Buffer.byteLength(`${key}=${value}`, "utf8")).toBeLessThan(131072);
    }

    const childScript = `
      const fs = require("node:fs");
      const payloadPath = process.env.PAPERCLIP_WAKE_PAYLOAD_FILE;
      if (!payloadPath) { console.error("missing PAPERCLIP_WAKE_PAYLOAD_FILE"); process.exit(3); }
      if (process.env.PAPERCLIP_WAKE_PAYLOAD_JSON) { console.error("inline env var must be absent"); process.exit(4); }
      const parsed = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
      if (!Array.isArray(parsed.comments) || parsed.comments.length === 0) { console.error("bad payload"); process.exit(5); }
      process.stdout.write(String(parsed.comments.length));
    `;
    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", childScript], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? -1));
    });
    expect(exitCode).toBe(0);
  });
});
