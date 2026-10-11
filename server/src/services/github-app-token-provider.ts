import { createPrivateKey, createSign } from "node:crypto";
import { DEFAULT_GITHUB_TOKEN_SECRET_NAMES } from "./git-credentials.js";

/**
 * SPA-11677: app-backed GitHub API tokens for PR/issue resolution.
 *
 * The external-object provider's reads used the static company-secret PAT
 * (GITHUB_TOKEN), which rots and once revoked turns the done-gate's
 * issue-vs-PR discriminator into a permanent 403 (SPA-11061). This module mints
 * short-lived installation tokens from the existing org GitHub App
 * (`sparkmojo-verify`, installed org-wide with issues + pull_requests access)
 * via the App id + private key held in the approved secret store, caches each
 * token per company, and refreshes it before its 1h expiry. The PAT path stays
 * as the fallback when App config is absent or minting fails.
 *
 * Scope: REST API reads for PR/issue resolution only. Git clone/push and GHCR
 * keep their current credentials (GHCR refuses App tokens).
 *
 * No secret values cross this module's boundary into logs, errors, or return
 * payloads: errors name the failing step only, and the cached token is never
 * logged, thrown, or persisted.
 */

export const DEFAULT_GITHUB_APP_ID_SECRET_NAMES = ["GITHUB_APP_ID", "GH_APP_ID"] as const;
export const DEFAULT_GITHUB_APP_PRIVATE_KEY_SECRET_NAMES = [
  "GITHUB_APP_PRIVATE_KEY",
  "GH_APP_PRIVATE_KEY",
] as const;
export const DEFAULT_GITHUB_APP_INSTALLATION_ID_SECRET_NAMES = [
  "GITHUB_APP_INSTALLATION_ID",
  "GH_APP_INSTALLATION_ID",
] as const;

type SecretResolver = (companyId: string, names: readonly string[]) => Promise<string | null>;
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface GitHubAppCredentialSource {
  appIdSecretNames?: readonly string[];
  privateKeySecretNames?: readonly string[];
  installationIdSecretNames?: readonly string[];
  patSecretNames?: readonly string[];
}

export interface GitHubAppTokenProviderOptions extends GitHubAppCredentialSource {
  companyId: string;
  resolveSecret: SecretResolver;
  fetchImpl?: FetchLike;
  now?: () => number;
}

// GitHub installation tokens live ~1h. Refresh inside this skew so no read
// ever races a token dying mid-flight.
const INSTALLATION_TOKEN_REFRESH_SKEW_MS = 5 * 60_000;
const GITHUB_APP_TOKEN_TIMEOUT_MS = 10_000;

interface CachedInstallationToken {
  token: string;
  expiresAtMs: number;
}

// One process-lifetime cache per company. Tokens are bearer credentials with a
// 1h life; the entry holds nothing else (no app id, no key, no config).
const installationTokenCache = new Map<string, CachedInstallationToken>();

/** Test seam: drop every cached installation token. */
export function __resetGitHubAppTokenCacheForTests() {
  installationTokenCache.clear();
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Mint a GitHub App JWT (RS256, 10-minute life, app id as issuer) per
 * https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
 */
export function mintGitHubAppJwt(appId: string, privateKeyPem: string, nowMs = Date.now()): string {
  const epoch = Math.floor(nowMs / 1000);
  // Start 60s in the past to absorb clock skew; die in 10m (GitHub's max).
  const unsigned = `${base64UrlJson({ alg: "RS256", typ: "JWT" })}.${base64UrlJson({ iat: epoch - 60, exp: epoch + 540, iss: appId })}`;
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    signer.end();
    return `${unsigned}.${signer.sign(createPrivateKey(privateKeyPem)).toString("base64url")}`;
  } catch {
    throw new Error("GitHub App JWT could not be signed");
  }
}

async function resolveFirstSecret(
  companyId: string,
  resolveSecret: SecretResolver,
  names: readonly string[],
): Promise<string | null> {
  for (const name of names) {
    const value = await resolveSecret(companyId, [name]);
    const trimmed = value?.trim() ?? "";
    if (trimmed) return trimmed;
  }
  return null;
}

async function readJsonBody(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await response.json();
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

async function fetchJson(input: {
  fetchImpl: FetchLike;
  url: string;
  init: RequestInit;
}): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GITHUB_APP_TOKEN_TIMEOUT_MS);
  try {
    const response = await input.fetchImpl(input.url, { ...input.init, signal: controller.signal });
    return { status: response.status, body: await readJsonBody(response) };
  } finally {
    clearTimeout(timeout);
  }
}

const NUMERIC_INSTALLATION_ID_RE = /^[1-9][0-9]*$/;

async function discoverInstallationsArray(appJwt: string, fetchImpl: FetchLike): Promise<unknown[] | null> {
  let page = 1;
  const all: unknown[] = [];
  // Guard the paged loop: a persistently full page would otherwise spin.
  for (let pages = 0; pages < 10; pages += 1) {
    const url =
      page === 1
        ? "https://api.github.com/app/installations?per_page=100"
        : `https://api.github.com/app/installations?per_page=100&page=${page}`;
    let response: Response;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), GITHUB_APP_TOKEN_TIMEOUT_MS);
      try {
        response = await fetchImpl(url, {
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${appJwt}`,
            "x-github-api-version": "2022-11-28",
          },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      return null;
    }
    if (!response.ok) return null;
    let rows: unknown;
    try {
      rows = await response.json();
    } catch {
      return null;
    }
    if (!Array.isArray(rows)) return null;
    all.push(...rows);
    if (rows.length < 100) break;
    page += 1;
  }
  return all;
}

/**
 * Mint (and per-company cache) a GitHub App installation token for REST API
 * reads. Returns null — never throws — when App config is absent, ambiguous,
 * or minting fails, so the caller falls through to the PAT path.
 */
export async function resolveGitHubAppInstallationToken(
  input: GitHubAppTokenProviderOptions,
): Promise<string | null> {
  const fetchImpl: FetchLike = input.fetchImpl ?? ((url, init) => fetch(url, init));

  try {
    const now = input.now ?? Date.now;
    const nowMs = now();

    const cached = installationTokenCache.get(input.companyId);
    if (cached && cached.expiresAtMs - INSTALLATION_TOKEN_REFRESH_SKEW_MS > nowMs) {
      return cached.token;
    }

    const appId = await resolveFirstSecret(
      input.companyId,
      input.resolveSecret,
      input.appIdSecretNames ?? DEFAULT_GITHUB_APP_ID_SECRET_NAMES,
    );
    const privateKeyPem = await resolveFirstSecret(
      input.companyId,
      input.resolveSecret,
      input.privateKeySecretNames ?? DEFAULT_GITHUB_APP_PRIVATE_KEY_SECRET_NAMES,
    );
    if (!appId || !privateKeyPem) return null;

    const appJwt = mintGitHubAppJwt(appId, privateKeyPem, nowMs);

    let installationId = await resolveFirstSecret(
      input.companyId,
      input.resolveSecret,
      input.installationIdSecretNames ?? DEFAULT_GITHUB_APP_INSTALLATION_ID_SECRET_NAMES,
    );
    if (installationId && !NUMERIC_INSTALLATION_ID_RE.test(installationId)) installationId = null;
    if (!installationId) {
      const rows = await discoverInstallationsArray(appJwt, fetchImpl);
      if (!rows) return null;
      const active = rows.filter(
        (row): row is { id: number } =>
          isRecord(row) &&
          typeof row.id === "number" &&
          Number.isSafeInteger(row.id) &&
          NUMERIC_INSTALLATION_ID_RE.test(String(row.id)) &&
          !row.suspended_at,
      );
      if (active.length !== 1) return null;
      installationId = String(active[0]!.id);
    }

    const { status, body } = await fetchJson({
      fetchImpl,
      url: `https://api.github.com/app/installations/${encodeURIComponent(installationId!)}/access_tokens`,
      init: {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${appJwt}`,
          "x-github-api-version": "2022-11-28",
        },
      },
    }).catch(() => ({ status: 0, body: null }));
    if (status !== 200 && status !== 201) return null;
    const token = typeof body?.token === "string" && /^[\x21-\x7e]{1,8192}$/.test(body.token) ? body.token : null;
    const expiresAtMs =
      typeof body?.expires_at === "string" && Number.isFinite(Date.parse(body.expires_at))
        ? Date.parse(body.expires_at)
        : NaN;
    if (!token || !Number.isFinite(expiresAtMs)) return null;
    // Clamp absurd futures to the documented ~1h life + skew; a far-future
    // expiry cached verbatim would pin a dead token indefinitely.
    const clampedExpiresAtMs = Math.min(expiresAtMs, nowMs + 60 * 60_000 + INSTALLATION_TOKEN_REFRESH_SKEW_MS);

    installationTokenCache.set(input.companyId, { token, expiresAtMs: clampedExpiresAtMs });
    return token;
  } catch {
    return null;
  }
}

/**
 * App-first GitHub API token with the static PAT as fallback. Returns null
 * only when neither source has a credential (the caller's fail-closed
 * namespace behavior is unchanged).
 */
export async function resolveGitHubApiToken(input: GitHubAppTokenProviderOptions): Promise<string | null> {
  try {
    const appToken = await resolveGitHubAppInstallationToken(input);
    if (appToken) return appToken;
    return await resolveFirstSecret(
      input.companyId,
      input.resolveSecret,
      input.patSecretNames ?? DEFAULT_GITHUB_TOKEN_SECRET_NAMES,
    );
  } catch {
    return null;
  }
}
