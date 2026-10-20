import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
  projects,
  projectWorkspaces,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  SESSION_ROTATION_HANDOFF_REASON,
  SESSION_ROTATION_THRESHOLD,
  buildSessionRotationHandoff,
  countConsecutiveSameCodeTerminalFailures,
  shouldRotateSession,
} from "../services/session-rotation.ts";
import { heartbeatService } from "../services/heartbeat.ts";

const CODE = "model_stream_stalled";
const STALLED = "ses_eaebfd3b";

function fail(id: string, code: string | null | undefined, status = "failed") {
  return { id, status, errorCode: code };
}

// Replays the heartbeat else-if branch: streak -> shouldRotate -> handoff on
// a fresh session (null) that must never equal the stalled session id.
function branchDecision(runs: ReturnType<typeof fail>[], stalledSessionId: string) {
  const streak = countConsecutiveSameCodeTerminalFailures(runs);
  const rotate = shouldRotateSession({ count: streak.count, code: streak.code });
  if (!rotate || !streak.code) return { rotate: false as const, streak };
  const freshSessionId: string | null = null;
  const handoff = buildSessionRotationHandoff({
    code: streak.code,
    count: streak.count,
    stalledSessionId,
    runIds: streak.runIds,
  });
  return { rotate: true as const, streak, handoff, freshSessionId };
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres session-rotation heartbeat-wiring tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("session rotation heartbeat query failure", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("session-rotation-wiring-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(workspaceOperations);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // Poisons only the rotation streak query in executeRun's else-if branch:
  // it is the single db.select shaped exactly { id, status, errorCode }
  // (heartbeat.ts rotation block). Every other select passes through for
  // real, so the run claims, executes, and persists through the genuine
  // path; only the streak query rejects, exercising the real catch block
  // that must clear stale rotation state without blocking the run.
  // poisonHits proves the rejection really fired: without it the stale-field
  // assertions below could pass vacuously via the normal clear path.
  let poisonHits = 0;
  function poisonBuilder(builder: unknown): unknown {
    if (!builder || (typeof builder !== "object" && typeof builder !== "function")) return builder;
    return new Proxy(builder as object, {
      get(builderTarget, builderProp, builderReceiver) {
        if (builderProp === "then") {
          return (_resolve: unknown, reject: (reason?: unknown) => void) => {
            poisonHits += 1;
            reject(new Error("simulated rotation streak query failure"));
          };
        }
        const value = Reflect.get(builderTarget, builderProp, builderReceiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => poisonBuilder((value as (...a: unknown[]) => unknown).apply(builderTarget, args));
      },
    });
  }

  function isRotationStreakSelection(selection: unknown): boolean {
    const fields =
      selection && typeof selection === "object"
        ? (selection as Record<string, unknown>)
        : null;
    // Shape + column-identity match: only the heartbeat.ts rotation
    // streak query selects exactly { id, status, errorCode } off the
    // heartbeatRuns table (column objects are module-stable, so
    // identity holds across this import and heartbeat.ts's). Any other
    // 3-key select on another table passes through untouched.
    return (
      fields !== null &&
      Object.keys(fields).length === 3 &&
      fields.id === (heartbeatRuns as Record<string, unknown>).id &&
      fields.status === (heartbeatRuns as Record<string, unknown>).status &&
      fields.errorCode === (heartbeatRuns as Record<string, unknown>).errorCode
    );
  }

  // Wraps any db-like (root db or a tx object) so the streak poison applies
  // inside transactions too. The rotation block itself calls db.select
  // directly (heartbeat.ts, not inside db.transaction), so db-only wrapping
  // would suffice today; the tx wrap is defense-in-depth against a future
  // move of the block into a transaction.
  function wrapDbLike<T extends object>(dbLike: T): T {
    return new Proxy(dbLike, {
      get(target, prop, receiver) {
        if (prop === "transaction") {
          const orig = Reflect.get(target, prop, receiver);
          if (typeof orig !== "function") return orig;
          return (...args: unknown[]) =>
            Reflect.apply(
              orig as (...a: unknown[]) => unknown,
              target,
              args.map((a) =>
                typeof a === "function"
                  ? (...cbArgs: unknown[]) =>
                      (a as (...c: unknown[]) => unknown)(
                        ...cbArgs.map((c) =>
                          c !== null && (typeof c === "object" || typeof c === "function")
                            ? wrapDbLike(c as object)
                            : c,
                        ),
                      )
                  : a,
              ),
            );
        }
        if (prop !== "select") return Reflect.get(target, prop, receiver);
        return (selection: unknown, ...rest: unknown[]) => {
          const inner = (target as any).select(selection, ...rest);
          return isRotationStreakSelection(selection) ? poisonBuilder(inner) : inner;
        };
      },
    }) as T;
  }

  function withFailingRotationStreakSelect(realDb: typeof db) {
    return wrapDbLike(realDb);
  }

  it("drives the real heartbeat rotation-query path: rejection clears stale fields and the run continues", async () => {
    poisonHits = 0;
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      status: "active",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Rotation Wire Agent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
      runtimeConfig: {
        heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true },
      },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Rotation query failure clears stale fields",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      status: "queued",
    });
    // Seed the run row with STALE rotation fields: the heartbeat else-if
    // branch must clear them when the streak query rejects. The branch only
    // runs when compaction does not rotate (no session id -> rotate false),
    // so no live provider session is needed here.
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
        paperclipSessionHandoffMarkdown: "stale handoff",
        paperclipSessionRotationReason: "stale reason",
        paperclipPreviousSessionId: "ses_stale",
      },
    });

    const failingDb = withFailingRotationStreakSelect(db);
    const heartbeat = heartbeatService(failingDb, {
      runtimeEnv: { PAPERCLIP_IN_WORKTREE: "false" },
    });
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    // The run continued past the rejected rotation query (fail-closed), not
    // aborted by it: it reached a terminal outcome through the real path.
    const run = await db
      .select({
        status: heartbeatRuns.status,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run).not.toBeNull();
    expect(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]).toContain(run?.status);
    // The streak query really rejected through the poisoned path (catch
    // block exercised), not a vacuous green via the normal clear path.
    expect(poisonHits).toBeGreaterThan(0);
    const context = (run?.contextSnapshot ?? {}) as Record<string, unknown>;
    // If heartbeat.ts's catch block were emptied, the stale seed fields
    // would survive onto the persisted context: this is the signal.
    expect(context.paperclipSessionHandoffMarkdown).toBeUndefined();
    expect(context.paperclipSessionRotationReason).toBeUndefined();
    expect(context.paperclipPreviousSessionId).toBeUndefined();
  }, 20_000);
});

describe("session rotation heartbeat wiring", () => {
  it("2 consecutive same-code failures rotate to a fresh session", () => {
    const d = branchDecision([fail("r2", CODE), fail("r1", CODE)], STALLED);
    expect(d.rotate).toBe(true);
    expect(d.streak.count).toBe(2);
    expect(d.rotate && d.freshSessionId).not.toBe(STALLED);
    expect(d.rotate && d.freshSessionId).toBeNull();
    if (d.rotate) {
      expect(d.handoff).toContain(STALLED);
      expect(d.handoff).toContain(CODE);
      expect(d.handoff).toContain("never resume");
      expect(d.handoff).toContain(SESSION_ROTATION_HANDOFF_REASON);
    }
    expect(SESSION_ROTATION_HANDOFF_REASON).toBe("session_rotation_same_stall_code");
    expect(SESSION_ROTATION_THRESHOLD).toBeLessThan(3);
  });

  it("3rd consecutive same-code failure still rotates without resetting", () => {
    const d = branchDecision([fail("r3", CODE), fail("r2", CODE), fail("r1", CODE)], STALLED);
    expect(d.rotate).toBe(true);
    expect(d.streak.count).toBe(3);
    if (d.rotate) expect(d.handoff).toContain("x3 consecutive");
  });

  it("different code, null code, or success do not rotate (fail-closed)", () => {
    expect(branchDecision([fail("r2", "other_code"), fail("r1", CODE)], STALLED).rotate).toBe(false);
    expect(branchDecision([fail("r2", null), fail("r1", CODE)], STALLED).rotate).toBe(false);
    expect(branchDecision([{ id: "r2", status: "succeeded", errorCode: CODE }, fail("r1", CODE)], STALLED).rotate).toBe(false);
  });

  it("negative: newest differs so streak is 1, no rotation", () => {
    const streak = countConsecutiveSameCodeTerminalFailures([fail("r3", "other_code"), fail("r2", CODE), fail("r1", CODE)]);
    expect(streak.count).toBe(1);
    expect(shouldRotateSession({ count: streak.count, code: streak.code })).toBe(false);
  });
});
