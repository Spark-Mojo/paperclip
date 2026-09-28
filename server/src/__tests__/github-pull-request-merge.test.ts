import { describe, expect, it } from "vitest";
import { mapGitHubPullRequestSnapshot } from "../services/github-pull-request-merge.js";

describe("mapGitHubPullRequestSnapshot", () => {
  it("maps statusKey merged to state merged with workProductState merged", () => {
    const result = mapGitHubPullRequestSnapshot({
      statusKey: "merged",
      data: { merged: true, headRef: "feature/x", headSha: "abc1234" },
    });
    expect(result.state).toBe("merged");
    expect(result.workProductState).toBe("merged");
    expect(result.headRef).toBe("feature/x");
    expect(result.headSha).toBe("abc1234");
  });

  it("maps statusKey merged even when data.merged is false", () => {
    const result = mapGitHubPullRequestSnapshot({
      statusKey: "merged",
      data: { merged: false },
    });
    expect(result.state).toBe("merged");
  });

  it("treats data.merged=true as merged even without statusKey", () => {
    const result = mapGitHubPullRequestSnapshot({
      statusKey: undefined,
      data: { merged: true },
    });
    expect(result.state).toBe("merged");
  });

  it("maps statusKey open to state open with workProductState open", () => {
    const result = mapGitHubPullRequestSnapshot({
      statusKey: "open",
      data: { merged: false },
    });
    expect(result.state).toBe("open");
    expect(result.workProductState).toBe("open");
  });

  it("maps statusKey draft to state open with workProductState draft", () => {
    const result = mapGitHubPullRequestSnapshot({
      statusKey: "draft",
      data: { draft: true },
    });
    expect(result.state).toBe("open");
    expect(result.workProductState).toBe("draft");
    expect(result.draft).toBe(true);
  });

  it("maps statusKey closed to workProductState closed (state stays unknown)", () => {
    // The done-gate's `gateStateFromDetails` reads workProductState FIRST
    // (line 104 of issue-done-gate.ts). A closed PR surfaces as
    // workProductState: "closed", and the done-gate returns "closed" —
    // a human-signal refusal, never blocking the card close.
    const result = mapGitHubPullRequestSnapshot({
      statusKey: "closed",
      data: { merged: false },
    });
    expect(result.workProductState).toBe("closed");
  });

  it("maps statusKey not_found to workProductState closed (SPA-9149 fix)", () => {
    // The PR was deleted at the URL OR the configured GitHub token cannot see
    // it (cross-account 404). Either way the resolver cannot prove an
    // actionable merge state. We surface this via workProductState: "closed",
    // which is the human-signal bucket `gateStateFromDetails` reads FIRST.
    // The done-gate treats `closed` as non-blocking, so the card can close.
    // Without this mapping the done-gate sees `state: "unknown"` and
    // fails-closed on the card.
    const result = mapGitHubPullRequestSnapshot({
      statusKey: "not_found",
      data: { notFound: true, provider: "github" },
    });
    expect(result.workProductState).toBe("closed");
  });

  it("maps an unrecognized statusKey to state unknown", () => {
    const result = mapGitHubPullRequestSnapshot({
      statusKey: "garbage",
      data: {},
    });
    expect(result.state).toBe("unknown");
    expect(result.workProductState).toBeUndefined();
  });

  it("maps a missing statusKey and missing data to state unknown", () => {
    const result = mapGitHubPullRequestSnapshot({});
    expect(result.state).toBe("unknown");
    expect(result.workProductState).toBeUndefined();
    expect(result.headRef).toBeNull();
    expect(result.headSha).toBeNull();
    expect(result.draft).toBe(false);
  });
});
