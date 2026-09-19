import { describe, expect, it } from "vitest";
import {
  summarizeHeartbeatRunResultJson,
  buildHeartbeatRunIssueComment,
  mergeHeartbeatRunResultJson,
} from "../services/heartbeat-run-summary.js";

describe("summarizeHeartbeatRunResultJson", () => {
  it("truncates text fields and preserves cost aliases", () => {
    const summary = summarizeHeartbeatRunResultJson({
      summary: "a".repeat(600),
      result: "ok",
      message: "done",
      error: "failed",
      total_cost_usd: 1.23,
      cost_usd: 0.45,
      costUsd: 0.67,
      stopReason: "timeout",
      effectiveTimeoutSec: 30,
      timeoutConfigured: true,
      timeoutFired: true,
      nested: { ignored: true },
    });

    expect(summary).toEqual({
      summary: "a".repeat(500),
      result: "ok",
      message: "done",
      error: "failed",
      total_cost_usd: 1.23,
      cost_usd: 0.45,
      costUsd: 0.67,
      stopReason: "timeout",
      effectiveTimeoutSec: 30,
      timeoutConfigured: true,
      timeoutFired: true,
    });
  });

  it("returns null for non-object and irrelevant payloads", () => {
    expect(summarizeHeartbeatRunResultJson(null)).toBeNull();
    expect(summarizeHeartbeatRunResultJson(["nope"] as unknown as Record<string, unknown>)).toBeNull();
    expect(summarizeHeartbeatRunResultJson({ nested: { only: "ignored" } })).toBeNull();
  });
});

describe("buildHeartbeatRunIssueComment", () => {
  it("uses the final summary text for issue comments on successful runs", () => {
    const comment = buildHeartbeatRunIssueComment({
      summary: "## Summary\n\n- fixed deploy config\n- posted issue update",
    });

    expect(comment).toContain("## Summary");
    expect(comment).toContain("- fixed deploy config");
    expect(comment).not.toContain("Run summary");
  });

  it("falls back to result or message when summary is missing", () => {
    expect(buildHeartbeatRunIssueComment({ result: "done" })).toBe("done");
    expect(buildHeartbeatRunIssueComment({ message: "completed" })).toBe("completed");
  });

  it("returns null when there is no usable final text", () => {
    expect(buildHeartbeatRunIssueComment({ costUsd: 1.2 })).toBeNull();
  });

  it("withholds litellm empty-message placeholder soup (SPA-8089, pure-filler shape)", () => {
    const filler = "[System: Empty message content sanitised to satisfy protocol]";
    const summary = Array(13).fill(filler).join("\n\n");
    const comment = buildHeartbeatRunIssueComment({ summary });

    expect(comment).not.toContain("sanitised to satisfy protocol");
    expect(comment).toContain("did not post a summary comment");
  });

  it("withholds filler plus leaked tool-call serialization (SPA-8089, mixed shape)", () => {
    const summary =
      "[System: Empty message content sanitised to satisfy protocol]\n\n" +
      "[System: Empty message content sanitised to satisfy protocol]]<]minimax[>[<function_calls.js:invoke_ash\">]<]minimax[>[<parameter name=\"command\">grep -n \"stalledReviewDecisionSchema\" server/src/routes/issues.ts | head -20]<]minimax[>[</command>]<]minimax[>[</workdir>]<]minimax[>[</invoke>\n]<]minimax[>[</tool_call>";
    const comment = buildHeartbeatRunIssueComment({ summary });

    expect(comment).not.toContain("invoke_ash");
    expect(comment).toContain("did not post a summary comment");
  });

  it("withholds serialized tool calls with no natural-language sentence", () => {
    const summary =
      "]<]minimax[>[<function_calls.js:invoke_ash\">]<]minimax[>[<parameter name=\"command\">ls server/src";
    const comment = buildHeartbeatRunIssueComment({ summary });

    expect(comment).not.toContain("invoke_ash");
    expect(comment).toContain("did not post a summary comment");
  });

  it("still posts a genuine summary that merely mentions a tool name in prose", () => {
    const summary = "Fixed deploy config; verified with grep that no stale route remains. 13/13 pass.";
    expect(buildHeartbeatRunIssueComment({ summary })).toBe(summary);
  });
});

describe("mergeHeartbeatRunResultJson", () => {
  it("adds adapter summaries into stored result json for comment posting", () => {
    const merged = mergeHeartbeatRunResultJson(
      { stdout: "raw stdout", stderr: "" },
      "## Summary\n\n1. first thing\n2. second thing",
    );

    expect(merged).toEqual({
      stdout: "raw stdout",
      stderr: "",
      summary: "## Summary\n\n1. first thing\n2. second thing",
    });
    expect(buildHeartbeatRunIssueComment(merged)).toBe("## Summary\n\n1. first thing\n2. second thing");
  });

  it("creates a result payload when only a summary exists", () => {
    expect(mergeHeartbeatRunResultJson(null, "done")).toEqual({ summary: "done" });
  });

  it("does not overwrite an explicit summary already returned by the adapter", () => {
    expect(
      mergeHeartbeatRunResultJson(
        { summary: "adapter result", stdout: "raw stdout" },
        "fallback summary",
      ),
    ).toEqual({
      summary: "adapter result",
      stdout: "raw stdout",
    });
  });
});
