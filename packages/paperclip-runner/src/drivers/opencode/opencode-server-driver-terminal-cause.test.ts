import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import type { PrpEvent } from "../../protocol/replay-contract.js";
import { OpenCodeServerDriver } from "./opencode-server-driver.js";

/**
 * Terminal cause classification (SPA-19293). A turn that dies mid-transport,
 * is rejected upstream, or completes with nothing must surface as a failed
 * terminal event carrying a non-empty reason and a cause class, through the
 * existing event envelope (`turn.failed` payload.error.{code,message,recoverable}).
 *
 * The driver tests drive the driver through an inline `fetch` override with a
 * scripted SSE stream, so every scenario is deterministic and offline.
 * `./terminal-cause.js` is imported dynamically by the unit tests only, so the
 * driver scenarios fail on their assertions (missing behaviour), not on a
 * module-resolution crash of the whole file.
 */

const fixture = resolve("test/fixtures/fake-opencode-server.mjs");
const MODEL = "openrouter/deepseek/deepseek-v4-flash-0731";
const roots: string[] = [];

const TURN_TERMINAL_EVENT_TYPES = new Set([
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

interface DrainResult {
  events: PrpEvent[];
  /** The terminal event, or null when the stream ended/errored before one. */
  terminal: PrpEvent | null;
  /** Set when the event iterator threw before any terminal event arrived. */
  streamError: unknown;
}

/** Read one turn's events up to (and including) its terminal event. */
async function drainTurn(events: AsyncIterable<PrpEvent>): Promise<DrainResult> {
  const collected: PrpEvent[] = [];
  try {
    for await (const event of events) {
      collected.push(event);
      if (TURN_TERMINAL_EVENT_TYPES.has(event.eventType))
        return { events: collected, terminal: event, streamError: null };
    }
  } catch (error) {
    return { events: collected, terminal: null, streamError: error };
  }
  return { events: collected, terminal: null, streamError: null };
}

function errorOf(event: PrpEvent | null): Record<string, unknown> {
  const error = event?.payload?.error;
  return error && typeof error === "object"
    ? (error as Record<string, unknown>)
    : {};
}

const types = (events: PrpEvent[]) => events.map((event) => event.eventType);

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

/** Start a turn against a scripted OpenCode and read its terminal outcome. */
async function runScenario(scenario: Scenario): Promise<DrainResult> {
  await chmod(fixture, 0o755);
  const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-cause-"));
  const workspace = await mkdtemp(
    join(tmpdir(), "paperclip-opencode-cause-workspace-"),
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
  const session = await driver.openSession({
    runId: `run-${scenario.name}`,
    normalizedSessionId: scenario.name,
    workingDirectory: workspace,
  });
  try {
    await session.startTurn({ message: { role: "user", text: "do the work" } });
    return await drainTurn(session.events());
  } finally {
    await session.close({ reason: "test complete" }).catch(() => undefined);
  }
}

const assistantMessage = (sessionID: string, id = "provider-message-1") => ({
  type: "message.updated",
  properties: { info: { id, sessionID, role: "assistant" } },
});
const textPart = (
  sessionID: string,
  text: string,
  id = "provider-part-1",
  messageID = "provider-message-1",
) => ({
  type: "message.part.updated",
  properties: {
    sessionID,
    part: { id, messageID, type: "text", text, time: { start: 1, end: 2 } },
  },
});
const idle = (sessionID: string) => ({
  type: "session.idle",
  properties: { sessionID },
});

/** Assert the failure envelope the dispatcher reads off `turn.failed`. */
function expectCauseFailure(result: DrainResult, code: string) {
  expect(result.streamError, "stream must not error before a terminal event")
    .toBeNull();
  expect(types(result.events)).not.toContain("turn.completed");
  expect(result.terminal?.eventType).toBe("turn.failed");
  const error = errorOf(result.terminal);
  expect(error.code).toBe(code);
  expect(error.causeClass).toBe(code);
  expect(error.recoverable).toBe(false);
  expect(typeof error.message).toBe("string");
  expect((error.message as string).trim().length).toBeGreaterThan(0);
  return error;
}

describe("OpenCodeServerDriver terminal cause classification", () => {
  describe("empty completion", () => {
    it("fails a session.idle with no assistant text and no semantic result as empty-completion", async () => {
      const result = await runScenario({
        name: "empty-bare",
        onPrompt: ({ providerSessionId, emit }) => {
          // A user echo must never count as assistant text.
          emit({
            type: "message.updated",
            properties: {
              sessionID: providerSessionId,
              info: {
                id: "message-user",
                sessionID: providerSessionId,
                role: "user",
              },
            },
          });
          emit({
            type: "message.part.updated",
            properties: {
              sessionID: providerSessionId,
              part: {
                id: "part-user",
                messageID: "message-user",
                type: "text",
                text: "do the work",
              },
            },
          });
          emit(assistantMessage(providerSessionId));
          emit(idle(providerSessionId));
        },
      });
      expectCauseFailure(result, "empty-completion");
      expect(
        result.events.some(
          (event) =>
            event.eventType === "item.completed" &&
            event.payload.kind === "agentMessage" &&
            event.payload.channel === "final",
        ),
      ).toBe(false);
    });

    it("fails an assistant turn that only ran a work tool and produced no text as empty-completion", async () => {
      const result = await runScenario({
        name: "empty-tool-only",
        onPrompt: ({ providerSessionId, emit }) => {
          emit(assistantMessage(providerSessionId));
          emit({
            type: "message.part.updated",
            properties: {
              sessionID: providerSessionId,
              part: {
                id: "part-work-tool",
                messageID: "provider-message-1",
                type: "tool",
                tool: "bash",
                state: {
                  status: "completed",
                  input: { command: "pwd" },
                  output: "/workspace",
                },
              },
            },
          });
          emit(idle(providerSessionId));
        },
      });
      expectCauseFailure(result, "empty-completion");
    });

    it("treats a whitespace-only assistant text part as empty", async () => {
      const result = await runScenario({
        name: "empty-whitespace",
        onPrompt: ({ providerSessionId, emit }) => {
          emit(assistantMessage(providerSessionId));
          emit(textPart(providerSessionId, "  \n\t "));
          emit(idle(providerSessionId));
        },
      });
      expectCauseFailure(result, "empty-completion");
    });
  });

  describe("upstream error", () => {
    it.each([1, 2, 3])(
      "fails a 502 APIError session.error as upstream-error (trial %i of 3)",
      async (trial) => {
        const result = await runScenario({
          name: `upstream-502-${trial}`,
          onPrompt: ({ providerSessionId, emit }) => {
            emit({
              type: "session.error",
              properties: {
                sessionID: providerSessionId,
                error: {
                  name: "APIError",
                  data: { message: "Bad Gateway", statusCode: 502 },
                },
              },
            });
          },
        });
        const error = expectCauseFailure(result, "upstream-error");
        expect(error.message).toContain("Bad Gateway");
      },
    );

    it("fails a 429 APIError session.error as upstream-error", async () => {
      const result = await runScenario({
        name: "upstream-429",
        onPrompt: ({ providerSessionId, emit }) => {
          emit({
            type: "session.error",
            properties: {
              sessionID: providerSessionId,
              error: {
                name: "APIError",
                data: {
                  message: "Too Many Requests",
                  statusCode: 429,
                  isRetryable: true,
                },
              },
            },
          });
        },
      });
      const error = expectCauseFailure(result, "upstream-error");
      expect(error.message).toContain("Too Many Requests");
    });
  });

  describe("client disconnect", () => {
    it.each([1, 2, 3])(
      "emits a terminal turn.failed client-disconnect when the stream closes before the session is terminal (trial %i of 3)",
      async (trial) => {
        const result = await runScenario({
          name: `disconnect-${trial}`,
          onPrompt: ({ providerSessionId, emit, dropStream }) => {
            // Some progress, then the server goes away mid-turn: no idle,
            // no error, and every reconnect is closed immediately.
            emit(assistantMessage(providerSessionId));
            dropStream();
          },
        });
        expectCauseFailure(result, "client-disconnect");
      },
    );
  });

  describe("existing control and success paths", () => {
    it("still maps the normal MessageAbortedError Aborted to turn.cancelled with no turn.failed", async () => {
      const result = await runScenario({
        name: "aborted",
        onPrompt: ({ providerSessionId, emit }) => {
          emit({
            type: "session.error",
            properties: {
              sessionID: providerSessionId,
              error: { name: "MessageAbortedError", data: { message: "Aborted" } },
            },
          });
        },
      });
      expect(result.terminal?.eventType).toBe("turn.cancelled");
      expect(types(result.events)).not.toContain("turn.failed");
      expect(types(result.events)).not.toContain("turn.completed");
    });

    it("completes a normal final assistant text part as turn.completed with a final agentMessage", async () => {
      const finalText = "Here is the complete answer.";
      const result = await runScenario({
        name: "green",
        onPrompt: ({ providerSessionId, emit }) => {
          emit(assistantMessage(providerSessionId));
          emit(textPart(providerSessionId, finalText));
          emit(idle(providerSessionId));
        },
      });
      expect(result.streamError).toBeNull();
      expect(result.terminal?.eventType).toBe("turn.completed");
      expect(result.terminal?.payload).toMatchObject({ status: "completed" });
      expect(types(result.events)).not.toContain("turn.failed");
      expect(result.events).toContainEqual(
        expect.objectContaining({
          eventType: "item.completed",
          payload: expect.objectContaining({
            kind: "agentMessage",
            channel: "final",
            text: finalText,
          }),
        }),
      );
    });

    it("still completes a turn that finished via the accepted semantic completion tool with no trailing text", async () => {
      await chmod(fixture, 0o755);
      const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-cause-sem-"));
      const workspace = await mkdtemp(
        join(tmpdir(), "paperclip-opencode-cause-sem-workspace-"),
      );
      roots.push(root, workspace);
      const driver = new OpenCodeServerDriver({
        model: MODEL,
        runtimeDirectory: root,
        command: fixture,
        environment: {
          PATH: process.env.PATH,
          OPENROUTER_API_KEY: "fixture-key",
        },
      });
      const session = await driver.openSession({
        runId: "run-cause-semantic-only",
        normalizedSessionId: "cause-semantic-only",
        workingDirectory: workspace,
      });
      try {
        // The fixture emits only pre-tool commentary, then the accepted
        // paperclip_finish call; there is no text after the last work tool.
        await session.startTurn({
          message: { role: "user", text: "commentary-only-before-work" },
        });
        const result = await drainTurn(session.events());
        expect(result.streamError).toBeNull();
        expect(result.terminal?.eventType).toBe("turn.completed");
        expect(types(result.events)).not.toContain("turn.failed");
        expect(
          result.events.filter((event) => event.eventType === "run.result.proposed"),
        ).toHaveLength(1);
        expect((await session.snapshot()).semanticResult).not.toBeNull();
      } finally {
        await session.close({ reason: "test complete" });
      }
    });
  });
});

describe("terminal-cause module", () => {
  it("exports exactly the three cause classes", async () => {
    const { TERMINAL_CAUSE_CLASSES } = await import("./terminal-cause.js");
    expect([...TERMINAL_CAUSE_CLASSES]).toEqual([
      "client-disconnect",
      "upstream-error",
      "empty-completion",
    ]);
  });

  describe("classifySessionError", () => {
    const apiError = (statusCode: unknown, message = "failure") => ({
      name: "APIError",
      data: { message, statusCode },
    });

    it.each([500, 502, 503, 504, 599, 429])(
      "classifies APIError status %i as upstream-error",
      async (statusCode) => {
        const { classifySessionError } = await import("./terminal-cause.js");
        expect(classifySessionError(apiError(statusCode))).toBe(
          "upstream-error",
        );
      },
    );

    it.each([400, 401, 404, 422, 499])(
      "does not classify APIError status %i as upstream-error",
      async (statusCode) => {
        const { classifySessionError } = await import("./terminal-cause.js");
        expect(classifySessionError(apiError(statusCode))).toBeNull();
      },
    );

    it("returns null for a plain Error, non-objects and an APIError without a status", async () => {
      const { classifySessionError } = await import("./terminal-cause.js");
      expect(classifySessionError(new Error("boom"))).toBeNull();
      expect(classifySessionError(undefined)).toBeNull();
      expect(classifySessionError(null)).toBeNull();
      expect(classifySessionError("502")).toBeNull();
      expect(
        classifySessionError({ name: "APIError", data: { message: "x" } }),
      ).toBeNull();
    });

    it("returns null for the normal MessageAbortedError Aborted control path", async () => {
      const { classifySessionError } = await import("./terminal-cause.js");
      expect(
        classifySessionError({
          name: "MessageAbortedError",
          data: { message: "Aborted" },
        }),
      ).toBeNull();
    });
  });

  describe("terminalCauseFailure", () => {
    it.each(["client-disconnect", "upstream-error", "empty-completion"] as const)(
      "builds a non-recoverable failure for %s with a non-empty message, with and without detail",
      async (cause) => {
        const { terminalCauseFailure } = await import("./terminal-cause.js");
        const bare = terminalCauseFailure(cause);
        expect(bare).toMatchObject({
          code: cause,
          causeClass: cause,
          recoverable: false,
        });
        expect(typeof bare.message).toBe("string");
        expect(bare.message.trim().length).toBeGreaterThan(0);
        expect(bare.message).toContain(cause);

        const detailed = terminalCauseFailure(cause, "Bad Gateway (502)");
        expect(detailed.code).toBe(cause);
        expect(detailed.message).toContain(cause);
        expect(detailed.message).toContain("Bad Gateway (502)");

        const blank = terminalCauseFailure(cause, "");
        expect(blank.message.trim().length).toBeGreaterThan(0);
        expect(blank.message).toContain(cause);
      },
    );
  });
});
