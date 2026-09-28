import type { Db } from "@paperclipai/db";
import { createGitHubExternalObjectProvider } from "./github-external-object-provider.js";

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
 * Map a successful GitHub external-object snapshot onto the merge-details
 * shape the done-gate consumes. Pulled out of `createPullRequestMergeDetailsResolver`
 * for unit testing.
 *
 * "not_found" means the resolver could not locate the PR — either the PR was
 * deleted at the URL or the configured GitHub token cannot see it
 * (cross-account 404). In both cases the resolver cannot prove an actionable
 * merge state, so we surface the closure via `workProductState: "closed"` (the
 * existing human-signal bucket `gateStateFromDetails` reads first). The
 * done-gate treats `closed` as non-blocking, so the card can close. Without
 * this mapping the done-gate sees `state: "unknown"` and fails-closed on the
 * card, which wedges every closure whose PR is invisible to the token. See
 * SPA-9149.
 */
export function mapGitHubPullRequestSnapshot(snapshot: {
  statusKey?: string | null;
  data?: unknown;
}): PullRequestMergeDetails {
  const data = readRecord(snapshot.data);
  const statusKey = snapshot.statusKey ?? undefined;
  const isClosedByStatus = statusKey === "closed";
  const isClosedByNotFound = statusKey === "not_found";
  const workProductState = statusKey === "open" || statusKey === "draft" || statusKey === "merged" || isClosedByStatus
    ? statusKey
    : isClosedByNotFound
      ? "closed"
      : undefined;
  return {
    state: statusKey === "merged" || data?.merged === true
      ? "merged"
      : statusKey === "open" || statusKey === "draft"
        ? "open"
        : "unknown",
    headRef: typeof data?.headRef === "string" ? data.headRef : null,
    headSha: typeof data?.headSha === "string" ? data.headSha : null,
    ...(workProductState ? { workProductState } : {}),
    draft: data?.draft === true,
    baseRef: typeof data?.baseRef === "string" ? data.baseRef : null,
    additions: typeof data?.additions === "number" ? data.additions : null,
    deletions: typeof data?.deletions === "number" ? data.deletions : null,
    changedFiles: typeof data?.changedFiles === "number" ? data.changedFiles : null,
  };
}

export function createPullRequestMergeDetailsResolver(db: Db): PullRequestMergeDetailsResolver {
  const resolver = createGitHubExternalObjectProvider(db).resolvers
    .find((candidate) => candidate.objectType === "pull_request") ?? null;

  return async (companyId, reference) => {
    if (!resolver) return { state: "unknown", headRef: null, headSha: null };
    const result = await resolver.resolve({
      companyId,
      object: {
        externalId: `${reference.owner}/${reference.repo}#pull/${reference.number}`,
        sanitizedCanonicalUrl: `https://github.com/${reference.owner}/${reference.repo}/pull/${reference.number}`,
      } as never,
    });
    if (!result.ok) return { state: "unknown", headRef: null, headSha: null };
    return mapGitHubPullRequestSnapshot(result.snapshot);
  };
}

export function createPullRequestMergeStateResolver(db: Db): PullRequestMergeStateResolver {
  const resolveDetails = createPullRequestMergeDetailsResolver(db);
  return async (companyId, reference) => (await resolveDetails(companyId, reference)).state;
}
