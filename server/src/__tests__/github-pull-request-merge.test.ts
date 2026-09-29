import { describe, expect, it } from "vitest";
import {
  createPullRequestMergeDetailsResolver,
  extractGitHubPullRequestReferences,
  mapGitHubPullRequestSnapshot,
  probePullsReadable,
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

const REFERENCE = { host: "github.com", owner: "Spark-Mojo", repo: "sparkmojo-internal", number: 779, proseShorthand: true } as const;

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

/**
 * SPA-9325 — the live engine token is a fine-grained PAT with pulls:read but
 * WITHOUT issues:read. Every `/issues/N` probe then returns 403 ("Resource
 * not accessible by personal access token"), SPA-9323's discriminator never
 * fires, and the gate fails closed forever on every shorthand-cited ISSUE
 * (live wedges: SPA-9248, SPA-9301, SPA-9310, SPA-9325 itself).
 *
 * Fallback discriminator: GitHub numbers issues and pull requests in ONE
 * space; every PR is addressable at `/pulls/N` and PRs cannot be deleted. So
 * when `pulls/N` reads 404 while the SAME token can list the repo's PRs
 * (`/repos/o/r/pulls?per_page=1&state=all` → 200), N is positively NOT a PR.
 * If the namespace listing is not readable either, the gate stays fail-closed.
 */
function stubbedFetch(routes: Record<string, () => Response>): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    const path = new URL(url instanceof Request ? url.url : String(url)).pathname;
    calls.push(path);
    const respond = routes[path];
    if (respond) return respond();
    return new Response(JSON.stringify({ message: `no route for ${path}` }), { status: 599 });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const REF = (owner: string, repo: string, number: number) =>
  ({ host: "github.com" as const, owner, repo, number, proseShorthand: true });

describe("probePullsReadable — SPA-9325 namespace probe", () => {
  const providerFor = (respond: () => Response | Promise<Response>) =>
    createGitHubExternalObjectProvider(null as never, {
      tokenProvider: () => "t",
      fetch: (async () => respond()) as unknown as typeof fetch,
    });

  it("gate 1: 200 on the pulls list proves the namespace readable; 403/404/429/5xx/network do not", async () => {
    const { probePullsReadable } = await import("../services/github-pull-request-merge.js");
    const pullResolver = (p: ReturnType<typeof providerFor>) =>
      p.resolvers.find((r) => r.objectType === "pull_request")!;
    expect(await probePullsReadable(pullResolver(providerFor(() => new Response("[]", { status: 200 }))), "c1", REF("o", "r", 1))).toBe(true);
    for (const status of [403, 404, 429, 500]) {
      expect(await probePullsReadable(pullResolver(providerFor(() => new Response("[]", { status }))), "c1", REF("o", "r", 1))).toBe(false);
    }
    expect(await probePullsReadable(pullResolver(providerFor(() => { throw new Error("network"); })), "c1", REF("o", "r", 1))).toBe(false);
  });
});

describe("createPullRequestMergeDetailsResolver — SPA-9325 pulls-only token fallback", () => {
  const build = (routes: Record<string, () => Response>) => {
    const { fetch, calls } = stubbedFetch(routes);
    const provider = createGitHubExternalObjectProvider(null as never, { tokenProvider: () => "t", fetch });
    const resolver = createPullRequestMergeDetailsResolver({} as never, { provider });
    return { resolver, calls };
  };

  it("gate 2: 404 on pulls/N + 403 on issues/N + readable namespace ⇒ notAPullRequest true (reason pulls_namespace)", async () => {
    const { resolver, calls } = build({
      "/repos/Spark-Mojo/sparkmojo-internal/pulls/873": () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }),
      "/repos/Spark-Mojo/sparkmojo-internal/issues/873": () => new Response(JSON.stringify({ message: "Resource not accessible by personal access token" }), { status: 403 }),
      "/repos/Spark-Mojo/sparkmojo-internal/pulls": () => new Response(JSON.stringify([{ number: 868, state: "open" }]), { status: 200 }),
    });
    const details = await resolver("c1", REF("Spark-Mojo", "sparkmojo-internal", 873));
    expect(details.state).toBe("unknown");
    expect(details.notAPullRequest).toBe(true);
    expect(details.notAPullRequestReason).toBe("pulls_namespace");
    expect(calls.some((p) => p === "/repos/Spark-Mojo/sparkmojo-internal/pulls")).toBe(true);
  });

  it("gate 3: 403 on the pulls list too ⇒ stays fail-closed unknown", async () => {
    const { resolver } = build({
      "/repos/o/r/pulls/4242": () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }),
      "/repos/o/r/issues/4242": () => new Response(JSON.stringify({ message: "Resource not accessible by personal access token" }), { status: 403 }),
      "/repos/o/r/pulls": () => new Response(JSON.stringify({ message: "Resource not accessible by personal access token" }), { status: 403 }),
    });
    const details = await resolver("c1", REF("o", "r", 4242));
    expect(details.state).toBe("unknown");
    expect(details.notAPullRequest ?? false).toBe(false);
  });

  it("gate 4: a positive issues read classifies with reason issues_probe and never touches the pulls list", async () => {
    const { resolver, calls } = build({
      "/repos/o/r/pulls/779": () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }),
      "/repos/o/r/issues/779": () => new Response(JSON.stringify({ number: 779, state: "open" }), { status: 200 }),
      "/repos/o/r/pulls": () => { throw new Error("must not be called"); },
    });
    const details = await resolver("c1", REF("o", "r", 779));
    expect(details.notAPullRequest).toBe(true);
    expect(details.notAPullRequestReason).toBe("issues_probe");
    expect(calls.some((p) => p === "/repos/o/r/pulls")).toBe(false);
  });

  it("gate 5: two same-repo references make exactly one pulls-list request (memoized)", async () => {
    let listCalls = 0;
    const { resolver } = build({
      "/repos/o/r/pulls/1": () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }),
      "/repos/o/r/pulls/2": () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }),
      "/repos/o/r/issues/1": () => new Response(JSON.stringify({ message: "Resource not accessible" }), { status: 403 }),
      "/repos/o/r/issues/2": () => new Response(JSON.stringify({ message: "Resource not accessible" }), { status: 403 }),
      "/repos/o/r/pulls": () => { listCalls += 1; return new Response("[]", { status: 200 }); },
    });
    await resolver("c1", REF("o", "r", 1));
    await resolver("c1", REF("o", "r", 2));
    expect(listCalls).toBe(1);
  });

  it("gate 5b: an explicit /pull/N URL reference NEVER takes the namespace fallback — stays fail-closed unknown", async () => {
    let listCalls = 0;
    const { resolver } = build({
      "/repos/o/r/pulls/4242": () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }),
      "/repos/o/r/issues/4242": () => new Response(JSON.stringify({ message: "Resource not accessible" }), { status: 403 }),
      "/repos/o/r/pulls": () => { listCalls += 1; return new Response("[]", { status: 200 }); },
    });
    const details = await resolver("c1", { host: "github.com", owner: "o", repo: "r", number: 4242 });
    expect(details.state).toBe("unknown");
    expect(details.notAPullRequest ?? false).toBe(false);
    expect(listCalls).toBe(0);
  });
});
