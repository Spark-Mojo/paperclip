import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { HarnessDriverBackend } from "../../backends/harness-driver-backend.js";
import type { PrpEvent } from "../../protocol/replay-contract.js";
import { OpenCodeServerDriver } from "./opencode-server-driver.js";

/**
 * SSE loss with a governed runtime request still pending (SPA-19293 / d1).
 *
 * The harness-driver backend turns "stream lost while a `question.asked`
 * input request is unanswered" into runtime_request.expired
 * (provider_process_lost) + turn.interrupted: a governed wait. That only
 * happens when the driver itself has emitted NO terminal turn event and has
 * not already settled the request. A driver-emitted turn.failed
 * (client-disconnect) would pre-empt it and turn a resumable wait into a
 * failure. With NO pending request, the driver must still fail the turn as
 * client-disconnect.
 *
 * Scenarios are driven through an inline scripted `fetch`/SSE stream, so
 * they are deterministic and offline.
 */

const fixture = resolve("test/fixtures/fake-opencode-server.mjs");
const MODEL = "openrouter/deepseek/deepseek-v4-flash-0731";
const roots: string[] = [];

const TERMINAL = new Set([
  "turn.completed",
  "turn.failed",
  "turn.interrupted",
  "turn.cancelled",
]);

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

afterAll(async () => {
  await chmod(fixture, 0o644);
});

interface ScriptApi {
  providerSessionId: string;
  emit: (event: Record<string, unknown>) => void;
  /** End the SSE stream; every later /event reconnect is also closed at once. */
  dropStream: () => void;
}

interface Scenario {
  name: string;
  /** Runs inside POST prompt_async, i.e. after the turn has started. */
  onPrompt: (api: ScriptApi) => void;
}

async function buildDriver(scenario: Scenario) {
  await chmod(fixture, 0o755);
  const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-pending-"));
  const workspace = await mkdtemp(
    join(tmpdir(), "paperclip-opencode-pending-workspace-"),
  );
  roots.push(root, workspace);
  const providerSessionId = `provider-session-${scenario.name}`;
  const encoder = new TextEncoder();
  const queuedFrames: Uint8Array[] = [];
  let streamController: ReadableStreamDefaultController<Uint8Array> | null =
    null;
  let streamClosed = false;
  let frameCounter = 0;
  const emit = (event: Record<string, unknown>) => {
    const frame = encoder.encode(
      `data: ${JSON.stringify({ id: `native-${scenario.name}-${++frameCounter}`, ...event })}\n\n`,
    );
    if (streamController) streamController.enqueue(frame);
    else queuedFrames.push(frame);
  };
  const dropStream = () => {
    streamClosed = true;
    try {
      streamController?.close();
    } catch {
      // already closed
    }
  };
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const fetcher: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = String(init?.method ?? "GET").toUpperCase();
    if (url.pathname === "/global/health")
      return json({ healthy: true, version: "1.18.34" });
    if (url.pathname === "/event") {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            for (const frame of queuedFrames.splice(0))
              controller.enqueue(frame);
            if (streamClosed) controller.close();
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    }
    if (method === "POST" && url.pathname === "/session")
      return json({ id: providerSessionId });
    if (method === "GET" && url.pathname === "/question") return json([]);
    if (method === "GET" && url.pathname === "/permission") return json([]);
    if (
      method === "POST" &&
      url.pathname === `/session/${providerSessionId}/prompt_async`
    ) {
      scenario.onPrompt({ providerSessionId, emit, dropStream });
      return new Response(null, { status: 204 });
    }
    if (
      method === "POST" &&
      url.pathname === `/session/${providerSessionId}/abort`
    )
      return json(true);
    return json({ error: "not found" }, 404);
  };
  const driver = new OpenCodeServerDriver({
    model: MODEL,
    runtimeDirectory: root,
    command: fixture,
    fetch: fetcher,
    environment: { PATH: process.env.PATH, OPENROUTER_API_KEY: "fixture-key" },
  });
  return { driver, workspace, name: scenario.name };
}

interface Drained {
  events: PrpEvent[];
  terminal: PrpEvent | null;
  /** Set when the event iterator threw (stream failure surfaced to consumer). */
  streamError: unknown;
}

/**
 * Read everything the consumer sees until the stream ends, errors, or a
 * terminal turn event arrives. `stopAtTerminal` stops at the first terminal.
 */
async function drain(
  events: AsyncIterable<PrpEvent>,
  stopAtTerminal: boolean,
): Promise<Drained> {
  const collected: PrpEvent[] = [];
  let terminal: PrpEvent | null = null;
  try {
    for await (const event of events) {
      collected.push(event);
      if (TERMINAL.has(event.eventType)) {
        terminal = event;
        if (stopAtTerminal) break;
      }
    }
  } catch (error) {
    return { events: collected, terminal, streamError: error };
  }
  return { events: collected, terminal, streamError: null };
}

const types = (events: PrpEvent[]) => events.map((event) => event.eventType);

const assistantMessage = (sessionID: string) => ({
  type: "message.updated",
  properties: {
    info: { id: "provider-message-1", sessionID, role: "assistant" },
  },
});

const questionAsked = (sessionID: string) => ({
  type: "question.asked",
  properties: {
    id: "question-pending-1",
    sessionID,
    title: "Target",
    questions: [
      {
        id: "target",
        question: "Which target should continue?",
        required: true,
        options: [{ id: "alpha", label: "Alpha" }],
      },
    ],
  },
});

/** Pending question, then the server goes away; reconnects close at once. */
const lostWithPendingQuestion = (name: string): Scenario => ({
  name,
  onPrompt: ({ providerSessionId, emit, dropStream }) => {
    emit(assistantMessage(providerSessionId));
    emit(questionAsked(providerSessionId));
    dropStream();
  },
});

const permissionAsked = (sessionID: string) => ({
  type: "permission.asked",
  properties: {
    id: "permission-pending-1",
    sessionID,
    permission: "bash",
    title: "Run a shell command",
  },
});

/** Pending permission, then the server goes away; reconnects close at once. */
const lostWithPendingPermission = (name: string): Scenario => ({
  name,
  onPrompt: ({ providerSessionId, emit, dropStream }) => {
    emit(assistantMessage(providerSessionId));
    emit(permissionAsked(providerSessionId));
    dropStream();
  },
});

/** No request pending; the server goes away mid-turn. */
const lostWithNothingPending = (name: string): Scenario => ({
  name,
  onPrompt: ({ providerSessionId, emit, dropStream }) => {
    emit(assistantMessage(providerSessionId));
    dropStream();
  },
});

async function driveDriver(scenario: Scenario): Promise<Drained> {
  const { driver, workspace, name } = await buildDriver(scenario);
  const session = await driver.openSession({
    runId: `run-${name}`,
    normalizedSessionId: name,
    workingDirectory: workspace,
  });
  try {
    await session.startTurn({ message: { role: "user", text: "do the work" } });
    return await drain(session.events(), false);
  } finally {
    await session.close({ reason: "test complete" }).catch(() => undefined);
  }
}

async function driveThroughBackend(scenario: Scenario): Promise<Drained> {
  const { driver, workspace, name } = await buildDriver(scenario);
  const backend = new HarnessDriverBackend(driver);
  const session = await backend.openSession({
    identity: {
      runId: `run-${name}`,
      sessionId: name,
      companyId: "company-1",
      issueId: "issue-1",
      agentId: "agent-1",
    },
    workingDirectory: workspace,
  });
  try {
    await session.startTurn({ message: { role: "user", text: "do the work" } });
    return await drain(session.events(), false);
  } finally {
    await session.close({ reason: "test complete" }).catch(() => undefined);
  }
}

describe("OpenCode SSE loss with a pending governed runtime request", () => {
  describe("driver level", () => {
    it.each([1, 2])(
      "leaves terminal synthesis to the backend: no turn.failed (or any terminal turn event) when a question.asked is still unanswered (trial %i of 2)",
      async (trial) => {
        const result = await driveDriver(
          lostWithPendingQuestion(`pending-driver-${trial}`),
        );
        // The pending request was observed...
        expect(types(result.events)).toContain("runtime_request.created");
        // ...but the driver must not terminate the turn itself.
        expect(types(result.events)).not.toContain("turn.failed");
        expect(result.terminal).toBeNull();
        // The loss still reaches the consumer as a stream failure, which is
        // what lets the backend synthesise the governed wait.
        expect(result.streamError).not.toBeNull();
      },
    );

    it("does not pre-settle the pending request, which would hide it from the backend's governed-wait synthesis", async () => {
      const result = await driveDriver(
        lostWithPendingQuestion("pending-driver-unsettled"),
      );
      expect(types(result.events)).toContain("runtime_request.created");
      expect(types(result.events)).not.toContain("runtime_request.expired");
      expect(types(result.events)).not.toContain("runtime_request.cancelled");
    });

    it("pending permission: the driver settles the permission request and emits turn.failed client-disconnect", async () => {
      const result = await driveDriver(
        lostWithPendingPermission("permission-driver"),
      );
      const seen = types(result.events);
      const created = result.events.find(
        (event) => event.eventType === "runtime_request.created",
      );
      expect(created?.payload).toMatchObject({
        request: { requestId: "permission-pending-1", type: "permission" },
      });
      const settledIndex = seen.findIndex(
        (eventType) =>
          eventType === "runtime_request.expired" ||
          eventType === "runtime_request.cancelled",
      );
      expect(settledIndex).toBeGreaterThanOrEqual(0);
      expect(result.events[settledIndex]?.payload).toMatchObject({
        requestId: "permission-pending-1",
      });
      expect(result.terminal?.eventType).toBe("turn.failed");
      expect(seen.lastIndexOf("turn.failed")).toBeGreaterThan(settledIndex);
      expect(result.terminal?.payload).toMatchObject({
        status: "failed",
        error: { code: "client-disconnect", causeClass: "client-disconnect" },
      });
      const error = (result.terminal?.payload as {
        error?: { message?: unknown };
      }).error;
      expect(typeof error?.message).toBe("string");
      expect((error?.message as string).length).toBeGreaterThan(0);
      expect(
        seen.filter((eventType) => TERMINAL.has(eventType)),
      ).toEqual(["turn.failed"]);
    });

    it("negative control: with nothing pending the driver itself emits turn.failed client-disconnect", async () => {
      const result = await driveDriver(
        lostWithNothingPending("nothing-pending-driver"),
      );
      expect(types(result.events)).not.toContain("runtime_request.created");
      expect(result.terminal?.eventType).toBe("turn.failed");
      expect(result.terminal?.payload).toMatchObject({
        status: "failed",
        error: { code: "client-disconnect", causeClass: "client-disconnect" },
      });
    });
  });

  describe("end to end through HarnessDriverBackend", () => {
    it("ends in a governed wait (runtime_request.expired provider_process_lost, then turn.interrupted) and never in turn.failed", async () => {
      const result = await driveThroughBackend(
        lostWithPendingQuestion("pending-backend"),
      );
      const seen = types(result.events);
      expect(result.streamError, "backend must absorb the stream failure")
        .toBeNull();
      expect(seen).not.toContain("turn.failed");
      expect(seen).not.toContain("turn.completed");
      const expiredIndex = seen.indexOf("runtime_request.expired");
      expect(expiredIndex).toBeGreaterThanOrEqual(0);
      expect(result.events[expiredIndex]?.payload).toMatchObject({
        requestId: "question-pending-1",
        reason: "provider_process_lost",
        replayAllowed: false,
      });
      expect(result.terminal?.eventType).toBe("turn.interrupted");
      expect(result.terminal?.payload).toMatchObject({
        status: "interrupted",
        reason: "provider_process_lost",
      });
      // The interrupt is the final terminal and follows the expiry.
      expect(seen.lastIndexOf("turn.interrupted")).toBeGreaterThan(
        expiredIndex,
      );
      expect(
        seen.filter((eventType) => TERMINAL.has(eventType)),
      ).toEqual(["turn.interrupted"]);
    });

    it("pending permission (not a governed input wait): ends in turn.failed client-disconnect, never turn.interrupted", async () => {
      const result = await driveThroughBackend(
        lostWithPendingPermission("permission-backend"),
      );
      const seen = types(result.events);
      expect(seen).toContain("runtime_request.created");
      expect(
        seen.some(
          (eventType) =>
            eventType === "runtime_request.expired" ||
            eventType === "runtime_request.cancelled",
        ),
      ).toBe(true);
      expect(seen).not.toContain("turn.interrupted");
      expect(seen).not.toContain("turn.completed");
      expect(result.terminal?.eventType).toBe("turn.failed");
      expect(result.terminal?.payload).toMatchObject({
        status: "failed",
        error: { code: "client-disconnect", causeClass: "client-disconnect" },
      });
      expect(
        seen.filter((eventType) => TERMINAL.has(eventType)).at(-1),
      ).toBe("turn.failed");
    });

    it("negative control: with nothing pending the turn fails as client-disconnect and is not turned into an interrupt", async () => {
      const result = await driveThroughBackend(
        lostWithNothingPending("nothing-pending-backend"),
      );
      const seen = types(result.events);
      expect(result.terminal?.eventType).toBe("turn.failed");
      expect(result.terminal?.payload).toMatchObject({
        status: "failed",
        error: { code: "client-disconnect", causeClass: "client-disconnect" },
      });
      expect(seen).not.toContain("turn.interrupted");
      expect(seen).not.toContain("runtime_request.expired");
    });
  });
});
