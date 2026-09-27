/**
 * Regression test for onSpawn forwarding in the hermes-local adapter.
 *
 * Ensures ctx.onSpawn is forwarded to runChildProcess() so the orphan
 * reaper can track live child processes by PID, preventing false-positive
 * reaps on runs whose updatedAt becomes stale.
 *
 * @see https://github.com/paperclipai/paperclip/issues/8723
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the adapter-utils server-utils module that execute.ts imports from.
// We intercept runChildProcess so we can inspect its opts without spawning
// a real child process.
vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    })),
  };
});

// Mock fs and path resolution to avoid real file reads in execute()
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => ""),
  writeFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  access: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false })),
}));

import { execute } from "./execute.js";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";

function makeCtx(overrides: Record<string, unknown> = {}) {
  const onSpawn = vi.fn(async () => undefined);
  return {
    ctx: {
      runId: "test-run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Hermes",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "/usr/bin/hermes",
        timeoutSec: 60,
        graceSec: 5,
        ...overrides,
      },
      context: {
        issueId: "issue-1",
        wakeReason: "manual",
        paperclipWake: null,
      },
      onLog: vi.fn(async () => undefined),
      onMeta: vi.fn(async () => undefined),
      onSpawn,
    } satisfies Record<string, unknown>,
    onSpawn,
  };
}

describe("hermes-local adapter onSpawn forwarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards ctx.onSpawn to runChildProcess", async () => {
    const { ctx, onSpawn } = makeCtx();

    // execute() will call runChildProcess internally.
    // We expect it to propagate ctx.onSpawn.
    // Because we mocked runChildProcess, the actual child doesn't spawn,
    // but we can verify it was called with onSpawn.
    try {
      await execute(ctx as any);
    } catch {
      // execute may fail due to missing hermes binary / env — that's OK,
      // we only care that runChildProcess was called with onSpawn.
    }

    const mocked = vi.mocked(serverUtils.runChildProcess);
    expect(mocked.mock.calls.length).toBeGreaterThan(0);
    const lastCall = mocked.mock.calls[mocked.mock.calls.length - 1];
    const opts = lastCall[3] as Record<string, unknown>;
    expect(opts.onSpawn).toBe(onSpawn);
  });

  it("runChildProcess opts type includes onSpawn", () => {
    // Type-level assertion: if onSpawn were removed from the type,
    // this file would fail to compile. The runtime test above catches
    // the behavioral case; this documents the contract.
    const opts: Parameters<typeof serverUtils.runChildProcess>[3] = {
      cwd: "/tmp",
      env: {},
      timeoutSec: 60,
      graceSec: 5,
      onLog: async () => undefined,
      onSpawn: async () => undefined,
    };
    expect(opts.onSpawn).toBeDefined();
  });

  it("preserves a specific stderr diagnostic for a nonzero exit", async () => {
    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "Error: provider unavailable\n",
      pid: null,
      startedAt: null,
    });

    const { ctx } = makeCtx();
    const result = await execute(ctx as any);

    expect(result.errorMessage).toBe("Error: provider unavailable");
  });

  it("reports the exit code when a nonzero exit has no diagnostic", async () => {
    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode: 130,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      pid: null,
      startedAt: null,
    });

    const { ctx } = makeCtx();
    const result = await execute(ctx as any);

    expect(result.errorMessage).toBe("Hermes exited with code 130");
  });

  it("leaves timeout diagnostics to the heartbeat timeout path", async () => {
    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode: 143,
      signal: "SIGTERM",
      timedOut: true,
      stdout: "",
      stderr: "",
      pid: null,
      startedAt: null,
    });

    const { ctx } = makeCtx();
    const result = await execute(ctx as any);

    expect(result.errorMessage).toBeUndefined();
  });

  it("does not label signal cancellation as a silent nonzero exit", async () => {
    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode: null,
      signal: "SIGTERM",
      timedOut: false,
      stdout: "",
      stderr: "",
      pid: null,
      startedAt: null,
    });

    const { ctx } = makeCtx();
    const result = await execute(ctx as any);

    expect(result.errorMessage).toBeUndefined();
  });

  it("does not inherit PAPERCLIP_API_KEY without a harness token", async () => {
    const previousApiKey = process.env.PAPERCLIP_API_KEY;
    process.env.PAPERCLIP_API_KEY = "parent-process-key";

    try {
      const { ctx } = makeCtx();
      await execute(ctx as any);

      const mocked = vi.mocked(serverUtils.runChildProcess);
      const lastCall = mocked.mock.calls[mocked.mock.calls.length - 1];
      const opts = lastCall[3] as { env: Record<string, string> };
      expect(opts.env.PAPERCLIP_API_KEY).toBeUndefined();
    } finally {
      if (previousApiKey === undefined) delete process.env.PAPERCLIP_API_KEY;
      else process.env.PAPERCLIP_API_KEY = previousApiKey;
    }
  });

  // SPA-8967: hermes used to put the assembled prompt in argv, which on
  // Linux fails spawn with E2BIG once the prompt passes ~128KB. The fix
  // passes the prompt by file/stdin via the engine's promptFileBody handoff
  // and points hermes's CLI prompt slot at `-`. Both halves are covered:
  it("forwards the assembled prompt via promptFileBody and never via argv (SPA-8967)", async () => {
    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      pid: null,
      startedAt: null,
    });

    const { ctx } = makeCtx();
    try {
      await execute(ctx as any);
    } catch {
      // ignore — we only care about the runChildProcess call shape
    }

    const mocked = vi.mocked(serverUtils.runChildProcess);
    const lastCall = mocked.mock.calls[mocked.mock.calls.length - 1];
    const cmd = lastCall[1];
    const args = lastCall[2] as string[];
    const opts = lastCall[3] as {
      promptFileBody?: string;
      stdin?: string;
    };

    // Args must point at the stdin placeholder, never at a real prompt body.
    // A regression to the old shape would show the prompt itself appearing
    // somewhere in `args`, which is exactly the argv E2BIG site.
    expect(cmd).toBe("hermes");
    expect(args[0]).toBe("chat");
    expect(args[1]).toBe("-q");
    expect(args[2]).toBe("-"); // stdin placeholder, NOT a prompt body
    // No element of args may be a real prompt body. The adapter's job is to
    // move large bodies off argv; doing the migration but leaving a copy in
    // args would defeat the entire fix.
    for (const value of args) {
      if (typeof value !== "string") continue;
      expect(value.length).toBeLessThan(1024);
    }
    // The prompt body travels via the engine contract, not stdin (stdin is
    // reserved for the adapter's steady-state transport choice; today we
    // route the body through the file handoff and let the engine wire stdin
    // when the body fits). Either is acceptable as long as the body NEVER
    // rides in argv. We assert the body is present in exactly one of:
    if (typeof opts.promptFileBody === "string") {
      expect(opts.promptFileBody.length).toBeGreaterThan(0);
    } else {
      expect(typeof opts.stdin).toBe("string");
      expect((opts.stdin as string).length).toBeGreaterThan(0);
    }
  });
});
