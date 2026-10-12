import { describe, expect, it } from "vitest";
import { pickTerminalAt } from "./values.js";

describe("pickTerminalAt", () => {
  const completed = new Date("2026-10-03T15:28:30.000Z");
  const cancelled = new Date("2026-10-05T09:46:32.000Z");

  it("uses completedAt for a done issue", () => {
    expect(pickTerminalAt({ status: "done", completedAt: completed, cancelledAt: cancelled })).toEqual(completed);
  });

  it("uses cancelledAt for a cancelled issue, never the earlier completedAt", () => {
    expect(pickTerminalAt({ status: "cancelled", completedAt: completed, cancelledAt: cancelled })).toEqual(cancelled);
  });

  it.each(["todo", "in_progress", "in_review", "blocked"])("returns null for non-terminal status %s", (status) => {
    expect(pickTerminalAt({ status, completedAt: completed, cancelledAt: cancelled })).toBeNull();
  });

  it("returns null when the current status is terminal but its own timestamp is absent", () => {
    expect(pickTerminalAt({ status: "done", completedAt: null, cancelledAt: cancelled })).toBeNull();
    expect(pickTerminalAt({ status: "cancelled", completedAt: completed, cancelledAt: null })).toBeNull();
  });
});