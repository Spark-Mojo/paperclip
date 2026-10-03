import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseFleetMaxConcurrentRunsValue, registerInstanceCommands } from "../commands/client/instance.js";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerInstanceCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync([
    ...args,
    "--api-base", "http://localhost:3100",
    "--api-key", "board-token",
  ], { from: "user" });
}

function jsonResponse(body: unknown = { ok: true }, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), init);
}

describe("parseFleetMaxConcurrentRunsValue", () => {
  it("accepts an integer 1..50", () => {
    expect(parseFleetMaxConcurrentRunsValue("1")).toBe(1);
    expect(parseFleetMaxConcurrentRunsValue("50")).toBe(50);
    expect(parseFleetMaxConcurrentRunsValue(" 22 ")).toBe(22);
  });

  it("accepts \"none\" (case-insensitive) as an explicit null (no ceiling)", () => {
    expect(parseFleetMaxConcurrentRunsValue("none")).toBeNull();
    expect(parseFleetMaxConcurrentRunsValue("NONE")).toBeNull();
    expect(parseFleetMaxConcurrentRunsValue(" None ")).toBeNull();
  });

  it("rejects 0, out-of-range, non-integer, and non-numeric values", () => {
    for (const bad of ["0", "51", "1.5", "abc", "", "-1"]) {
      expect(() => parseFleetMaxConcurrentRunsValue(bad)).toThrow();
    }
  });
});

describe("instance CLI command", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("gets the fleet-max-concurrent-runs setting", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(jsonResponse({ value: 8, source: "env" })),
    );
    vi.stubGlobal("fetch", fetchMock);

    await run(["instance", "get", "fleet-max-concurrent-runs"]);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3100/api/instance/settings/fleet-max-concurrent-runs",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("sets an explicit fleet-max-concurrent-runs value", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(jsonResponse({ value: 10, source: "db" })),
    );
    vi.stubGlobal("fetch", fetchMock);

    await run(["instance", "set", "fleet-max-concurrent-runs", "10"]);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3100/api/instance/settings/fleet-max-concurrent-runs",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ value: 10 }),
      }),
    );
  });

  it("sets fleet-max-concurrent-runs to no ceiling with the \"none\" sentinel", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(jsonResponse({ value: null, source: "none" })),
    );
    vi.stubGlobal("fetch", fetchMock);

    await run(["instance", "set", "fleet-max-concurrent-runs", "none"]);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3100/api/instance/settings/fleet-max-concurrent-runs",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ value: null }),
      }),
    );
  });

  it("rejects an unsupported setting key before making any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit);

    await expect(run(["instance", "get", "some-other-setting"])).rejects.toThrow("exit:1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid value before making any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit);

    await expect(run(["instance", "set", "fleet-max-concurrent-runs", "0"])).rejects.toThrow("exit:1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a 403 from the API (board-only, agents get 403) and exits non-zero", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(jsonResponse({ error: "Board access required" }, { status: 403 })),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit);

    await expect(run(["instance", "set", "fleet-max-concurrent-runs", "5"])).rejects.toThrow("exit:1");
  });
});
