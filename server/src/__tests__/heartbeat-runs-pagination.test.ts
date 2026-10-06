import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  HEARTBEAT_RUN_LIST_MAX_LIMIT,
  parseHeartbeatRunListPage,
} from "../routes/agents.ts";
import { heartbeatService } from "../services/heartbeat.ts";

// SPA-10587: the company heartbeat-run list silently ignored `offset`, offered
// no cursor, and clamped an over-cap `limit` without a signal — so it could only
// ever return the newest page and a caller could not detect truncation. These
// cases run against real Postgres and real rows, so removing `.offset()` from
// the list query makes the paging cases FAIL rather than pass vacuously.
/**
 * Walks pages until one is SHORT — the termination condition the fleet
 * pagination rule requires. Bounded at 50 pages so an implementation that
 * never shortens a page fails a named assertion instead of hanging the suite.
 */
async function walkPages<T extends { id: string }>(
  fetchPage: (offset: number) => Promise<T[]>,
  pageSize = 2,
) {
  const ids: string[] = [];
  let pagesRead = 0;
  let reason: "short page" | "page cap reached" = "short page";
  for (let offset = 0; pagesRead <= 50; offset += pageSize) {
    pagesRead += 1;
    const page = await fetchPage(offset);
    ids.push(...page.map((row) => row.id));
    if (page.length < pageSize) {
      return { ids, reason, pagesRead };
    }
  }
  return { ids, reason: "page cap reached", pagesRead };
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat run pagination tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat run list pagination", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-hb-run-paging-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedRunCount(count: number) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    // Distinct, strictly increasing createdAt so newest-first order is total and
    // a skipped/duplicated row cannot hide behind an ambiguous sort.
    const base = new Date("2026-01-01T00:00:00.000Z").getTime();
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const runId = randomUUID();
      ids.push(runId);
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: new Date(base + index * 1_000),
        updatedAt: new Date(base + index * 1_000),
      });
    }

    // Newest first, matching the list route's `orderBy(createdAt desc)`.
    return { companyId, agentId, newestFirst: [...ids].reverse() };
  }

  it("paginates: page 2 differs from page 1 and the pages do not overlap", async () => {
    const { companyId, newestFirst } = await seedRunCount(5);

    const page1 = await heartbeatService(db).list(companyId, undefined, 2, {
      summary: true,
    });
    const page2 = await heartbeatService(db).list(companyId, undefined, 2, {
      summary: true,
      offset: 2,
    });
    const page3 = await heartbeatService(db).list(companyId, undefined, 2, {
      summary: true,
      offset: 4,
    });

    expect(page1.map((run) => run.id)).toEqual(newestFirst.slice(0, 2));
    expect(page2.map((run) => run.id)).toEqual(newestFirst.slice(2, 4));
    expect(page3.map((run) => run.id)).toEqual(newestFirst.slice(4, 5));

    // The exact condition today's suite could not express: without `.offset()`
    // page 2 is byte-identical to page 1, so these two assertions are the
    // positive control that paging is real.
    expect(page2.map((run) => run.id)).not.toEqual(page1.map((run) => run.id));
    expect(
      page1.filter((run) => page2.some((other) => other.id === run.id)),
    ).toEqual([]);

    // Walking the whole population by offset recovers every row exactly once.
    // The walk is bounded on purpose: with an inert `offset` the page is never
    // short and never advances, so an unbounded loop HANGS instead of failing.
    // The bound turns that hang into a named assertion failure.
    const walked: string[] = [];
    const walk = await walkPages((offset) =>
      heartbeatService(db).list(companyId, undefined, 2, { summary: true, offset }),
    );
    walked.push(...walk.ids);
    expect(walk.reason, walk.pagesRead > 50 ? "offset loop never terminated" : "").toBe(
      "short page",
    );
    expect(walked).toEqual(newestFirst);
    expect(new Set(walked).size).toBe(5);
  });

  it("signals: a full page reads as truncated and a short page reads as complete", async () => {
    const { companyId, newestFirst } = await seedRunCount(5);

    // The probe row the route asks for: page.limit + 1 tells the caller
    // definitively whether more rows exist, rather than inferring it from a
    // full page that might also be the last page.
    const fullPageProbe = await heartbeatService(db).list(
      companyId,
      undefined,
      3,
      { summary: true },
    );
    expect(fullPageProbe).toHaveLength(3);
    expect(fullPageProbe.map((run) => run.id)).toEqual(newestFirst.slice(0, 3));

    const lastPageProbe = await heartbeatService(db).list(
      companyId,
      undefined,
      3,
      { summary: true, offset: 3 },
    );
    expect(lastPageProbe).toHaveLength(2);
    expect(lastPageProbe.length < 3).toBe(true);

    // An offset past the end returns an empty page, not the newest page. This is
    // the assertion that would have caught the inert `offset`: it returned the
    // newest page for every offset.
    const pastEnd = await heartbeatService(db).list(companyId, undefined, 3, {
      summary: true,
      offset: 500,
    });
    expect(pastEnd).toEqual([]);
  });

  it("keeps the agentId filter applied across pages", async () => {
    const companyId = randomUUID();
    const agentA = randomUUID();
    const agentB = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    for (const [id, name] of [
      [agentA, "AgentA"],
      [agentB, "AgentB"],
    ] as const) {
      await db.insert(agents).values({
        id,
        companyId,
        name,
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
    }

    const base = new Date("2026-02-01T00:00:00.000Z").getTime();
    // Interleave two agents so a filter dropped at the page boundary shows up.
    const agentARuns: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      for (const agentId of index % 2 === 0 ? [agentA, agentB] : [agentB, agentA]) {
        const runId = randomUUID();
        if (agentId === agentA) agentARuns.push(runId);
        await db.insert(heartbeatRuns).values({
          id: runId,
          companyId,
          agentId,
          invocationSource: "assignment",
          status: "succeeded",
          createdAt: new Date(base + index * 1_000),
          updatedAt: new Date(base + index * 1_000),
        });
      }
    }

    const foreignIds: string[] = [];
    const walk = await walkPages(async (offset) => {
      const page = await heartbeatService(db).list(companyId, agentA, 2, {
        summary: true,
        offset,
      });
      for (const run of page) if (run.agentId !== agentA) foreignIds.push(run.id);
      return page;
    });

    expect(foreignIds).toEqual([]);
    expect(walk.reason, walk.pagesRead > 50 ? "offset loop never terminated" : "").toBe(
      "short page",
    );
    expect(walk.ids).toEqual([...agentARuns].reverse());
  });

  it("names the cap the route enforces", () => {
    expect(HEARTBEAT_RUN_LIST_MAX_LIMIT).toBe(1000);
  });
});

describe("heartbeat run list page parsing", () => {
  it("rejects an over-cap limit by name instead of silently clamping it", () => {
    // The card's DoD 3: a clamp is only acceptable WITH a signal. A 400 naming
    // the cap is the signal; silently serving 1000 rows for `limit=5000` is the
    // defect.
    let thrown: unknown;
    try {
      parseHeartbeatRunListPage({ limit: "5000" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { status?: number }).status).toBe(400);
    expect((thrown as Error).message).toContain("1000");
    expect((thrown as Error).message).toContain("5000");
  });

  it("accepts a limit exactly at the cap", () => {
    expect(parseHeartbeatRunListPage({ limit: "1000" })).toEqual({
      limit: 1000,
      offset: 0,
    });
  });

  it("defaults an absent limit to 200 and an absent offset to 0", () => {
    expect(parseHeartbeatRunListPage({})).toEqual({ limit: 200, offset: 0 });
  });

  it("rejects a non-numeric or negative offset", () => {
    for (const offset of ["abc", "-1", "1.5", ""]) {
      let thrown: unknown;
      try {
        parseHeartbeatRunListPage({ offset });
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `offset=${JSON.stringify(offset)} must be rejected`).toBeDefined();
      expect((thrown as { status?: number }).status).toBe(400);
    }
  });

  it("rejects a non-numeric, zero, or negative limit", () => {
    for (const limit of ["abc", "0", "-5", "1.5", ""]) {
      let thrown: unknown;
      try {
        parseHeartbeatRunListPage({ limit });
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `limit=${JSON.stringify(limit)} must be rejected`).toBeDefined();
      expect((thrown as { status?: number }).status).toBe(400);
    }
  });

  it("rejects a repeated query parameter rather than picking one silently", () => {
    let thrown: unknown;
    try {
      parseHeartbeatRunListPage({ limit: ["10", "20"] });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { status?: number }).status).toBe(400);
  });

  it("parses a valid offset", () => {
    expect(parseHeartbeatRunListPage({ limit: "25", offset: "100" })).toEqual({
      limit: 25,
      offset: 100,
    });
  });
});
