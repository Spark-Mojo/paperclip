import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import type { PrpEvent } from "../../protocol/replay-contract.js";
import { OpenCodeServerDriver } from "./opencode-server-driver.js";

/**
 * Terminal cause classification: race and false-positive guards (SPA-19293).
 *
 * The empty-completion rule ("session.idle with no assistant text and no
 * accepted result is a failure") must not misfire when the idle is the
 * consequence of a deliberate interrupt, when the assistant text was streamed
 * before a snapshot/resume, or when the stream closes after the turn already
 * went terminal. Failure payloads must also be redacted and capped.
 *
 * Scripted offline OpenCode via an inline `fetch` override (same pattern as
 * opencode-server-driver-terminal-cause.test.ts).
 */

const fixture = resolve("test/fixtures/fake-opencode-server.mjs");
const MODEL = "openrouter/deepseek/deepseek-v4-flash-0731";
const SECRET = "sk-or-v1-TOPSECRET-0123456789abcdef";
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

const types = (events: PrpEvent[]) => events.map((event) => event.eventType);
const terminals = (events: PrpEvent[]) =>
  events.filter((event) => TURN_TERMINAL_EVENT_TYPES.has(event.eventType));

function errorOf(event: PrpEvent | null | undefined): Record<string, unknown> {
  const error = event?.payload?.error;
  return error && typeof error === "object"
    ? (error as Record<string, unknown>)
    : {};
}

interface DrainResult {
  events: PrpEvent[];
  terminal: PrpEvent | null;
  streamError: unknown;
}

/** Read events up to (and including) the first terminal event. */
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

/** Read every event until the iterator ends or throws (stream loss). */
async function drainAll(events: AsyncIterable<PrpEvent>): Promise<DrainResult> {
  const collected: PrpEvent[] = [];
  let streamError: unknown = null;
  try {
    for await (const event of events) collected.push(event);
  } catch (error) {
    streamError = error;
  }
  return {
    events: collected,
    terminal: terminals(collected)[0] ?? null,
    streamError,
  };
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
const statusIdle = (sessionID: string) => ({
  type: "session.status",
  properties: { sessionID, status: { type: "idle" } },
});

interface ScriptApi {
  providerSessionId: string;
  emit: (event: Record<string, unknown>) => void;
  dropStream: () => void;
}

interface Harness {
  driver: OpenCodeServerDriver;
  api: ScriptApi;
  aborts: string[];
  workspace: string;
}

/**
 * Build a driver over a scripted OpenCode. `/event` connections are tracked so
 * a second (recovered) session gets its own stream; frames emitted while no
 * stream is connected are queued and delivered on the next connect.
 */
async function harness(options: {
  name: string;
  onPrompt?: (api: ScriptApi) => void;
  onAbort?: (api: ScriptApi) => void;
}): Promise<Harness> {
  await chmod(fixture, 0o755);
  const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-race-"));
  const workspace = await mkdtemp(
    join(tmpdir(), "paperclip-opencode-race-workspace-"),
  );
  roots.push(root, workspace);
  const providerSessionId = `provider-session-${options.name}`;
  const encoder = new TextEncoder();
  const queuedFrames: Uint8Array[] = [];
  let streamController: ReadableStreamDefaultController<Uint8Array> | null =
    null;
  let streamClosed = false;
  let frameCounter = 0;
  const aborts: string[] = [];
  const emit = (event: Record<string, unknown>) => {
    const frame = encoder.encode(
      `data: ${JSON.stringify({ id: `native-${options.name}-${++frameCounter}`, ...event })}\n\n`,
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
  const api: ScriptApi = { providerSessionId, emit, dropStream };
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
      let mine: ReadableStreamDefaultController<Uint8Array> | null = null;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          mine = controller;
          streamController = controller;
          for (const frame of queuedFrames.splice(0)) controller.enqueue(frame);
          if (streamClosed) controller.close();
        },
      });
      init?.signal?.addEventListener("abort", () => {
        try {
          mine?.close();
        } catch {
          // already closed
        }
        if (streamController === mine) streamController = null;
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    if (method === "POST" && url.pathname === "/session")
      return json({ id: providerSessionId });
    if (method === "GET" && url.pathname === `/session/${providerSessionId}`)
      return json({ id: providerSessionId });
    if (method === "GET" && url.pathname === "/question") return json([]);
    if (method === "GET" && url.pathname === "/permission") return json([]);
    if (
      method === "POST" &&
      url.pathname === `/session/${providerSessionId}/prompt_async`
    ) {
      options.onPrompt?.(api);
      return new Response(null, { status: 204 });
    }
    if (
      method === "POST" &&
      url.pathname === `/session/${providerSessionId}/abort`
    ) {
      aborts.push(url.pathname);
      options.onAbort?.(api);
      return json(true);
    }
    return json({ error: "not found" }, 404);
  };
  const driver = new OpenCodeServerDriver({
    model: MODEL,
    runtimeDirectory: root,
    command: fixture,
    fetch: fetcher,
    environment: { PATH: process.env.PATH, OPENROUTER_API_KEY: SECRET },
  });
  return { driver, api, aborts, workspace };
}

async function openAndStart(h: Harness, name: string) {
  const session = await h.driver.openSession({
    runId: `run-${name}`,
    normalizedSessionId: name,
    workingDirectory: h.workspace,
  });
  const { turnId } = await session.startTurn({
    message: { role: "user", text: "do the work" },
  });
  return { session, turnId };
}

describe("OpenCodeServerDriver terminal cause races", () => {
  describe("interrupt followed by idle", () => {
    it.each([
      ["session.idle", idle],
      ["session.status idle", statusIdle],
    ] as const)(
      "ends an interrupted turn whose abort surfaces as %s (zero text) as turn.cancelled, never turn.failed",
      async (label, makeIdle) => {
        const name = `interrupt-${label.replace(/\W+/g, "-")}`;
        const h = await harness({
          name,
          onAbort: ({ providerSessionId, emit }) => {
            // The provider acknowledges the abort by going idle instead of
            // reporting session.error MessageAbortedError.
            emit(makeIdle(providerSessionId));
          },
        });
        const { session, turnId } = await openAndStart(h, name);
        try {
          await session.interrupt({ turnId, reason: "operator interrupt" });
          expect(h.aborts).toHaveLength(1);
          const result = await drainTurn(session.events());
          expect(result.streamError).toBeNull();
          expect(types(result.events)).not.toContain("turn.failed");
          expect(types(result.events)).not.toContain("turn.completed");
          expect(terminals(result.events)).toHaveLength(1);
          expect(result.terminal?.eventType).toBe("turn.cancelled");
          expect(errorOf(result.terminal).code).not.toBe("empty-completion");
        } finally {
          await session.close({ reason: "test complete" }).catch(() => undefined);
        }
      },
    );

    it("does not leak the interrupt flag: an idle on a LATER un-interrupted empty turn is still empty-completion", async () => {
      const name = "interrupt-then-next-turn";
      let prompts = 0;
      const h = await harness({
        name,
        onPrompt: ({ providerSessionId, emit }) => {
          prompts += 1;
          if (prompts === 2) emit(idle(providerSessionId));
        },
        onAbort: ({ providerSessionId, emit }) => emit(idle(providerSessionId)),
      });
      const { session, turnId } = await openAndStart(h, name);
      try {
        await session.interrupt({ turnId });
        const first = await drainTurn(session.events());
        expect(first.terminal?.eventType).toBe("turn.cancelled");

        await session.startTurn({ message: { role: "user", text: "again" } });
        const second = await drainTurn(session.events());
        expect(second.terminal?.eventType).toBe("turn.failed");
        expect(errorOf(second.terminal).code).toBe("empty-completion");
      } finally {
        await session.close({ reason: "test complete" }).catch(() => undefined);
      }
    });
  });

  describe("snapshot-recovered turn", () => {
    it("completes (not empty-completion) when the text was streamed before the snapshot and idle arrives after resume with no new text", async () => {
      const name = "recovered-text";
      const finalText = "Streamed before the snapshot.";
      const h = await harness({
        name,
        onPrompt: ({ providerSessionId, emit }) => {
          emit(assistantMessage(providerSessionId));
          emit(textPart(providerSessionId, finalText));
        },
      });
      const { session: seed, turnId } = await openAndStart(h, name);
      // Wait until the driver has actually observed the streamed text.
      const seen: PrpEvent[] = [];
      for await (const event of seed.events()) {
        seen.push(event);
        if (JSON.stringify(event.payload).includes(finalText)) break;
      }
      expect(JSON.stringify(seen)).toContain(finalText);
      const snapshot = await seed.snapshot();
      expect(snapshot.activeTurnId).toBe(turnId);
      await seed.close({ reason: "simulate runner restart" });

      const recovery = await h.driver.recoverSession?.(snapshot);
      expect(recovery).toMatchObject({ recovered: true });
      const recovered = recovery!.session!;
      try {
        h.api.emit(idle(h.api.providerSessionId));
        const result = await drainTurn(recovered.events());
        expect(result.streamError).toBeNull();
        expect(types(result.events)).not.toContain("turn.failed");
        expect(result.terminal?.eventType).toBe("turn.completed");
      } finally {
        await recovered.close({ reason: "test complete" }).catch(() => undefined);
      }
    });
  });

  describe("no double terminal", () => {
    it("emits exactly one terminal event and no client-disconnect when the stream closes after session.idle", async () => {
      const name = "idle-then-loss";
      const h = await harness({
        name,
        onPrompt: ({ providerSessionId, emit, dropStream }) => {
          emit(assistantMessage(providerSessionId));
          emit(textPart(providerSessionId, "All done."));
          emit(idle(providerSessionId));
          dropStream();
        },
      });
      const { session } = await openAndStart(h, name);
      try {
        // Reconnects are closed at once, so the driver exhausts its retries
        // (50+100+150 ms backoff) and ends the event stream.
        const result = await drainAll(session.events());
        expect(terminals(result.events)).toHaveLength(1);
        expect(result.terminal?.eventType).toBe("turn.completed");
        expect(types(result.events)).not.toContain("turn.failed");
        expect(JSON.stringify(result.events)).not.toContain("client-disconnect");
      } finally {
        await session.close({ reason: "test complete" }).catch(() => undefined);
      }
    });

    it("keeps a single empty-completion turn.failed (no extra client-disconnect) when the stream closes after an empty idle", async () => {
      const name = "empty-idle-then-loss";
      const h = await harness({
        name,
        onPrompt: ({ providerSessionId, emit, dropStream }) => {
          emit(assistantMessage(providerSessionId));
          emit(idle(providerSessionId));
          dropStream();
        },
      });
      const { session } = await openAndStart(h, name);
      try {
        const result = await drainAll(session.events());
        const failed = result.events.filter(
          (event) => event.eventType === "turn.failed",
        );
        expect(terminals(result.events)).toHaveLength(1);
        expect(failed).toHaveLength(1);
        expect(errorOf(failed[0]).code).toBe("empty-completion");
      } finally {
        await session.close({ reason: "test complete" }).catch(() => undefined);
      }
    });
  });

  describe("session.status idle parity", () => {
    it("fails session.status idle with zero assistant text as empty-completion", async () => {
      const name = "status-idle-empty";
      const h = await harness({
        name,
        onPrompt: ({ providerSessionId, emit }) => {
          emit(assistantMessage(providerSessionId));
          emit(statusIdle(providerSessionId));
        },
      });
      const { session } = await openAndStart(h, name);
      try {
        const result = await drainTurn(session.events());
        expect(result.streamError).toBeNull();
        expect(types(result.events)).not.toContain("turn.completed");
        expect(result.terminal?.eventType).toBe("turn.failed");
        const error = errorOf(result.terminal);
        expect(error.code).toBe("empty-completion");
        expect(error.causeClass).toBe("empty-completion");
        expect(error.recoverable).toBe(false);
        expect((error.message as string).trim().length).toBeGreaterThan(0);
      } finally {
        await session.close({ reason: "test complete" }).catch(() => undefined);
      }
    });

    it("completes session.status idle that follows a real assistant text part", async () => {
      const name = "status-idle-text";
      const h = await harness({
        name,
        onPrompt: ({ providerSessionId, emit }) => {
          emit(assistantMessage(providerSessionId));
          emit(textPart(providerSessionId, "Real answer."));
          emit(statusIdle(providerSessionId));
        },
      });
      const { session } = await openAndStart(h, name);
      try {
        const result = await drainTurn(session.events());
        expect(result.terminal?.eventType).toBe("turn.completed");
        expect(types(result.events)).not.toContain("turn.failed");
      } finally {
        await session.close({ reason: "test complete" }).catch(() => undefined);
      }
    });
  });

  describe("failure redaction and cap", () => {
    async function failWith(
      name: string,
      error: Record<string, unknown>,
    ): Promise<PrpEvent> {
      const h = await harness({
        name,
        onPrompt: ({ providerSessionId, emit }) => {
          emit({
            type: "session.error",
            properties: { sessionID: providerSessionId, error },
          });
        },
      });
      const { session } = await openAndStart(h, name);
      try {
        const result = await drainTurn(session.events());
        expect(result.streamError).toBeNull();
        expect(result.terminal?.eventType).toBe("turn.failed");
        return result.terminal!;
      } finally {
        await session.close({ reason: "test complete" }).catch(() => undefined);
      }
    }

    it("redacts a configured sensitive value from a 502 APIError message and keeps it within 2000 chars", async () => {
      const terminal = await failWith("redact-502", {
        name: "APIError",
        data: {
          message: `Bad Gateway while calling upstream with key ${SECRET} rejected`,
          statusCode: 502,
        },
      });
      const error = errorOf(terminal);
      expect(error.code).toBe("upstream-error");
      expect(typeof error.message).toBe("string");
      expect(error.message as string).not.toContain(SECRET);
      expect((error.message as string).length).toBeLessThanOrEqual(2000);
      expect(error.message as string).toContain("Bad Gateway");
      expect(JSON.stringify(terminal.payload)).not.toContain(SECRET);
    });

    it("caps a 5000-char 502 message to at most 2000 chars and still never leaks the secret", async () => {
      const long = `${"x".repeat(990)}${SECRET}${"y".repeat(4000)}`;
      expect(long.length).toBeGreaterThan(5000);
      const terminal = await failWith("cap-502", {
        name: "APIError",
        data: { message: long, statusCode: 502 },
      });
      const error = errorOf(terminal);
      expect(error.code).toBe("upstream-error");
      expect((error.message as string).length).toBeLessThanOrEqual(2000);
      expect(error.message as string).not.toContain(SECRET);
      // No partial secret fragment survives the truncation either.
      expect(error.message as string).not.toContain(SECRET.slice(0, 12));
    });

    it.each([
      ["502 upstream", 502],
      ["400 unclassified", 400],
    ] as const)(
      "does not carry the secret in data.responseBody / data.responseHeaders anywhere in the %s turn.failed payload",
      async (label, statusCode) => {
        const terminal = await failWith(`body-${statusCode}`, {
          name: "APIError",
          data: {
            message: `${label} failure`,
            statusCode,
            responseBody: JSON.stringify({ echoed: `Bearer ${SECRET}` }),
            responseHeaders: {
              "x-echo-credential": SECRET,
              "content-type": "application/json",
            },
          },
        });
        expect(JSON.stringify(terminal.payload)).not.toContain(SECRET);
        expect(JSON.stringify(terminal)).not.toContain(SECRET);
        const error = errorOf(terminal);
        expect(typeof error.message).toBe("string");
        expect((error.message as string).trim().length).toBeGreaterThan(0);
        expect((error.message as string).length).toBeLessThanOrEqual(2000);
      },
    );
  });
});
