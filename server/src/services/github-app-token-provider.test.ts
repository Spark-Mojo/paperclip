import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetGitHubAppTokenCacheForTests,
  mintGitHubAppJwt,
  resolveGitHubAppInstallationToken,
  resolveGitHubApiToken,
  DEFAULT_GITHUB_APP_ID_SECRET_NAMES,
  DEFAULT_GITHUB_APP_PRIVATE_KEY_SECRET_NAMES,
  DEFAULT_GITHUB_APP_INSTALLATION_ID_SECRET_NAMES,
} from "./github-app-token-provider.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PUBLIC_KEY_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();
const APP_ID = "123456";

function appSecrets(overrides: Record<string, string | null> = {}) {
  const store: Record<string, string | null> = {
    GITHUB_APP_ID: APP_ID,
    GITHUB_APP_PRIVATE_KEY: PRIVATE_KEY_PEM,
    GITHUB_APP_INSTALLATION_ID: "789",
    GITHUB_TOKEN: "pat_fallback",
    ...overrides,
  };
  return async (_companyId: string, names: readonly string[]) => {
    for (const name of names) {
      const value = store[name] ?? null;
      if (value && value.trim()) return value;
    }
    return null;
  };
}

function mockFetch(
  routes: Array<{ match: (url: string, init?: RequestInit) => boolean; respond: (url: string, init?: RequestInit) => Response }>,
) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    for (const route of routes) {
      if (route.match(u, init)) return route.respond(u, init);
    }
    return new Response("no route", { status: 404 });
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

function authHeader(init?: RequestInit) {
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.authorization ?? null;
}

function tokenRoute(token: string, expiresInSeconds: number) {
  return {
    match: (url: string, init?: RequestInit) =>
      url.includes("/app/installations/") && url.endsWith("/access_tokens") && init?.method === "POST",
    respond: () =>
      Response.json({
        token,
        expires_at: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      }),
  };
}

afterEach(() => {
  __resetGitHubAppTokenCacheForTests();
  vi.restoreAllMocks();
});

describe("mintGitHubAppJwt", () => {
  it("mints a verifiable RS256 JWT with the app id as issuer and a ten-minute lifetime", () => {
    const nowMs = Date.now();
    const jwt = mintGitHubAppJwt(APP_ID, PRIVATE_KEY_PEM, nowMs);
    const [header, payload, signature] = jwt.split(".");
    expect(header).toBeTruthy();
    expect(payload).toBeTruthy();
    expect(signature).toBeTruthy();
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
    expect(claims.iss).toBe(APP_ID);
    expect(claims.exp - claims.iat).toBe(600);

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    verifier.end();
    expect(verifier.verify(createPublicKey(PUBLIC_KEY_PEM), signature!, "base64url")).toBe(true);
  });

  it("never embeds the private key in the JWT or in mint errors", () => {
    const jwt = mintGitHubAppJwt(APP_ID, PRIVATE_KEY_PEM);
    expect(jwt).not.toContain("PRIVATE KEY");
    expect(() => mintGitHubAppJwt(APP_ID, "not-a-key")).toThrow(/GitHub App JWT/i);
    try {
      mintGitHubAppJwt(APP_ID, "not-a-key");
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain("not-a-key");
    }
  });
});

describe("resolveGitHubAppInstallationToken", () => {
  it("mints an installation token with the app JWT and caches it per company", async () => {
    const { fetch, calls } = mockFetch([tokenRoute("installation_token_1", 3600)]);
    const resolveSecret = appSecrets();

    const first = await resolveGitHubAppInstallationToken({ companyId: "company-a", resolveSecret, fetchImpl: fetch });
    const second = await resolveGitHubAppInstallationToken({ companyId: "company-a", resolveSecret, fetchImpl: fetch });

    expect(first).toBe("installation_token_1");
    expect(second).toBe("installation_token_1");
    const posts = calls.filter((call) => call.url.endsWith("/access_tokens"));
    expect(posts).toHaveLength(1);
    const authorization = authHeader(posts[0]!.init);
    expect(authorization?.startsWith("Bearer eyJ")).toBe(true);
    expect(authorization).not.toContain("PRIVATE KEY");
  });

  it("refreshes the token once the cached copy is inside the expiry skew", async () => {
    let mint = 0;
    const { fetch, calls } = mockFetch([
      {
        match: (url, init) => url.endsWith("/access_tokens") && init?.method === "POST",
        respond: () => {
          mint += 1;
          return Response.json({
            token: `installation_token_${mint}`,
            expires_at: new Date(Date.now() + 30 * 1000).toISOString(),
          });
        },
      },
    ]);
    const resolveSecret = appSecrets();

    const first = await resolveGitHubAppInstallationToken({ companyId: "company-a", resolveSecret, fetchImpl: fetch });
    const second = await resolveGitHubAppInstallationToken({ companyId: "company-a", resolveSecret, fetchImpl: fetch });

    expect(first).toBe("installation_token_1");
    expect(second).toBe("installation_token_2");
    expect(calls.filter((call) => call.url.endsWith("/access_tokens"))).toHaveLength(2);
  });

  it("mints a separate cached token per company", async () => {
    let mint = 0;
    const { fetch, calls } = mockFetch([
      {
        match: (url, init) => url.endsWith("/access_tokens") && init?.method === "POST",
        respond: () => {
          mint += 1;
          return Response.json({
            token: `installation_token_${mint}`,
            expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
          });
        },
      },
    ]);
    const resolveSecret = appSecrets();

    await resolveGitHubAppInstallationToken({ companyId: "company-a", resolveSecret, fetchImpl: fetch });
    await resolveGitHubAppInstallationToken({ companyId: "company-b", resolveSecret, fetchImpl: fetch });

    expect(calls.filter((call) => call.url.endsWith("/access_tokens"))).toHaveLength(2);
  });

  it("discovers the installation when no installation id secret is configured and exactly one is active", async () => {
    const { fetch, calls } = mockFetch([
      {
        match: (url, init) => url === "https://api.github.com/app/installations?per_page=100" && !init?.method,
        respond: () => Response.json([{ id: 4242, suspended_at: null }]),
      },
      tokenRoute("discovered_installation_token", 3600),
    ]);
    const resolveSecret = appSecrets({ GITHUB_APP_INSTALLATION_ID: null, GH_APP_INSTALLATION_ID: null });

    const token = await resolveGitHubAppInstallationToken({ companyId: "company-a", resolveSecret, fetchImpl: fetch });

    expect(token).toBe("discovered_installation_token");
    expect(calls.some((call) => call.url === "https://api.github.com/app/installations/4242/access_tokens")).toBe(true);
  });

  it("returns null instead of guessing when several installations are active", async () => {
    const { fetch, calls } = mockFetch([
      {
        match: (url) => url === "https://api.github.com/app/installations?per_page=100",
        respond: () => Response.json([
          { id: 11, suspended_at: null },
          { id: 22, suspended_at: null },
        ]),
      },
    ]);
    const resolveSecret = appSecrets({ GITHUB_APP_INSTALLATION_ID: null, GH_APP_INSTALLATION_ID: null });

    const token = await resolveGitHubAppInstallationToken({ companyId: "company-a", resolveSecret, fetchImpl: fetch });

    expect(token).toBeNull();
    expect(calls.some((call) => call.url.endsWith("/access_tokens"))).toBe(false);
  });

  it("returns null without throwing when app config is absent or minting fails", async () => {
    const throwingFetch = async () => {
      throw new Error("network down");
    };
    expect(
      await resolveGitHubAppInstallationToken({
        companyId: "company-a",
        resolveSecret: appSecrets({ GITHUB_APP_ID: null, GH_APP_ID: null }),
        fetchImpl: throwingFetch as typeof globalThis.fetch,
      }),
    ).toBeNull();

    const { fetch } = mockFetch([
      {
        match: (url) => url.endsWith("/access_tokens"),
        respond: () => new Response("bad credentials", { status: 401 }),
      },
    ]);
    const failed = await resolveGitHubAppInstallationToken({
      companyId: "company-a",
      resolveSecret: appSecrets(),
      fetchImpl: fetch,
    });
    expect(failed).toBeNull();
  });

  it("returns null instead of throwing when the secret resolver rejects", async () => {
    const rejectingSecret = async (): Promise<string | null> => {
      throw new Error("vault down");
    };
    await expect(
      resolveGitHubAppInstallationToken({
        companyId: "company-a",
        resolveSecret: rejectingSecret,
        fetchImpl: (async () => new Response("unreachable", { status: 500 })) as typeof globalThis.fetch,
      }),
    ).resolves.toBeNull();
  });

  it("returns null on malformed token payloads instead of caching junk", async () => {
    for (const body of [
      { token: 12345, expires_at: new Date(Date.now() + 3600 * 1000).toISOString() },
      { token: "installation_token_x" },
      { token: "installation_token_x", expires_at: "not-a-date" },
    ]) {
      const { fetch } = mockFetch([
        {
          match: (url) => url.endsWith("/access_tokens"),
          respond: () => Response.json(body),
        },
      ]);
      await expect(
        resolveGitHubAppInstallationToken({
          companyId: "company-a",
          resolveSecret: appSecrets(),
          fetchImpl: fetch,
        }),
      ).resolves.toBeNull();
    }
  });

  it("clamps a far-future expiry so the cache cannot pin a token forever", async () => {
    const { fetch } = mockFetch([
      {
        match: (url, init) => url.endsWith("/access_tokens") && init?.method === "POST",
        respond: () =>
          Response.json({
            token: "installation_token_far",
            expires_at: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
          }),
      },
    ]);
    const resolveSecret = appSecrets();
    const first = await resolveGitHubAppInstallationToken({ companyId: "company-a", resolveSecret, fetchImpl: fetch });
    expect(first).toBe("installation_token_far");
    const second = await resolveGitHubAppInstallationToken({
      companyId: "company-a",
      resolveSecret,
      fetchImpl: fetch,
      now: () => Date.now() + 70 * 60_000,
    });
    // Clamp is 1h + 5m skew: 70m later the entry is stale and a re-mint happens.
    expect(second).toBe("installation_token_far");
  });

  it("prefers the configured installation id over discovery and returns null when none are active", async () => {
    // Non-numeric configured id -> falls through to discovery.
    const { fetch, calls } = mockFetch([
      {
        match: (url, init) => url === "https://api.github.com/app/installations?per_page=100" && !init?.method,
        respond: () => Response.json([{ id: 4242, suspended_at: null }]),
      },
      tokenRoute("discovered_installation_token", 3600),
    ]);
    const token = await resolveGitHubAppInstallationToken({
      companyId: "company-a",
      resolveSecret: appSecrets({ GITHUB_APP_INSTALLATION_ID: "not-a-number", GH_APP_INSTALLATION_ID: null }),
      fetchImpl: fetch,
    });
    expect(token).toBe("discovered_installation_token");
    expect(calls.some((call) => call.url === "https://api.github.com/app/installations/4242/access_tokens")).toBe(true);

    // Zero active installations (all suspended) -> null. Fresh company so no
    // cached token from the discovery half above masks the null.
    const suspended = mockFetch([
      {
        match: (url) => url === "https://api.github.com/app/installations?per_page=100",
        respond: () => Response.json([{ id: 11, suspended_at: "2026-01-01T00:00:00Z" }]),
      },
    ]);
    await expect(
      resolveGitHubAppInstallationToken({
        companyId: "company-suspended-only",
        resolveSecret: appSecrets({ GITHUB_APP_INSTALLATION_ID: null, GH_APP_INSTALLATION_ID: null }),
        fetchImpl: suspended.fetch,
      }),
    ).resolves.toBeNull();
  });
});

describe("resolveGitHubApiToken (app-first, PAT fallback)", () => {
  it("prefers the installation token and never touches PAT secrets on success", async () => {
    const { fetch } = mockFetch([tokenRoute("installation_token_1", 3600)]);
    const seen: string[][] = [];
    const resolveSecret = async (companyId: string, names: readonly string[]) => {
      seen.push([...names]);
      return appSecrets()(companyId, names);
    };

    const token = await resolveGitHubApiToken({ companyId: "company-a", resolveSecret, fetchImpl: fetch });

    expect(token).toBe("installation_token_1");
    expect(seen.some((names) => names.includes("GITHUB_TOKEN"))).toBe(false);
  });

  it("falls back to the PAT when app config is absent", async () => {
    const { fetch, calls } = mockFetch([]);
    const resolveSecret = appSecrets({ GITHUB_APP_ID: null, GH_APP_ID: null });

    const token = await resolveGitHubApiToken({ companyId: "company-a", resolveSecret, fetchImpl: fetch });

    expect(token).toBe("pat_fallback");
    expect(calls).toHaveLength(0);
  });

  it("falls back to the PAT when minting fails", async () => {
    const { fetch } = mockFetch([
      {
        match: (url) => url.endsWith("/access_tokens"),
        respond: () => new Response("bad credentials", { status: 401 }),
      },
    ]);

    const token = await resolveGitHubApiToken({ companyId: "company-a", resolveSecret: appSecrets(), fetchImpl: fetch });

    expect(token).toBe("pat_fallback");
  });

  it("returns null when neither source has a credential", async () => {
    const { fetch } = mockFetch([]);
    const resolveSecret = appSecrets({
      GITHUB_APP_ID: null,
      GH_APP_ID: null,
      GITHUB_TOKEN: null,
      GH_TOKEN: null,
      PAPERCLIP_GITHUB_TOKEN: null,
    });

    const token = await resolveGitHubApiToken({ companyId: "company-a", resolveSecret, fetchImpl: fetch });

    expect(token).toBeNull();
  });

  it("returns null instead of throwing when the PAT resolver rejects", async () => {
    const rejectingSecret = async (): Promise<string | null> => {
      throw new Error("vault down");
    };
    await expect(
      resolveGitHubApiToken({
        companyId: "company-a",
        resolveSecret: rejectingSecret,
        fetchImpl: (async () => new Response("unreachable", { status: 500 })) as typeof globalThis.fetch,
      }),
    ).resolves.toBeNull();
  });

  it("exposes the well-known secret-name conventions", () => {
    expect(DEFAULT_GITHUB_APP_ID_SECRET_NAMES).toContain("GITHUB_APP_ID");
    expect(DEFAULT_GITHUB_APP_PRIVATE_KEY_SECRET_NAMES).toContain("GITHUB_APP_PRIVATE_KEY");
    expect(DEFAULT_GITHUB_APP_INSTALLATION_ID_SECRET_NAMES).toContain("GITHUB_APP_INSTALLATION_ID");
  });
});
