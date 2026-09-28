import { describe, expect, it } from "vitest";
import {
  createServerInfoSnapshot,
  getServerInfoSnapshot,
  refreshServerInfoForTests,
  resetServerInfoCacheForTests,
} from "../server-info.js";

function gitCommandFor(shortSha: string, subject: string): () => Promise<string> {
  return async () =>
    [shortSha.padEnd(40, "0"), shortSha, subject, "2026-06-25T17:00:00-07:00"].join("\n");
}

describe("server info snapshot", () => {
  it("captures process start time and git metadata", async () => {
    const snapshot = await createServerInfoSnapshot({
      now: new Date("2026-06-26T00:00:00.000Z"),
      gitCommand: async () =>
        [
          "0123456789abcdef0123456789abcdef01234567",
          "0123456",
          "Add server info debug view",
          "2026-06-25T17:00:00-07:00",
        ].join("\n"),
      gitBranchCommand: async () => "feature/server-info\n",
      gitStatusCommand: async () => "",
    });

    expect(snapshot).toEqual({
      processStartedAt: "2026-06-26T00:00:00.000Z",
      git: {
        available: true,
        fullSha: "0123456789abcdef0123456789abcdef01234567",
        shortSha: "0123456",
        branchName: "feature/server-info",
        subject: "Add server info debug view",
        committedAt: "2026-06-26T00:00:00.000Z",
        localChanges: {
          available: true,
          hasLocalChanges: false,
          stagedFileCount: 0,
          unstagedFileCount: 0,
          untrackedFileCount: 0,
        },
      },
    });
  });

  it("summarizes local checkout changes without exposing file paths", async () => {
    const snapshot = await createServerInfoSnapshot({
      now: new Date("2026-06-26T00:00:00.000Z"),
      gitCommand: async () =>
        [
          "0123456789abcdef0123456789abcdef01234567",
          "0123456",
          "Add server info debug view",
          "2026-06-25T17:00:00-07:00",
        ].join("\n"),
      gitStatusCommand: async () =>
        [
          "M  packages/shared/src/types/server-info.ts",
          " M ui/src/components/SidebarServerInfo.tsx",
          "MM server/src/server-info.ts",
          "?? server/src/__tests__/server-info.test.ts",
        ].join("\n"),
    });

    expect(snapshot.git).toMatchObject({
      available: true,
      localChanges: {
        available: true,
        hasLocalChanges: true,
        stagedFileCount: 2,
        unstagedFileCount: 2,
        untrackedFileCount: 1,
      },
    });
  });

  it("keeps commit metadata available when git status is unavailable", async () => {
    const snapshot = await createServerInfoSnapshot({
      now: new Date("2026-06-26T00:00:00.000Z"),
      gitCommand: async () =>
        [
          "0123456789abcdef0123456789abcdef01234567",
          "0123456",
          "Add server info debug view",
          "2026-06-25T17:00:00-07:00",
        ].join("\n"),
      gitStatusCommand: async () => {
        throw new Error("status unavailable");
      },
    });

    expect(snapshot.git).toMatchObject({
      available: true,
      localChanges: {
        available: false,
        unavailableReason: "git_status_unavailable",
      },
    });
  });

  it("keeps commit metadata available when HEAD is detached", async () => {
    const snapshot = await createServerInfoSnapshot({
      now: new Date("2026-06-26T00:00:00.000Z"),
      gitCommand: async () =>
        [
          "0123456789abcdef0123456789abcdef01234567",
          "0123456",
          "Add server info debug view",
          "2026-06-25T17:00:00-07:00",
        ].join("\n"),
      gitBranchCommand: async () => {
        throw new Error("detached HEAD");
      },
      gitStatusCommand: async () => "",
    });

    expect(snapshot.git).toMatchObject({
      available: true,
      branchName: null,
      shortSha: "0123456",
    });
  });

  it("uses sanitized fallback metadata when git is unavailable", async () => {
    const snapshot = await createServerInfoSnapshot({
      now: new Date("2026-06-26T00:00:00.000Z"),
      gitCommand: async () => {
        throw new Error("fatal: not a git repository");
      },
      buildCommitCommand: () => null,
    });

    expect(snapshot).toEqual({
      processStartedAt: "2026-06-26T00:00:00.000Z",
      git: {
        available: false,
        unavailableReason: "git_unavailable",
      },
    });
  });

  it("uses deployment commit metadata when the runtime has no git directory", async () => {
    const snapshot = await createServerInfoSnapshot({
      now: new Date("2026-06-26T00:00:00.000Z"),
      gitCommand: async () => {
        throw new Error("fatal: not a git repository");
      },
      buildCommitCommand: () => "0123456789abcdef0123456789abcdef01234567",
    });

    expect(snapshot).toEqual({
      processStartedAt: "2026-06-26T00:00:00.000Z",
      git: {
        available: true,
        fullSha: "0123456789abcdef0123456789abcdef01234567",
        shortSha: "0123456",
        branchName: null,
        subject: "Source build",
        committedAt: null,
        localChanges: {
          available: false,
          unavailableReason: "git_status_unavailable",
        },
      },
    });
  });
});

describe("getServerInfoSnapshot", () => {
  it("serves a stable snapshot from the cache without running git on the sync path", () => {
    resetServerInfoCacheForTests();

    const first = getServerInfoSnapshot();
    // The seeded cache is either a valid build commit (available) or the
    // explicit unavailable marker — never a partial snapshot.
    if (first.git.available) {
      expect(first.git.fullSha).toMatch(/^[0-9a-f]{40}$/);
      expect(first.git.subject).toBe("Source build");
    } else {
      expect(first.git.unavailableReason).toBe("git_unavailable");
    }

    // The sync reader is stable between refreshes: it cannot observe a
    // half-written cache, and reading it must not trigger any git spawn.
    const second = getServerInfoSnapshot();
    expect(second.processStartedAt).toBe(first.processStartedAt);
    expect(second.git).toEqual(first.git);
  });

  it("picks up a refreshed HEAD after an explicit background refresh", async () => {
    resetServerInfoCacheForTests();

    await refreshServerInfoForTests({
      gitCommand: gitCommandFor("aaaaaaa", "Live HEAD"),
      gitStatusCommand: async () => "",
    });
    expect(getServerInfoSnapshot().git).toMatchObject({
      shortSha: "aaaaaaa",
      subject: "Live HEAD",
    });

    // A later refresh replaces it again — the cache tracks the running HEAD.
    await refreshServerInfoForTests({
      gitCommand: gitCommandFor("bbbbbbb", "After restart"),
      gitStatusCommand: async () => "",
    });
    expect(getServerInfoSnapshot().git).toMatchObject({
      shortSha: "bbbbbbb",
      subject: "After restart",
    });
  });

  it("keeps processStartedAt stable across refreshes", async () => {
    resetServerInfoCacheForTests();
    const first = getServerInfoSnapshot();
    await refreshServerInfoForTests({
      gitCommand: gitCommandFor("ccccccc", "c"),
      gitStatusCommand: async () => "",
    });
    expect(getServerInfoSnapshot().processStartedAt).toBe(first.processStartedAt);
  });
});
