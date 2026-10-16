import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

const {
  ensureAdapterExecutionTargetDirectory,
  ensureAdapterExecutionTargetCommandResolvable,
  maybeRunSandboxInstallCommand,
  runAdapterExecutionTargetProcess,
  describeAdapterExecutionTarget,
  resolveAdapterExecutionTargetCwd,
  prepareAdapterExecutionTargetRuntime,
} = vi.hoisted(() => {
  const restoreWorkspace = vi.fn(async () => {});
  return {
    ensureAdapterExecutionTargetDirectory: vi.fn(async () => {}),
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => {}),
    maybeRunSandboxInstallCommand: vi.fn(async () => null),
    runAdapterExecutionTargetProcess: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: [
        JSON.stringify({ type: "step_start", sessionID: "session-1" }),
        JSON.stringify({ type: "text", sessionID: "session-1", part: { text: "hello" } }),
        JSON.stringify({
          type: "step_finish",
          sessionID: "session-1",
          part: { cost: 0.001, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
        }),
      ].join("\n"),
      stderr: "",
      pid: 123,
      startedAt: new Date().toISOString(),
    })),
    describeAdapterExecutionTarget: vi.fn(() => "QA Cloudflare"),
    resolveAdapterExecutionTargetCwd: vi.fn((target, configuredCwd, fallbackCwd) => {
      if (typeof configuredCwd === "string" && configuredCwd.trim().length > 0) return configuredCwd;
      if (target && typeof target === "object" && "remoteCwd" in target && typeof target.remoteCwd === "string") {
        return target.remoteCwd;
      }
      return fallbackCwd;
    }),
    prepareAdapterExecutionTargetRuntime: vi.fn(async () => ({
      target: null,
      workspaceRemoteDir: "/remote/workspace/.paperclip-runtime/runs/test/workspace",
      runtimeRootDir: "/remote/workspace/.paperclip-runtime/runs/test/workspace/.paperclip-runtime/opencode",
      assetDirs: {
        xdgConfig: "/remote/workspace/.paperclip-runtime/runs/test/workspace/.paperclip-runtime/opencode/xdgConfig",
      },
      restoreWorkspace,
    })),
  };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetDirectory,
    ensureAdapterExecutionTargetCommandResolvable,
    maybeRunSandboxInstallCommand,
    runAdapterExecutionTargetProcess,
    describeAdapterExecutionTarget,
    resolveAdapterExecutionTargetCwd,
    prepareAdapterExecutionTargetRuntime,
  };
});

import { testEnvironment } from "./test.js";

describe("opencode remote environment diagnostics", () => {
  const configHomes: string[] = [];
  let configHome: string;

  beforeEach(async () => {
    configHome = await mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-test-config-"));
    vi.stubEnv("XDG_CONFIG_HOME", configHome);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    await rm(configHome, { recursive: true, force: true });
    await Promise.all(configHomes.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  });

  it.each([false, true])("stages remote runtime config assets for sandbox hello probes (managed=%s)", async (managed) => {
    const configHome = await mkdtemp(path.join(os.tmpdir(), "opencode-remote-test-config-"));
    configHomes.push(configHome);
    // SPA-12520 F3: seed the host configHome with host-derived material a
    // remote env-check must never stage — a sentinel file plus a permissive
    // opencode.json (the broad access F2 closed on the execute path).
    // NOTE: the "allow" string below is fixture-only seed data (what the
    // HOST config holds), never a generated policy — no blanket allow is
    // emitted by the adapter (guard below asserts the staged dir is the
    // generated deny-only temp dir).
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(path.join(configHome, "opencode"), { recursive: true });
    await writeFile(path.join(configHome, "opencode", "host-sentinel.txt"), "host-only\n", "utf8");
    await writeFile(
      path.join(configHome, "opencode", "opencode.json"),
      JSON.stringify({ permission: { external_directory: "allow" }, provider: { hostonly: {} } }),
      "utf8",
    );
    const remoteTarget: AdapterExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "cloudflare",
      remoteCwd: "/remote/workspace",
      runner: {
        execute: async () => ({
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: "",
          pid: null,
          startedAt: new Date().toISOString(),
        }),
      },
    };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "opencode_local",
      config: {
        command: "opencode",
        model: "anthropic/claude-sonnet-4-5",
        ...(managed ? {
          managedAiConnection: { provider: "openrouter", method: "api_key" },
        } : {}),
        env: {
          XDG_CONFIG_HOME: configHome,
          ...(managed ? { OPENAI_API_KEY: "", OPENROUTER_API_KEY: "fixture", HOME: "/var/folders/qa-managed", XDG_DATA_HOME: "/var/folders/qa-managed/data" } : {}),
        },
      },
      executionTarget: remoteTarget,
      environmentName: "QA Cloudflare",
    });

    expect(result.status).toBe("pass");
    expect(prepareAdapterExecutionTargetRuntime).toHaveBeenCalledTimes(1);
    const runtimeCalls = prepareAdapterExecutionTargetRuntime.mock.calls as unknown as Array<
      [{ adapterKey: string; assets?: Array<{ key: string; localDir: string }> }]
    >;
    const runtimeInput = runtimeCalls[0]?.[0];
    expect(runtimeInput?.adapterKey).toBe("opencode");
    expect(runtimeInput?.assets).toEqual([
      expect.objectContaining({
        key: "xdgConfig",
      }),
    ]);

    const probeCall = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as
      | [string, AdapterExecutionTarget, string, string[], { cwd: string; env: Record<string, string> }]
      | undefined;
    expect(probeCall?.[4].cwd).toBe("/remote/workspace/.paperclip-runtime/runs/test/workspace");
    if (managed) {
      expect(probeCall?.[4].env.HOME).toContain("/remote/workspace/.paperclip-runtime/runs/test/workspace/.paperclip-runtime/opencode/managed-auth/");
      expect(probeCall?.[4].env.XDG_DATA_HOME).toBe(`${probeCall?.[4].env.HOME}/data`);
      expect(probeCall?.[4].env.XDG_CACHE_HOME).toBe(`${probeCall?.[4].env.HOME}/cache`);
    }
    expect(probeCall?.[4].env.XDG_CONFIG_HOME).toBe(
      "/remote/workspace/.paperclip-runtime/runs/test/workspace/.paperclip-runtime/opencode/xdgConfig",
    );

    // SPA-12520 F3: remote env-check must stage nothing host-derived. The
    // staged xdgConfig asset is the generated deny-only temp dir from the
    // remote branch — never the caller-supplied host configHome (which may
    // hold opencode config incl. credentials + baked gateway keys). The
    // assert below pins the asset input BEFORE the remote rewrite: the
    // localDir handed to prepareAdapterExecutionTargetRuntime equals the
    // generated remoteConfigHome, not configHome.
    //
    // NOTE on read timing: testEnvironment's finally block runs
    // preparedRuntimeConfig.cleanup() before returning, so the generated
    // temp dir under TMPDIR is already removed here (same lifecycle as the
    // execute path). Host-derived exclusion is asserted on the recorded
    // asset INPUT (localDir path identity), not by reading the removed dir.
    // A pre-fix regression run (targetIsRemote not threaded) fails this
    // block: localDir === configHome (the seeded host dir).
    const stagedDir = (runtimeInput?.assets?.[0] as { localDir?: string } | undefined)?.localDir ?? "";
    expect(runtimeInput?.assets).toHaveLength(1);
    expect(stagedDir).not.toBe("");
    expect(stagedDir).not.toBe(configHome);
    expect(stagedDir).not.toContain("opencode-remote-test-config-");
    // The staged dir is the remote generated temp dir by NAME — the only
    // observable left after cleanup for the fixture seeded above: the local
    // branch would mint a COPY dir (paperclip-opencode-config-*, see
    // runtime-config.ts:191), the remote branch mints
    // "paperclip-opencode-remote-config-*". Host-sentinel / deny-shape of
    // the generated dir itself is covered unit-side in runtime-config.test.ts
    // (SPA-12581 F1+F2 fixtures, asserting the live generated files).
    expect(path.basename(stagedDir)).toMatch(/^paperclip-opencode-remote-config-/);
    // The seeded host-sentinel.txt marks WHAT the host dir holds (F1-class
    // host-derived material); path identity above is what pins it unstaged.
    // Content-exclusion of a copied host dir is covered unit-side in
    // runtime-config.test.ts (F1 sentinel-absent fixture).
  });
});
