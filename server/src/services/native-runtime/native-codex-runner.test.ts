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
import { getSpawnAdmissionFence } from "@paperclipai/adapter-utils/server-utils";

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

describe("native runner spawn admission (SPA-11948 R2)", () => {
  it.skipIf(process.platform !== "linux")(
    "refuses a native runner spawned after shutdown closed the admission gate",
    async () => {
      // The native codex runner spawns its own `paperclip-agent-*.scope`
      // directly instead of going through the adapter `runChildProcess`
      // path, so the spawn-during-shutdown fence must be taken HERE too:
      // a runner spawned between the shutdown close and the durable
      // `onSpawn` registration would otherwise survive the restart as an
      // orphan holding a cap slot. The oracle: with the gate closed, the
      // run rejects with `spawn_admission_closed`, the scope's cgroup is
      // signalled by the fence, `onSpawn` never fires, the PRP lease is
      // released, and no admission lease is left outstanding.
      const getFence = getSpawnAdmissionFence as unknown as
        | (() => {
            reopen(): void;
            close(): void;
            isClosed(): boolean;
            inFlight(): number;
          })
        | undefined;
      expect(
        typeof getFence,
        "missing_spawn_admission_api:getSpawnAdmissionFence",
      ).toBe("function");
      const fence = getFence!();
      fence.reopen();
      expect(fence.inFlight()).toBe(0);

      const root = await mkdtemp(join(tmpdir(), "native-spawn-fence-"));
      const onSpawn = vi.fn(async () => {});
      release.mockClear();
      prepare.mockClear();
      try {
        fence.close();
        expect(fence.isClosed()).toBe(true);

        await expect(
          executeNativeCodexRunner({
            db: {} as Parameters<typeof executeNativeCodexRunner>[0]["db"],
            companyId: randomUUID(),
            issueId: randomUUID(),
            runId: randomUUID(),
            agentId: randomUUID(),
            runnerInstanceId: randomUUID(),
            environmentLeaseId: "lease-1",
            normalizedSessionId: randomUUID(),
            turnId: "turn-1",
            // NUL byte carried through to the spawn argv for the
            // sync-spawn-throw sibling test; harmless for the
            // admit-refusal sibling (it never reaches the spawn argv
            // because the gate is closed first).
            itemId: process.env.PAPERCLIP_TEST_SPA_NUL_ITEMID === "1" ? "item-1\u0000" : "item-1",
            cwd: root,
            prompt: "test",
            model: null,
            resumeProviderSessionId: null,
            completionContract: { revision: "1", criterionIds: [] },
            timeoutMs: 5_000,
            environment: {},
            // A real executable: the spawn must succeed so the refusal is
            // the fence's, not an OS spawn error.
            runnerBinary: process.execPath,
            runtimeRoot: root,
            onLog: async () => {},
            onSpawn,
          }),
        ).rejects.toThrow("spawn_admission_closed");

        expect(onSpawn).not.toHaveBeenCalled();
        expect(
          fence.inFlight(),
          "native_runner_spawn_left_an_admission_lease_outstanding",
        ).toBe(0);
        expect(release).toHaveBeenCalledOnce();
      } finally {
        fence.reopen();
        await rm(root, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it.skipIf(process.platform !== "linux")(
    "settles the admission lease and releases the PRP registration when spawn throws synchronously",
    async () => {
      // Companion to the refusal oracle above: a SYNCHRONOUS `spawn()` throw
      // (here: a NUL byte in the binary path, `ERR_INVALID_ARG_VALUE`)
      // happens after the admission lease is taken but before the outer run
      // try owns `prepared.release()`. The catch must settle the admission
      // lease AND release the environment lease, or the fence drain wedges
      // and the PRP registration leaks.
      const getFence = getSpawnAdmissionFence as unknown as
        | (() => {
            reopen(): void;
            close(): void;
            isClosed(): boolean;
            inFlight(): number;
          })
        | undefined;
      expect(
        typeof getFence,
        "missing_spawn_admission_api:getSpawnAdmissionFence",
      ).toBe("function");
      const fence = getFence!();
      fence.reopen();
      expect(fence.inFlight()).toBe(0);

      const root = await mkdtemp(join(tmpdir(), "native-spawn-sync-throw-"));
      const onSpawn = vi.fn(async () => {});
      release.mockClear();
      prepare.mockClear();
      const priorNulFlag = process.env.PAPERCLIP_TEST_SPA_NUL_ITEMID;
      process.env.PAPERCLIP_TEST_SPA_NUL_ITEMID = "1";
      try {
        expect(fence.isClosed()).toBe(false);

        await expect(
          executeNativeCodexRunner({
            db: {} as Parameters<typeof executeNativeCodexRunner>[0]["db"],
            companyId: randomUUID(),
            issueId: randomUUID(),
            runId: randomUUID(),
            agentId: randomUUID(),
            runnerInstanceId: randomUUID(),
            environmentLeaseId: "lease-1",
            normalizedSessionId: randomUUID(),
            turnId: "turn-1",
            // NUL byte carried through to the spawn argv for the
            // sync-spawn-throw sibling test; harmless for the
            // admit-refusal sibling (it never reaches the spawn argv
            // because the gate is closed first).
            itemId: process.env.PAPERCLIP_TEST_SPA_NUL_ITEMID === "1" ? "item-1\u0000" : "item-1",
            cwd: root,
            prompt: "test",
            model: null,
            resumeProviderSessionId: null,
            completionContract: { revision: "1", criterionIds: [] },
            timeoutMs: 5_000,
            environment: {},
            // A clean binary (digest + prepare must succeed) with a NUL byte
            // in an argument value: `spawn()` itself throws synchronously --
            // the exact window between `enterAdmission()` and the outer
            // run try that owns `prepared.release()`. itemId flows verbatim
            // into the spawn argv (see `buildNativeRunnerArguments` -- it
            // becomes `--item-id <itemId>`), so the NUL rides into the
            // synchronous `spawn()` arg-validation step.
            runnerBinary: process.execPath,
            runtimeRoot: root,
            onLog: async () => {},
            onSpawn,
          }),
        ).rejects.toThrow();

        expect(onSpawn).not.toHaveBeenCalled();
        expect(
          fence.inFlight(),
          "sync_spawn_throw_left_an_admission_lease_outstanding",
        ).toBe(0);
        expect(
          release,
          "sync_spawn_throw_leaked_the_prp_registration",
        ).toHaveBeenCalledOnce();
      } finally {
        fence.reopen();
        if (priorNulFlag === undefined) delete process.env.PAPERCLIP_TEST_SPA_NUL_ITEMID;
        else process.env.PAPERCLIP_TEST_SPA_NUL_ITEMID = priorNulFlag;
        await rm(root, { recursive: true, force: true });
      }
    },
    20_000,
  );
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
