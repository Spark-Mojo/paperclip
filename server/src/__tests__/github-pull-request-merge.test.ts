import { describe, expect, it } from "vitest";
import {
  extractGitHubPullRequestReferences,
  mapGitHubPullRequestSnapshot,
} from "../services/github-pull-request-merge.js";
import { createGitHubExternalObjectProvider } from "../services/github-external-object-provider.js";
import type { ExternalObjectResolveResult } from "../services/external-objects.js";

/**
 * SPA-9323 — a `owner/repo#N` citation binds the done-gate as a pull request
 * even when N is an ISSUE. The resolver's synthesized `/pull/N` URL then 404s,
 * which the provider reports as `statusKey: "not_found"`, and the gate maps
 * `unknown` to blocking — so a card citing a closed friction issue is
 * unclosable forever (no merge sha will ever exist, and `doneOverride` is
 * board-only).
 *
 * The discriminator: GitHub's `/issues/N` endpoint returns a `pull_request` key
 * for real PRs and OMITS the key entirely for issues. Verified live against
 * Spark-Mojo/sparkmojo-internal: #779 (issue) has no `pull_request` key at all,
 * #800 (PR) carries `pull_request.url`. So the test asserts on the key's
 * presence, never on a `null` value.
 */

const REFERENCE = { host: "github.com", owner: "Spark-Mojo", repo: "sparkmojo-internal", number: 779 } as const;

function snapshot(
  statusKey: string,
  data: Record<string, unknown> = {},
): ExternalObjectResolveResult {
  return {
    ok: true,
    snapshot: {
      displayKey: "GitHub Pull Request",
      iconKey: "github",
      displayTitle: "Spark-Mojo/sparkmojo-internal#779",
      statusKey,
      statusLabel: statusKey,
      statusCategory: "unknown",
      statusTone: "neutral",
      data,
    },
  };
}

describe("mapGitHubPullRequestSnapshot — SPA-9323 non-PR discrimination", () => {
  it("notAPullRequest is false for a normal open PR", () => {
    const details = mapGitHubPullRequestSnapshot(snapshot("open", { headSha: "abc123" }), false);
    expect(details.state).toBe("open");
    expect(details.notAPullRequest).toBeFalsy();
  });

  it("notAPullRequest is false for a merged PR", () => {
    const details = mapGitHubPullRequestSnapshot(snapshot("merged", { merged: true }), false);
    expect(details.state).toBe("merged");
    expect(details.notAPullRequest).toBeFalsy();
  });

  it("notAPullRequest is false when the provider could not read the object (fail-closed)", () => {
    const details = mapGitHubPullRequestSnapshot(snapshot("not_found", { notFound: true }), false);
    expect(details.state).toBe("unknown");
    expect(details.notAPullRequest).toBeFalsy();
  });

  it("notAPullRequest is TRUE only when the issues probe positively shows no pull_request key", () => {
    const details = mapGitHubPullRequestSnapshot(snapshot("not_found", { notFound: true }), true);
    // State stays `unknown` on purpose: a non-PR is not a "refused PR", and the
    // other three consumers of this resolver read `.state`.
    expect(details.state).toBe("unknown");
    expect(details.notAPullRequest).toBe(true);
  });

  it("a positive discrimination on a non-404 status is ignored (probe is 404-path only)", () => {
    const details = mapGitHubPullRequestSnapshot(snapshot("open", { headSha: "abc" }), true);
    expect(details.state).toBe("open");
    expect(details.notAPullRequest).toBeFalsy();
  });
});

describe("extractGitHubPullRequestReferences — SPA-9323 shorthand shape", () => {  it("still extracts an issue-number shorthand (the gate binds it; the resolver now classifies it)", () => {
    const references = extractGitHubPullRequestReferences([
      "See Spark-Mojo/sparkmojo-internal#779 for the prior friction report.",
    ]);
    expect(references).toEqual([REFERENCE]);
  });

  it("does not match a bare `#N` with no owner/repo", () => {
    expect(extractGitHubPullRequestReferences(["just #779 here"])).toEqual([]);
  });
});

/**
 * Regression guards for two real bugs caught by the gate suite during
 * SPA-9323 implementation. Both silently unblocked genuinely-unmerged PRs:
 *
 *  1. `issueSnapshot` did not forward GitHub's `pull_request` key at all, so the
 *     probe could never see it.
 *  2. The probe read "no `pull_request` key" as "not a PR" — but a 404
 *     `not_found` snapshot has no such key either, so a nonexistent/private/
 *     cross-account number was relaxed to non-blocking.
 *
 * The second is why the probe must treat `not_found` as "cannot tell", never as
 * "is an issue".
 */
describe("issueSnapshot forwards the PR classification (SPA-9323)", () => {
  const provider = createGitHubExternalObjectProvider(null as never, {
    tokenProvider: () => "test-token",
    fetch: async () =>
      new Response(JSON.stringify({ number: 1, state: "open", pull_request: { url: "https://api.github.com/x" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  const issueResolver = provider.resolvers.find((r) => r.objectType === "issue")!;

  it("marks a real PR isPullRequest=true", async () => {
    const result = await issueResolver.resolve({
      companyId: "c1",
      object: { externalId: "o/r#issues/800", sanitizedCanonicalUrl: "https://github.com/o/r/issues/800" } as never,
    });
    expect(result.ok).toBe(true);
    expect((result as { snapshot: { data?: { isPullRequest?: boolean } } }).snapshot.data?.isPullRequest).toBe(true);
  });
});

describe("probeIsNotPullRequest fails closed on a 404 (SPA-9323)", () => {
  const provider = createGitHubExternalObjectProvider(null as never, {
    tokenProvider: () => "test-token",
    fetch: async () => new Response(JSON.stringify({ message: "Not Found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    }),
  });
  const issueResolver = provider.resolvers.find((r) => r.objectType === "issue")!;

  it("a 404 on /issues/N yields not_found, which the gate must NOT read as 'is an issue'", async () => {
    const result = await issueResolver.resolve({
      companyId: "c1",
      object: { externalId: "o/r#issues/4242", sanitizedCanonicalUrl: "https://github.com/o/r/issues/4242" } as never,
    });
    expect(result.ok).toBe(true);
    // The snapshot is ambiguous: it carries no isPullRequest signal at all.
    const data = (result as { snapshot: { data?: { isPullRequest?: boolean } } }).snapshot.data;
    expect(data?.isPullRequest).toBeUndefined();
  });
});
