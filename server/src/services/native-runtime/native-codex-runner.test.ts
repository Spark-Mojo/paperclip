import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const release = vi.hoisted(() => vi.fn(async () => {}));
const prepare = vi.hoisted(() => vi.fn(async () => ({
  release,
  queueCommand: () => {},
  semanticTools: [],
  connectUrl: "ws://127.0.0.1:3100/runner",
})));
vi.mock("./runner-prp-coordinator.js", () => ({ runnerPrpCoordinator: () => ({ prepare }) }));

import type { PaperclipSemanticToolDefinition } from "../../vendor/paperclip-runner/index.js";
import {
  buildNativeRunnerArguments,
  buildNativeRunnerPreparePayload,
  executeNativeCodexRunner,
} from "./native-codex-runner.js";

describe("native runner scope cleanup", () => {
  it.skipIf(process.platform !== "linux")("releases the prepared PRP registration when the resource limit is malformed", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-scope-regression-"));
    const binary = join(root, "runner-binary");
    const prior = process.env.PAPERCLIP_RUN_TASKS_MAX;
    await writeFile(binary, "fixture");
    process.env.PAPERCLIP_RUN_TASKS_MAX = "invalid";
    release.mockClear();
    prepare.mockClear();
    try {
      await expect(executeNativeCodexRunner({
        db: {} as Parameters<typeof executeNativeCodexRunner>[0]["db"],
        companyId: randomUUID(), issueId: randomUUID(), runId: randomUUID(), agentId: randomUUID(),
        runnerInstanceId: randomUUID(), environmentLeaseId: "lease-1", normalizedSessionId: randomUUID(),
        turnId: "turn-1", itemId: "item-1", cwd: root, prompt: "test", model: null,
        resumeProviderSessionId: null, completionContract: { revision: "1", criterionIds: [] },
        timeoutMs: 1_000, environment: {}, runnerBinary: binary, runtimeRoot: root,
        onLog: async () => {}, onSpawn: async () => {},
      })).rejects.toThrow("invalid_run_resource_limit");
      expect(prepare).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
    } finally {
      if (prior === undefined) delete process.env.PAPERCLIP_RUN_TASKS_MAX;
      else process.env.PAPERCLIP_RUN_TASKS_MAX = prior;
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("buildNativeRunnerArguments", () => {
  it("binds every durable identity without exposing the bootstrap ticket", () => {
    const args = buildNativeRunnerArguments({
      connectUrl: "ws://127.0.0.1:3000/api/runner/v1/connect/run-1",
      stateDirectory: "/tmp/runner-state",
      runnerInstanceId: "runner-1",
      environmentLeaseId: "lease-1",
      runId: "run-1",
      normalizedSessionId: "session-1",
      turnId: "turn-1",
      itemId: "item-1",
      runnerDigest: `sha256:${"a".repeat(64)}`,
      maxRuntimeMs: 60_000,
    });
    expect(args).toContain("--connect-url");
    expect(args).toContain("--runner-digest");
    expect(args.join(" ")).not.toContain("bootstrap");
  });
});

const tool: PaperclipSemanticToolDefinition = {
  name: "get_task_context",
  description: "Read the active task context.",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  annotations: {
    semanticContract: "paperclip.semantic-action.v1",
    version: 1,
    placement: "always",
    effect: "read",
    requiredClaims: [],
  },
};

describe("buildNativeRunnerPreparePayload", () => {
  it("binds the coordinator tool projection to run.prepare", () => {
    expect(buildNativeRunnerPreparePayload({
      cwd: "/workspace",
      model: "test-model",
      resumeProviderSessionId: "thread-1",
      completionContract: { revision: "1", criterionIds: ["objective"] },
      semanticTools: [tool],
      providerLaunch: {
        command: "/bin/fake-codex",
        args: ["app-server"],
        providerVersion: "fake-1",
      },
    })).toMatchObject({
      provider: {
        kind: "codex",
        provider: "codex",
        driver: "codex_app_server",
        providerSessionId: "thread-1",
      },
      authorizedTools: {
        schema: "paperclip.runner.authorized-tools.v1",
        schemaVersion: 1,
        catalogDigest:
          "sha256:4e0332535c9e2ff1f5e43089517ee1b46654bfc9cb2ed51efbea4be50db21009",
        operations: [{ operationId: "get_task_context", version: 1 }],
      },
    });
  });
});
