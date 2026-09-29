import type { Db } from "@paperclipai/db";
import { createGitHubExternalObjectProvider } from "./github-external-object-provider.js";
import type {
  ExternalObjectResolver,
  ExternalObjectResolveResult,
} from "./external-objects.js";

export type GitHubPullRequestReference = {
  host: "github.com";
  owner: string;
  repo: string;
  number: number;
};

export type PullRequestMergeState = "merged" | "open" | "unknown";

export type PullRequestMergeDetails = {
  state: PullRequestMergeState;
  headRef: string | null;
  headSha: string | null;
  workProductState?: "open" | "draft" | "merged" | "closed";
  draft?: boolean;
  baseRef?: string | null;
  additions?: number | null;
  deletions?: number | null;
  changedFiles?: number | null;
  /**
   * SPA-9323: this reference was positively identified as NOT a pull request.
   *
   * `owner/repo#N` in card prose binds the done-gate, but N may be an ISSUE.
   * The `/pull/N` URL then 404s and the whole read is ambiguous, so we probe
   * GitHub's `/issues/N` endpoint, which carries a `pull_request` key for real
   * PRs and omits it for issues.
   *
   * `state` deliberately stays `"unknown"` on this path: a non-PR is not a
   * "refused PR", and the other three consumers of this resolver read `.state`.
   * Only the done-gate — which must not wedge on a citation that names no PR —
   * reads this field. It is set ONLY on a positive, successful discrimination,
   * so a 401/403/429/5xx/network failure, or a 404 on BOTH endpoints (private
   * repo, cross-account token, or a typo), leaves it false and keeps blocking.
   */
  notAPullRequest?: boolean;
};

export type PullRequestMergeStateResolver = (
  companyId: string,
  reference: GitHubPullRequestReference,
) => Promise<PullRequestMergeState>;

export type PullRequestMergeDetailsResolver = (
  companyId: string,
  reference: GitHubPullRequestReference,
) => Promise<PullRequestMergeDetails>;

export const PULL_REQUEST_CACHE_MAX_ENTRIES = 1_000;

export function setBoundedPullRequestCacheEntry<T>(
  cache: Map<string, T>,
  key: string,
  value: T,
) {
  cache.delete(key);
  while (cache.size >= PULL_REQUEST_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
  cache.set(key, value);
}

const GITHUB_PULL_REQUEST_URL_PATTERN = /https:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)/gi;
const GITHUB_PULL_REQUEST_SHORTHAND_PATTERN = /(^|[^A-Za-z0-9_.-])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)\b/g;

function addPullRequestReference(
  references: Map<string, GitHubPullRequestReference>,
  owner: string,
  repo: string,
  rawNumber: string,
) {
  const number = Number(rawNumber);
  if (!Number.isSafeInteger(number) || number <= 0) return;
  const reference = { host: "github.com", owner, repo, number } as const;
  const key = `${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`;
  if (!references.has(key)) references.set(key, reference);
}

export function extractGitHubPullRequestReferences(values: readonly unknown[]) {
  const references = new Map<string, GitHubPullRequestReference>();
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0) continue;
    GITHUB_PULL_REQUEST_URL_PATTERN.lastIndex = 0;
    for (const match of value.matchAll(GITHUB_PULL_REQUEST_URL_PATTERN)) {
      addPullRequestReference(references, match[1]!, match[2]!, match[3]!);
    }
    GITHUB_PULL_REQUEST_SHORTHAND_PATTERN.lastIndex = 0;
    for (const match of value.matchAll(GITHUB_PULL_REQUEST_SHORTHAND_PATTERN)) {
      addPullRequestReference(references, match[2]!, match[3]!, match[4]!);
    }
  }
  return [...references.values()];
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * SPA-9323: map one resolver result onto merge details.
 *
 * `confirmedNotPullRequest` is the second argument because it comes from a
 * DIFFERENT endpoint (`/issues/N`) than the snapshot. The gate is deliberately
 * narrow: `notAPullRequest` is set only when the snapshot is the 404
 * (`not_found`) shape AND the issues probe positively showed no `pull_request`
 * key. Every other combination — including a 404 on both endpoints — leaves
 * the reference in the fail-closed `unknown` bucket.
 */
export function mapGitHubPullRequestSnapshot(
  result: ExternalObjectResolveResult,
  confirmedNotPullRequest: boolean,
): PullRequestMergeDetails {
  if (!result.ok) return { state: "unknown", headRef: null, headSha: null };
  const data = readRecord(result.snapshot.data);
  const statusKey = result.snapshot.statusKey;
  const workProductState = statusKey === "open" || statusKey === "draft" || statusKey === "merged" || statusKey === "closed"
    ? statusKey
    : undefined;
  // SPA-9323: the `not_found` shape is the only one the probe can speak to.
  // A positive `open`/`merged` read is a pull request by definition.
  const notAPullRequest = confirmedNotPullRequest && statusKey === "not_found";
  return {
    state: statusKey === "merged" || data?.merged === true
      ? "merged"
      : statusKey === "open" || statusKey === "draft" || statusKey === "closed"
        ? "open"
        : "unknown",
    headRef: typeof data?.headRef === "string" ? data.headRef : null,
    headSha: typeof data?.headSha === "string" ? data.headSha : null,
    ...(workProductState ? { workProductState } : {}),
    ...(notAPullRequest ? { notAPullRequest: true } : {}),
    draft: data?.draft === true,
    baseRef: typeof data?.baseRef === "string" ? data.baseRef : null,
    additions: typeof data?.additions === "number" ? data.additions : null,
    deletions: typeof data?.deletions === "number" ? data.deletions : null,
    changedFiles: typeof data?.changedFiles === "number" ? data.changedFiles : null,
  };
}

export function createPullRequestMergeDetailsResolver(db: Db): PullRequestMergeDetailsResolver {
  const provider = createGitHubExternalObjectProvider(db);
  const resolver = provider.resolvers
    .find((candidate) => candidate.objectType === "pull_request") ?? null;
  const issueResolver = provider.resolvers
    .find((candidate) => candidate.objectType === "issue") ?? null;

  return async (companyId, reference) => {
    if (!resolver) return { state: "unknown", headRef: null, headSha: null };
    const result = await resolver.resolve({
      companyId,
      object: {
        externalId: `${reference.owner}/${reference.repo}#pull/${reference.number}`,
        sanitizedCanonicalUrl: `https://github.com/${reference.owner}/${reference.repo}/pull/${reference.number}`,
      } as never,
    });
    // SPA-9323: only the ambiguous 404 path costs a second call. A PR that
    // resolves normally is one call, exactly as before.
    let confirmedNotPullRequest = false;
    if (result.ok && result.snapshot.statusKey === "not_found" && issueResolver) {
      confirmedNotPullRequest = await probeIsNotPullRequest(issueResolver, companyId, reference);
    }
    return mapGitHubPullRequestSnapshot(result, confirmedNotPullRequest);
  };
}

/**
 * SPA-9323: ask GitHub whether `N` is a pull request at all.
 *
 * `/repos/o/r/issues/N` answers 200 for BOTH issues and pull requests. The
 * provider forwards GitHub's `pull_request` key as `isPullRequest`; the key is
 * ABSENT (not null) for an issue — verified live against
 * Spark-Mojo/sparkmojo-internal, where #779 carries no such key and #800
 * carries one — so this reads the forwarded boolean.
 *
 * Fails closed, which is the whole safety property here. `false` is returned —
 * leaving the reference blocking — for every case that is not a positively
 * identified 200-without-a-pull-request:
 *   - a 404 on `/issues/N` (the `not_found` snapshot). This is the case the
 *     original defect misread: a nonexistent number, a private repo, or a
 *     cross-account token all land here, and none of them prove "not a PR".
 *   - auth (401/403), rate limit, 5xx, network failure, malformed body.
 */
async function probeIsNotPullRequest(
  issueResolver: ExternalObjectResolver,
  companyId: string,
  reference: GitHubPullRequestReference,
): Promise<boolean> {
  try {
    const probed = await issueResolver.resolve({
      companyId,
      object: {
        externalId: `${reference.owner}/${reference.repo}#issues/${reference.number}`,
        sanitizedCanonicalUrl: `https://github.com/${reference.owner}/${reference.repo}/issues/${reference.number}`,
      } as never,
    });
    if (!probed.ok) return false;
    // `not_found` is GitHub saying "I cannot show you this object", not
    // "this object is an issue". It must never relax the gate.
    if (probed.snapshot.statusKey === "not_found") return false;
    const data = readRecord(probed.snapshot.data);
    if (!data || typeof data.isPullRequest !== "boolean") return false;
    return data.isPullRequest === false;
  } catch {
    return false;
  }
}

export function createPullRequestMergeStateResolver(db: Db): PullRequestMergeStateResolver {
  const resolveDetails = createPullRequestMergeDetailsResolver(db);
  return async (companyId, reference) => (await resolveDetails(companyId, reference)).state;
}
