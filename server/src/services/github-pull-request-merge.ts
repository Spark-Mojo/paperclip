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
  /**
   * SPA-9325: this reference was parsed from the ambiguous `owner/repo#N`
   * prose shorthand (issues and PRs share one number space). Discriminators
   * may resolve it to "not a PR". An explicit `/pull/N` URL or work-product
   * reference does NOT set this — the author asserted a PR exists, so a 404
   * stays fail-closed `unknown` even when the token can read the namespace.
   */
  proseShorthand?: boolean;
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
  /**
   * SPA-9325: which discriminator positively identified the non-PR.
   *
   * `issues_probe` — the `/issues/N` read succeeded (200) and carries no
   * `pull_request` key. The strongest signal.
   * `pulls_namespace` — the issues probe could not discriminate (typically a
   * fine-grained PAT with pulls:read but without issues:read, live on this
   * engine: `/issues/N` 403s), so the fallback proved the token CAN list the
   * repo's pull requests (`/repos/o/r/pulls?per_page=1&state=all` → 200).
   * GitHub numbers issues and PRs in one space and PRs are undeletable, so a
   * readable PR namespace plus a 404 on `/pulls/N` positively proves N names
   * no PR. Set ONLY alongside `notAPullRequest: true`.
   */
  notAPullRequestReason?: "issues_probe" | "pulls_namespace";
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
const PAPERCLIP_PULL_ROUTE_PATTERN = /\[#([1-9][0-9]*)\]\(\/SPA\/pulls\/([1-9][0-9]*)\)/g;
const ADJACENT_REPO_PATTERN = /^\s*\(\s*(Spark-Mojo)\/([A-Za-z0-9_.-]+)(?=[,\s)])/i;

export function unresolvedPaperclipPullRoutes(value: string): number[] {
  return [...value.matchAll(PAPERCLIP_PULL_ROUTE_PATTERN)]
    .filter((match) => match[1] === match[2] && !ADJACENT_REPO_PATTERN.test(value.slice(match.index + match[0].length)))
    .map((match) => Number(match[2]))
    .filter((number) => Number.isSafeInteger(number));
}

function addPullRequestReference(
  references: Map<string, GitHubPullRequestReference>,
  owner: string,
  repo: string,
  rawNumber: string,
  proseShorthand: boolean,
) {
  const number = Number(rawNumber);
  if (!Number.isSafeInteger(number) || number <= 0) return;
  const key = `${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`;
  if (references.has(key)) return; // first source wins: an explicit URL claim outranks a shorthand mention
  const reference: GitHubPullRequestReference = { host: "github.com", owner, repo, number };
  if (proseShorthand) reference.proseShorthand = true;
  references.set(key, reference);
}

export function extractGitHubPullRequestReferences(values: readonly unknown[]) {
  const references = new Map<string, GitHubPullRequestReference>();
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0) continue;
    GITHUB_PULL_REQUEST_URL_PATTERN.lastIndex = 0;
    for (const match of value.matchAll(GITHUB_PULL_REQUEST_URL_PATTERN)) {
      addPullRequestReference(references, match[1]!, match[2]!, match[3]!, false);
    }
    GITHUB_PULL_REQUEST_SHORTHAND_PATTERN.lastIndex = 0;
    for (const match of value.matchAll(GITHUB_PULL_REQUEST_SHORTHAND_PATTERN)) {
      addPullRequestReference(references, match[2]!, match[3]!, match[4]!, true);
    }
    for (const match of value.matchAll(PAPERCLIP_PULL_ROUTE_PATTERN)) {
      const adjacent = ADJACENT_REPO_PATTERN.exec(value.slice(match.index + match[0].length));
      if (match[1] === match[2] && adjacent) addPullRequestReference(references, adjacent[1]!, adjacent[2]!, match[2]!, true);
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
 * (`not_found`) shape AND the probe positively showed no `pull_request`
 * key. Every other combination — including a 404 on both endpoints — leaves
 * the reference in the fail-closed `unknown` bucket.
 */
export function mapGitHubPullRequestSnapshot(
  result: ExternalObjectResolveResult,
  confirmedNotPullRequest: boolean,
  notAPullRequestReason?: "issues_probe" | "pulls_namespace",
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
    ...(notAPullRequest
      ? { notAPullRequest: true, ...(notAPullRequestReason ? { notAPullRequestReason } : {}) }
      : {}),
    draft: data?.draft === true,
    baseRef: typeof data?.baseRef === "string" ? data.baseRef : null,
    additions: typeof data?.additions === "number" ? data.additions : null,
    deletions: typeof data?.deletions === "number" ? data.deletions : null,
    changedFiles: typeof data?.changedFiles === "number" ? data.changedFiles : null,
  };
}

export type PullRequestMergeDetailsResolverOptions = {
  /**
   * SPA-9325 test seam: build the resolver against an already-configured
   * provider (fetch/token stubs) instead of one derived from `db`.
   */
  provider?: ReturnType<typeof createGitHubExternalObjectProvider>;
};

export function createPullRequestMergeDetailsResolver(
  db: Db,
  opts: PullRequestMergeDetailsResolverOptions = {},
): PullRequestMergeDetailsResolver {
  const provider = opts.provider ?? createGitHubExternalObjectProvider(db);
  const resolver = provider.resolvers
    .find((candidate) => candidate.objectType === "pull_request") ?? null;
  const issueResolver = provider.resolvers
    .find((candidate) => candidate.objectType === "issue") ?? null;
  // SPA-9325: per-repo memo of the namespace probe, so a card citing several
  // issues from one repo pays at most one `/pulls?per_page=1` request per
  // gate evaluation (resolver instances are per-gate-evaluation).
  const pullsReadableByRepo = new Map<string, Promise<boolean>>();

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
    if (!result.ok || result.snapshot.statusKey !== "not_found") {
      return mapGitHubPullRequestSnapshot(result, false);
    }
    // Discriminator 1 (SPA-9323): `/issues/N` 200 without a `pull_request` key.
    const probed = issueResolver
      ? await probeIsNotPullRequest(issueResolver, companyId, reference)
      : false;
    if (probed) return mapGitHubPullRequestSnapshot(result, true, "issues_probe");
    // Discriminator 2 (SPA-9325), SHORTHAND-ONLY: the issues probe could not
    // discriminate — on this engine the stored token has pulls:read but not
    // issues:read, so every `/issues/N` read 403s. For the intrinsically
    // ambiguous `owner/repo#N` shorthand, prove the token CAN list this repo's
    // PRs; a readable PR namespace plus the 404 above positively proves N
    // names no PR (GitHub numbers issues and PRs in one space; PRs are
    // undeletable). An explicit `/pull/N` URL or work-product reference never
    // takes this path — the author asserted a PR, a 404 stays fail-closed.
    if (!reference.proseShorthand) return mapGitHubPullRequestSnapshot(result, false);
    const repoKey = `${reference.owner.toLowerCase()}/${reference.repo.toLowerCase()}`;
    let readablePromise = pullsReadableByRepo.get(repoKey);
    if (!readablePromise) {
      readablePromise = probePullsReadable(resolver, companyId, reference);
      pullsReadableByRepo.set(repoKey, readablePromise);
    }
    if (await readablePromise) {
      return mapGitHubPullRequestSnapshot(result, true, "pulls_namespace");
    }
    return mapGitHubPullRequestSnapshot(result, false);
  };
}

/**
 * SPA-9325: can this token list pull requests in the reference's repo?
 *
 * Delegates to the provider resolver's `probeNamespace` (same token, same
 * headers, same failure mapping as every other GitHub read the gate makes).
 * Only an HTTP 200 on `GET /repos/o/r/pulls?per_page=1&state=all` proves the
 * namespace readable; 403 (token lacks pulls:read), 404 (repo invisible),
 * 429/5xx, and network failures all fail closed. Returns `false` when the
 * resolver does not expose the probe (older provider shape).
 */
export async function probePullsReadable(
  pullRequestResolver: ExternalObjectResolver,
  companyId: string,
  reference: GitHubPullRequestReference,
): Promise<boolean> {
  const probe = (pullRequestResolver as ExternalObjectResolver & {
    probeNamespace?: (companyId: string, identity: { host: string; owner: string; repo: string }) => Promise<boolean>;
  }).probeNamespace;
  if (typeof probe !== "function") return false;
  try {
    return await probe(companyId, { host: reference.host, owner: reference.owner, repo: reference.repo });
  } catch {
    return false;
  }
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
