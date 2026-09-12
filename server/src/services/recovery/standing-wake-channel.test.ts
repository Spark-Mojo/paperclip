import { describe, expect, it } from "vitest";
import {
  isStandingWakeChannelDescription,
  isStandingWakeChannelIssue,
} from "./standing-wake-channel.js";

describe("standing wake channel description marker", () => {
  it("matches a marker line carrying a channel id", () => {
    expect(isStandingWakeChannelDescription(
      "node05 memory tripwire.\n\nDO NOT CLOSE: wake channel.\nstanding-wake-channel: node05-memory-pressure-tripwire\n",
    )).toBe(true);
  });

  it("matches an indented marker line", () => {
    expect(isStandingWakeChannelDescription("  standing-wake-channel: probe-liveness")).toBe(true);
  });

  it("does not match a marker line without a channel id", () => {
    expect(isStandingWakeChannelDescription("standing-wake-channel:\nnext line")).toBe(false);
  });

  it("does not match prose mentioning the token mid-line", () => {
    expect(isStandingWakeChannelDescription(
      "Document probe cards with the standing-wake-channel marker convention.",
    )).toBe(false);
  });

  it("does not match similar-looking keys", () => {
    expect(isStandingWakeChannelDescription("not-a-standing-wake-channel: x")).toBe(false);
    expect(isStandingWakeChannelDescription("standing-wake-channel-v2: x")).toBe(false);
  });

  it("does not match bullet-prefixed lines", () => {
    expect(isStandingWakeChannelDescription("- standing-wake-channel: probe")).toBe(false);
  });

  it("handles null, undefined, and empty descriptions", () => {
    expect(isStandingWakeChannelDescription(null)).toBe(false);
    expect(isStandingWakeChannelDescription(undefined)).toBe(false);
    expect(isStandingWakeChannelDescription("")).toBe(false);
  });

  it("reads the marker from the issue description", () => {
    expect(isStandingWakeChannelIssue({ description: "standing-wake-channel: probe" })).toBe(true);
    expect(isStandingWakeChannelIssue({ description: "ordinary work card" })).toBe(false);
    expect(isStandingWakeChannelIssue({ description: null })).toBe(false);
    expect(isStandingWakeChannelIssue({})).toBe(false);
    expect(isStandingWakeChannelIssue(null)).toBe(false);
    expect(isStandingWakeChannelIssue(undefined)).toBe(false);
  });
});
