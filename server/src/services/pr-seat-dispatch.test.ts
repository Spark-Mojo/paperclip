/**
 * SPA-13735 d27 — PR seat-dispatch end-to-end at the exported seam.
 *
 * Drives dispatchSableSeatSummonsForPullRequest (exported from
 * github-connection-events.ts, additive seam per SPA-13818 ruling 5 — the
 * production pollOnce path, the dynamic issueService import and the default
 * resolver behavior are unchanged) with stubbed resolve/create deps, so a PR
 * event → seat card + summons runs with no live Db and no live infra.
 *
 * Scope per SPA-13818 rulings 2+3+4 (d27 cut-b): repo-qualified dispatch
 * (fork + platform repo) with NO changedFiles gate (the leased pull_request
 * allowlist carries no changedFiles; fail-closed skips stay for malformed
 * payloads only); one-sided dedupeKey/idempotencyKey contract (no wait on
 * SPA-13661); cut-b — a summons whose author identity cannot be established
 * server-side is never dispatched (logged "no_author_identity" skip after
 * the seat card is filed); the summons path requires input.serverAuthor
 * (server-established, never client input; enrichment SPA-13821, path
 * precision SPA-13820).
 */
import { describe, expect, it } from "vitest";
import {
  dispatchSableSeatSummonsForPullRequest,
  isSableSeatDispatchRepo,
  SABLE_SEAT_REVIEW_MARKER,
  seatCardCreateInput,
  type SableSeatDispatchDeps,
  type SableSeatSummonsCreateInput,
} from "./github-connection-events.js";
import { dedupeKey } from "./sable-seat-dispatch.js";
import { evaluateSeatSummonsResolve } from "./seat-summons-self-resolve-guard.js";

const COMPANY = "company-d22";
const OWNER = "spark-mojo";
const REPO = "paperclip";
const NUMBER = 42;
const KEY = dedupeKey({ owner: OWNER, repo: REPO, number: NUMBER })!;

function makeLogs() {
  const info: Array<{ fields: Record<string, unknown>; message: string }> = [];
  const warn: Array<{ fields: Record<string, unknown>; message: string }> = [];
  return {
    info,
    warn,
    logInfo: (fields: Record<string, unknown>, message: string) => {
      info.push({ fields, message });
    },
    logWarn: (fields: Record<string, unknown>, message: string) => {
      warn.push({ fields, message });
    },
  };
}

function makeDeps(overrides: Partial<SableSeatDispatchDeps> = {}) {
  const created: Array<{
    seatIssueId: string;
    summons: SableSeatSummonsCreateInput;
  }> = [];
  const resolved: Array<{
    companyId: string;
    matchedPatterns: string[];
    key: string;
  }> = [];
  const logs = makeLogs();
  const deps: SableSeatDispatchDeps = {
    resolveSeatCardIssue: async (companyId, _snapshot, matchedPatterns, key) => {
      resolved.push({ companyId, matchedPatterns, key });
      return { id: "seat-issue-1" };
    },
    createSummons: async (seatIssueId, summons) => {
      created.push({ seatIssueId, summons });
      return { id: "summons-1" };
    },
    dispatchedKeys: new Set<string>(),
    logInfo: logs.logInfo,
    logWarn: logs.logWarn,
    ...overrides,
  };
  return { deps, created, resolved, logs };
}

function openedInput(extra: Record<string, unknown> = {}) {
  return {
    companyId: COMPANY,
    action: "opened",
    snapshot: {
      repository: `${OWNER}/${REPO}`,
      owner: OWNER,
      repo: REPO,
      number: NUMBER,
    },
    // d27: established server-side author (stand-in for SPA-13821
    // enrichment — never client input). Production-shaped calls omit this.
    serverAuthor: { actorId: "user-pr-author", actorType: "user" },
    ...extra,
  };
}

describe("pr-seat-dispatch e2e — seat card + summons filed (d22)", () => {
  it("fork + platform repos qualify for dispatch (canonical + lowercase)", () => {
    expect(isSableSeatDispatchRepo("Spark-Mojo/paperclip")).toBe(true);
    expect(isSableSeatDispatchRepo("spark-mojo/paperclip")).toBe(true);
    expect(isSableSeatDispatchRepo("Spark-Mojo/spark-mojo-platform")).toBe(true);
    expect(isSableSeatDispatchRepo("spark-mojo/spark-mojo-platform")).toBe(true);
    expect(isSableSeatDispatchRepo("spark-mojo/other")).toBe(false);
    expect(isSableSeatDispatchRepo(null)).toBe(false);
  });

  it("platform repo PR dispatches seat card + summons with established author", async () => {
    const { deps, created, resolved } = makeDeps();
    const result = await dispatchSableSeatSummonsForPullRequest(
      {
        companyId: COMPANY,
        action: "opened",
        serverAuthor: { actorId: "user-pr-author", actorType: "user" },
        snapshot: {
          repository: "Spark-Mojo/spark-mojo-platform",
          owner: "Spark-Mojo",
          repo: "spark-mojo-platform",
          number: NUMBER,
        },
      },
      deps,
    );
    expect(result).toEqual({ dispatched: true, reason: "dispatched" });
    expect(resolved).toHaveLength(1);
    expect(created).toHaveLength(1);
    expect(created[0]!.summons.prAuthorActorId).toBe("user-pr-author");
    expect(created[0]!.summons.tags).toContain("seat-summons");
  });

  it("files the seat card and the summons with seat-summons/sable-seat tags", async () => {    const { deps, created, resolved } = makeDeps();
    const result = await dispatchSableSeatSummonsForPullRequest(
      { ...openedInput(), changedFiles: ["docker-compose.yml"] },
      deps,
    );
    expect(result).toEqual({ dispatched: true, reason: "dispatched" });
    // Seat card resolved once, one-sided idempotencyKey = dedupeKey.
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.companyId).toBe(COMPANY);
    expect(resolved[0]!.key).toBe(KEY);
    // Per-event triage surface recorded (opportunistic, never a gate).
    expect(resolved[0]!.matchedPatterns).toContain("docker-compose");
    // Summons filed once on the seat card, carrying the PR link + tags.
    expect(created).toHaveLength(1);
    const summons = created[0]!.summons;
    expect(created[0]!.seatIssueId).toBe("seat-issue-1");
    expect(summons.idempotencyKey).toBe(KEY);
    expect(summons.title).toContain(`${OWNER}/${REPO}#${NUMBER}`);
    expect(summons.prompt).toContain(`${OWNER}/${REPO}#${NUMBER}`);
    expect(summons.detailsMarkdown).toContain(
      `https://github.com/${OWNER}/${REPO}/pull/${NUMBER}`,
    );
    expect(summons.detailsMarkdown).toContain(`${OWNER}/${REPO}#${NUMBER}`);
    expect(summons.tags).toContain("seat-summons");
    expect(summons.tags).toContain("sable-seat");
    // Established server-side author rides the summons (cut-b).
    expect(summons.prAuthorActorId).toBe("user-pr-author");
    expect(summons.prAuthorActorType).toBe("user");
  });

  it("d25 minimal Sable review stage: card payload carries review marker + PR link, status stays todo", () => {
    const snapshot = {
      repository: `${OWNER}/${REPO}`,
      owner: OWNER,
      repo: REPO,
      number: NUMBER,
    };
    const payload = seatCardCreateInput(snapshot, ["docker-compose"], KEY);
    // Honest stage: todo + unassigned (no assignee keys at all), marked
    // unmistakably for Sable review; the summons thread on the card IS the
    // review surface (Sable resolves it, guard refuses self-resolve).
    expect(payload.status).toBe("todo");
    expect(payload.priority).toBe("medium");
    expect(payload.idempotencyKey).toBe(KEY);
    expect(Object.keys(payload).sort()).toEqual(
      ["description", "idempotencyKey", "priority", "status", "title"].sort(),
    );
    expect(payload.title).toContain("Sable review");
    expect(payload.description).toContain(SABLE_SEAT_REVIEW_MARKER);
    expect(payload.description).toContain(
      `https://github.com/${OWNER}/${REPO}/pull/${NUMBER}`,
    );
    expect(payload.description).toContain("seat-summons");
  });

  it("replay with the same key dedupes: second event suppressed", async () => {
    const { deps, created, resolved, logs } = makeDeps();
    const first = await dispatchSableSeatSummonsForPullRequest(
      openedInput(),
      deps,
    );
    expect(first).toEqual({ dispatched: true, reason: "dispatched" });
    const second = await dispatchSableSeatSummonsForPullRequest(
      { ...openedInput(), action: "synchronize" },
      deps,
    );
    expect(second).toEqual({
      dispatched: false,
      reason: "duplicate_suppressed",
    });
    expect(resolved).toHaveLength(1);
    expect(created).toHaveLength(1);
    expect(logs.info.length).toBeGreaterThan(0);
  });
});

describe("pr-seat-dispatch e2e — logged skip paths (d22)", () => {
  it("resolver failure is a logged skip: no summons filed", async () => {
    const { deps, created, resolved, logs } = makeDeps({
      resolveSeatCardIssue: async (companyId, _snapshot, matchedPatterns, key) => {
        resolved.push({ companyId, matchedPatterns, key });
        return null;
      },
    });
    const result = await dispatchSableSeatSummonsForPullRequest(
      openedInput(),
      deps,
    );
    expect(result).toEqual({ dispatched: false, reason: "no_seat_card_issue" });
    expect(resolved).toHaveLength(1);
    expect(created).toHaveLength(0);
    expect(logs.info.length).toBeGreaterThan(0);
  });

  it("create failure is a logged skip: fail-closed, nothing escapes", async () => {
    const { deps, created, logs } = makeDeps({
      createSummons: async () => {
        throw new Error("summons store unavailable");
      },
    });
    const result = await dispatchSableSeatSummonsForPullRequest(
      openedInput(),
      deps,
    );
    expect(result).toEqual({
      dispatched: false,
      reason: "summons_create_failed",
    });
    expect(created).toHaveLength(0);
    expect(logs.warn.length).toBeGreaterThan(0);
  });

  it("null summons create is a logged skip: fail-closed, no key added", async () => {
    const { deps, logs } = makeDeps({
      createSummons: async () => null,
    });
    const result = await dispatchSableSeatSummonsForPullRequest(
      openedInput(),
      deps,
    );
    expect(result).toEqual({
      dispatched: false,
      reason: "summons_create_failed",
    });
    expect(deps.dispatchedKeys.has(KEY)).toBe(false);
    expect(logs.warn.length).toBeGreaterThan(0);
  });

  it("d27 cut-b: production-shaped call with no establishable author files the card but skips the summons", async () => {
    const { deps, created, resolved, logs } = makeDeps();
    const result = await dispatchSableSeatSummonsForPullRequest(
      { ...openedInput(), serverAuthor: null },
      deps,
    );
    // DoD preserved (the qualifying event still yields a seat card) while
    // honoring cut-b: no unattributed summons is dispatched.
    expect(result).toEqual({ dispatched: false, reason: "no_author_identity" });
    expect(resolved).toHaveLength(1);
    expect(created).toHaveLength(0);
    expect(deps.dispatchedKeys.has(KEY)).toBe(false);
    expect(logs.info.length).toBeGreaterThan(0);
  });

  it("d27 cut-e: guard refuses the author but allows a third-party (Sable) resolver on the filed summons shape", async () => {
    const { deps, created } = makeDeps();
    const result = await dispatchSableSeatSummonsForPullRequest(
      openedInput(),
      deps,
    );
    expect(result).toEqual({ dispatched: true, reason: "dispatched" });
    expect(created).toHaveLength(1);
    const summons = created[0]!.summons;
    // Re-establish the filed summons shape with the established pair and
    // prove the guard resolves: author refused, third party allowed.
    const authorRefused = evaluateSeatSummonsResolve({
      isSummons: true,
      resolverActorId: summons.prAuthorActorId,
      resolverActorType: summons.prAuthorActorType,
      prAuthorActorId: "user-pr-author",
      prAuthorActorType: "user",
      creatorAgentId: "agent-other",
    });
    expect(authorRefused.allowed).toBe(false);
    expect(authorRefused.code).toBe("author_actor_self_resolve_refused");
    const sableAllowed = evaluateSeatSummonsResolve({
      isSummons: true,
      resolverActorId: "agent-sable",
      resolverActorType: "agent",
      prAuthorActorId: summons.prAuthorActorId,
      prAuthorActorType: summons.prAuthorActorType,
      creatorAgentId: "agent-other",
    });
    expect(sableAllowed).toEqual(
      expect.objectContaining({ allowed: true, code: "allow" }),
    );
  });

  it("non-platform repo is a logged skip: resolver never called", async () => {
    const { deps, created, resolved, logs } = makeDeps();
    const result = await dispatchSableSeatSummonsForPullRequest(
      {
        ...openedInput(),
        snapshot: {
          repository: "spark-mojo/other",
          owner: "spark-mojo",
          repo: "other",
          number: NUMBER,
        },
      },
      deps,
    );
    expect(result).toEqual({
      dispatched: false,
      reason: "repo_not_dispatchable",
    });
    expect(resolved).toHaveLength(0);
    expect(created).toHaveLength(0);
    expect(logs.info.length).toBeGreaterThan(0);
  });

  it("closed action is a logged skip", async () => {
    const { deps, created, resolved, logs } = makeDeps();
    const result = await dispatchSableSeatSummonsForPullRequest(
      { ...openedInput(), action: "closed" },
      deps,
    );
    expect(result).toEqual({
      dispatched: false,
      reason: "action_not_dispatchable",
    });
    expect(resolved).toHaveLength(0);
    expect(created).toHaveLength(0);
    expect(logs.info.length).toBeGreaterThan(0);
  });

  it("malformed PR ref is a logged skip: invalid_pr_ref", async () => {
    const { deps, created, resolved, logs } = makeDeps();
    const result = await dispatchSableSeatSummonsForPullRequest(
      {
        ...openedInput(),
        snapshot: {
          repository: `${OWNER}/${REPO}`,
          owner: OWNER,
          repo: REPO,
          number: Number.NaN,
        },
      },
      deps,
    );
    expect(result).toEqual({ dispatched: false, reason: "invalid_pr_ref" });
    expect(resolved).toHaveLength(0);
    expect(created).toHaveLength(0);
    expect(logs.warn.length).toBeGreaterThan(0);
  });
});
