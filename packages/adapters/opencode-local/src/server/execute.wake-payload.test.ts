import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { execute } from "./execute.js";

const execFileAsync = promisify(execFile);

interface CapturePayload {
  argv: string[];
  env: Record<string, string>;
  envSizes: Record<string, number>;
  wakePayloadJson: string | null;
  wakePayloadFile: string | null;
  wakePayloadFileBytes: number | null;
}

const cleanupDirs = new Set<string>();

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupDirs.add(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  cleanupDirs.clear();
});

async function writeFakeOpenCodeCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
if (argv[0] === "models") {
  process.stdout.write("fake/model - Fake test model\\n");
  process.exit(0);
}
const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
const envSizes = {};
for (const [key, value] of Object.entries(process.env)) {
  envSizes[key] = Buffer.byteLength(String(value), "utf8");
}
const wakeFile = process.env.PAPERCLIP_WAKE_PAYLOAD_FILE || null;
const payload = {
  argv,
  env: {
    PAPERCLIP_RUN_ID: process.env.PAPERCLIP_RUN_ID || null,
    PAPERCLIP_TASK_ID: process.env.PAPERCLIP_TASK_ID || null,
    PAPERCLIP_WAKE_REASON: process.env.PAPERCLIP_WAKE_REASON || null,
  },
  envSizes,
  wakePayloadJson: process.env.PAPERCLIP_WAKE_PAYLOAD_JSON || null,
  wakePayloadFile: wakeFile,
  wakePayloadFileBytes: wakeFile ? fs.statSync(wakeFile).size : null,
};
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
}
process.stdout.write(JSON.stringify({ type: "session", sessionID: "sess-fake-1" }) + "\\n");
process.stdout.write(JSON.stringify({ info: { model: "fake/model", tokens: { input: 1, output: 1 } } }) + "\\n");
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

function buildOversizedPaperclipWake(approxBytes: number): Record<string, unknown> {
  const filler = "y".repeat(96);
  const comments: Array<Record<string, unknown>> = [];
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
    total += body.length + 170;
    index += 1;
  }
  return {
    reason: "issue_commented",
    issue: { id: "issue-1", identifier: "SPA-9259", title: "oversized wake", description: null },
    commentIds: comments.map((entry) => entry.id as string),
    comments,
    commentWindow: { requestedCount: comments.length, includedCount: comments.length, missingCount: 0 },
    truncated: false,
    fallbackFetchNeeded: false,
  };
}

function buildCtx(input: {
  root: string;
  capturePath: string;
  paperclipWake: Record<string, unknown> | null;
}) {
  return {
    runId: "run-wake-e2big",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Opencode Agent",
      adapterType: "opencode_local",
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {
      command: path.join(input.root, "opencode"),
      cwd: path.join(input.root, "workspace"),
      model: "fake/model",
      env: { PAPERCLIP_TEST_CAPTURE_PATH: input.capturePath },
      dangerouslySkipPermissions: false,
      promptTemplate: "Do the work.",
    },
    context: {
      taskId: "issue-1",
      issueId: "issue-1",
      wakeReason: "issue_commented",
      ...(input.paperclipWake ? { paperclipWake: input.paperclipWake } : {}),
    },
    onLog: async () => {},
    onMeta: undefined,
    onSpawn: undefined,
    authToken: "run-token",
  };
}

describe("opencode_local wake payload env staging (SPA-9259)", () => {
  it("keeps a small wake payload inline in PAPERCLIP_WAKE_PAYLOAD_JSON", async () => {
    const root = await makeTempDir("opencode-wake-inline-");
    const capturePath = path.join(root, "capture.json");
    await writeFakeOpenCodeCommand(path.join(root, "opencode"));
    await fs.mkdir(path.join(root, "workspace"), { recursive: true });

    const smallWake = {
      reason: "issue_assigned",
      issue: { id: "issue-1", identifier: "SPA-9259", title: "t", description: null },
      commentIds: [],
      comments: [],
    };

    const result = await execute(buildCtx({ root, capturePath, paperclipWake: smallWake }) as never);
    expect(result.exitCode ?? 0).toBe(0);

    const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
    expect(capture.wakePayloadJson).toBeTruthy();
    expect(JSON.parse(capture.wakePayloadJson!)).toMatchObject({ reason: "issue_assigned" });
    expect(capture.wakePayloadFile).toBeNull();
  });

  it("stages an oversized wake payload to a file and keeps every env string spawnable", { timeout: 60_000 }, async () => {
    const root = await makeTempDir("opencode-wake-e2big-");
    const capturePath = path.join(root, "capture.json");
    const scratchDir = await makeTempDir("opencode-wake-scratch-");
    await writeFakeOpenCodeCommand(path.join(root, "opencode"));
    await fs.mkdir(path.join(root, "workspace"), { recursive: true });

    const oversizedWake = buildOversizedPaperclipWake(200 * 1024);
    const ctx = buildCtx({ root, capturePath, paperclipWake: oversizedWake });
    // The heartbeat server puts the run scratch dir in the adapter config env;
    // the wake payload file must land inside it.
    (ctx.config as Record<string, unknown>).env = {
      PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
      PAPERCLIP_RUN_SCRATCH_DIR: scratchDir,
    };

    const result = await execute(ctx as never);
    expect(result.exitCode ?? 0).toBe(0);

    const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
    // The spawn actually happened, so nothing hit E2BIG.
    expect(capture.env.PAPERCLIP_RUN_ID).toBe("run-wake-e2big");
    // Inline env copy gone; file pointer present and inside the run scratch dir.
    expect(capture.wakePayloadJson).toBeNull();
    expect(capture.wakePayloadFile).toBeTruthy();
    expect(path.dirname(capture.wakePayloadFile!)).toBe(scratchDir);
    // The staged file holds the full payload — and exceeds the 128 KiB
    // MAX_ARG_STRLEN that killed spawns before the fix.
    expect(capture.wakePayloadFileBytes).toBeGreaterThan(128 * 1024);
    // Regression invariant: no single env string may approach MAX_ARG_STRLEN.
    for (const [key, size] of Object.entries(capture.envSizes)) {
      expect(size).toBeLessThan(128 * 1024);
    }
  });
});
