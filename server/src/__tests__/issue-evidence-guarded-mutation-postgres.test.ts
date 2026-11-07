import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request, { type Response } from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@paperclipai/plugin-sdk", async () =>
  import("../../../packages/plugins/sdk/src/index.ts"));
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping embedded Postgres evidence-guard tests: ${support.reason ?? "unsupported host"}`);
}

type Db = ReturnType<typeof createDb>;
type Cursor = { createdAt: string; id: string } | null;
type Precondition = {
  issue: { status: string; assigneeAgentId: string | null; assigneeUserId: string | null };
  comments: { latest: Cursor; countIncludingDeleted: number; deletionDigest: string };
  activity: { latest: Cursor; count: number };
};
type Fixture = {
  companyId: string;
  otherCompanyId: string;
  issueId: string;
  assigneeAgentId: string;
  otherAgentId: string;
  deletedCommentId: string;
  commentClientRequestId: string;
  guardApp: express.Express;
  anonymousApp: express.Express;
  otherCompanyApp: express.Express;
};
type Snapshot = Awaited<ReturnType<typeof snapshot>>;
type Writer = {
  name: string;
  firstTable: "issues" | "issue_comments";
  expectedMismatchIds: MismatchId[];
  run: (fixture: Fixture) => Promise<Response>;
  assertSuccess: (response: Response, fixture: Fixture) => void;
  assertEffect: (before: Snapshot, after: Snapshot, fixture: Fixture) => void;
};
type AuditRow = {
  backendPid: number;
  transactionId: string;
  tableName: string;
  operation: string;
  issueId: string;
  issueLockSeen: boolean;
};

const BASE_TIME = new Date("2026-01-01T00:00:00.000Z");
const COMMENT_LOW_ID = "10000000-0000-4000-8000-000000000001";
const COMMENT_HIGH_ID = "f0000000-0000-4000-8000-000000000001";
const ACTIVITY_LOW_ID = "10000000-0000-4000-8000-000000000002";
const ACTIVITY_HIGH_ID = "f0000000-0000-4000-8000-000000000002";
const BOARD_USER_ID = "guarded-mutation-user";
const COMPETING_USER_ID = "competing-user";
const ORIGINAL_COMMENT_BODY = "original comment body must never enter refusal evidence";
const TIE_COMMENT_BODY = "equal-time ID tie-break comment";
const COMPETING_COMMENT_BODY = "competing comment body must never enter refusal evidence";
const BODY_SHAPED_ARBITRARY = `body:${"x".repeat(96)}`;
const REFUSAL_ACTION = "issue.evidence_guarded_mutation_refused";
const REFUSAL_SCHEMA = "issue_evidence_v1";
const OPERATION_ID = "issue.status.done";
const GUARD_APP_NAME = "guarded-evidence-http";
const WRITER_APP_NAME = "guarded-evidence-writer";
const READER_APP_NAME = "guarded-evidence-reader";
const GATE_APP_NAME = "guarded-evidence-gate-holder";
const GATE_LOCK_KEY = 173120031;
const PAUSE_LOCK_KEY = 173120032;

const MISMATCH_IDS = [
  "targetCompanyId",
  "issue.status",
  "issue.assigneeAgentId",
  "issue.assigneeUserId",
  "comments.latest.createdAt",
  "comments.latest.id",
  "comments.countIncludingDeleted",
  "comments.deletionDigest",
  "activity.latest.createdAt",
  "activity.latest.id",
  "activity.count",
] as const;
type MismatchId = (typeof MISMATCH_IDS)[number];

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

/** Independent RFC-8785-shaped canonicalizer: object keys sort recursively. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function evidenceDigest(precondition: Precondition) {
  return sha256(canonicalJson(precondition));
}

function boardActor(companyId: string, userId = BOARD_USER_ID) {
  return {
    type: "board" as const,
    userId,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "owner" as const, status: "active" as const }],
    isInstanceAdmin: false,
    source: "session" as const,
  };
}

function appFor(db: Db, actor?: ReturnType<typeof boardActor>) {
  const app = express();
  app.use(express.json());
  if (actor) app.use((req, _res, next) => { req.actor = actor; next(); });
  app.use("/api", issueRoutes(db, {} as never, {}));
  app.use(errorHandler);
  return app;
}

function endpoint(fixture: Fixture) {
  return `/api/issues/${fixture.issueId}/evidence-guarded-mutations`;
}

function guardedRequest(fixture: Fixture, precondition: Precondition) {
  return {
    targetCompanyId: fixture.companyId,
    precondition,
    mutation: { status: "done" as const },
  };
}

async function readPrecondition(db: Db, fixture: Pick<Fixture, "companyId" | "issueId">): Promise<Precondition> {
  const [issue] = await db.select({
    status: issues.status,
    assigneeAgentId: issues.assigneeAgentId,
    assigneeUserId: issues.assigneeUserId,
  }).from(issues).where(and(eq(issues.companyId, fixture.companyId), eq(issues.id, fixture.issueId)));
  if (!issue) throw new Error("fixture issue missing");
  const comments = await db.select({
    id: issueComments.id,
    createdAt: issueComments.createdAt,
    deletedAt: issueComments.deletedAt,
    deletedByType: issueComments.deletedByType,
    deletedByAgentId: issueComments.deletedByAgentId,
    deletedByUserId: issueComments.deletedByUserId,
    deletedByRunId: issueComments.deletedByRunId,
  }).from(issueComments).where(and(
    eq(issueComments.companyId, fixture.companyId),
    eq(issueComments.issueId, fixture.issueId),
  ));
  const activities = await db.select({ id: activityLog.id, createdAt: activityLog.createdAt })
    .from(activityLog).where(and(
      eq(activityLog.companyId, fixture.companyId),
      eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, fixture.issueId),
    ));
  const byCreatedAtThenId = (left: { createdAt: Date; id: string }, right: { createdAt: Date; id: string }) =>
    left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id);
  const latestComment = [...comments].sort(byCreatedAtThenId).at(-1);
  const latestActivity = [...activities].sort(byCreatedAtThenId).at(-1);
  return {
    issue,
    comments: {
      latest: latestComment ? { createdAt: latestComment.createdAt.toISOString(), id: latestComment.id } : null,
      countIncludingDeleted: comments.length,
      deletionDigest: sha256([...comments].sort((a, b) => a.id.localeCompare(b.id)).map((row) => [
        row.id,
        row.deletedAt?.toISOString() ?? "live",
        row.deletedByType ?? "none",
        row.deletedByAgentId ?? "none",
        row.deletedByUserId ?? "none",
        row.deletedByRunId ?? "none",
      ].join(":" )).join("\n")),
    },
    activity: {
      latest: latestActivity ? { createdAt: latestActivity.createdAt.toISOString(), id: latestActivity.id } : null,
      count: activities.length,
    },
  };
}

async function jsonRows(db: Db, query: ReturnType<typeof sql.raw>) {
  const rows = await db.execute<{ row: Record<string, unknown> }>(query);
  return rows.map((entry) => entry.row);
}

async function snapshot(db: Db, fixture: Pick<Fixture, "companyId" | "issueId">) {
  const quotedIssueId = `'${fixture.issueId.replaceAll("'", "''")}'`;
  const quotedCompanyId = `'${fixture.companyId.replaceAll("'", "''")}'`;
  const issue = await jsonRows(db, sql.raw(
    `select to_jsonb(t) row from issues t where id::text=${quotedIssueId} order by to_jsonb(t)::text`,
  ));
  const comments = await jsonRows(db, sql.raw(
    `select to_jsonb(t) row from issue_comments t where issue_id::text=${quotedIssueId} order by id`,
  ));
  const activities = await jsonRows(db, sql.raw(
    `select to_jsonb(t) row from activity_log t where company_id::text=${quotedCompanyId} and entity_type='issue' and entity_id=${quotedIssueId} order by created_at,id`,
  ));
  const wakes = await jsonRows(db, sql.raw(
    `select to_jsonb(t) row from agent_wakeup_requests t where company_id::text=${quotedCompanyId} order by created_at,id`,
  ));
  const runs = await jsonRows(db, sql.raw(
    `select to_jsonb(t) row from heartbeat_runs t where company_id::text=${quotedCompanyId} order by created_at,id`,
  ));
  // Test-owned harness machinery is out of scope for the unrelated-state
  // oracle: the gate seam tables are DDL fixtures created in beforeAll, and
  // the coupling seam tables (paperclip_activity_fence, paperclip_activity_pause)
  // are armed by the tests themselves AFTER the before-snapshot. None of them
  // is ever written by production code, so excluding them cannot hide a real
  // production mutation; every other public table carrying issue_id /
  // related_issue_id stays inside the oracle.
  const tables = await db.execute<{ tableName: string; hasRelatedIssueId: boolean }>(sql.raw(`
    select c.table_name "tableName",
      bool_or(c.column_name='related_issue_id') "hasRelatedIssueId"
    from information_schema.columns c
    where c.table_schema='public' and c.column_name in ('issue_id','related_issue_id')
      and c.table_name not in ('issue_comments','paperclip_test_issue_gate_config','paperclip_test_issue_gate_audit',
        'paperclip_activity_fence','paperclip_activity_pause')
    group by c.table_name order by c.table_name
  `));
  const related: Record<string, Record<string, unknown>[]> = {};
  for (const table of tables) {
    const safeTable = `"${table.tableName.replaceAll('"', '""')}"`;
    const predicate = table.hasRelatedIssueId
      ? `(issue_id::text=${quotedIssueId} or related_issue_id::text=${quotedIssueId})`
      : `issue_id::text=${quotedIssueId}`;
    related[table.tableName] = await jsonRows(db, sql.raw(
      `select to_jsonb(t) row from ${safeTable} t where ${predicate} order by to_jsonb(t)::text`,
    ));
  }
  return { issue, comments, activities, wakes, runs, related };
}

function refusalRows(value: Snapshot) {
  return value.activities.filter((row) => row.action === REFUSAL_ACTION);
}

function withoutRefusal(value: Snapshot): Snapshot {
  return { ...value, activities: value.activities.filter((row) => row.action !== REFUSAL_ACTION) };
}

function flattenStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(flattenStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(flattenStrings);
  return [];
}

function expectRefusalAudit(
  after: Snapshot,
  mismatches: MismatchId[],
  requested: Precondition,
  observed: Precondition,
) {
  const rows = refusalRows(after);
  expect(rows).toHaveLength(1);
  const details = rows[0]?.details;
  const expectedRequestDigest = evidenceDigest(requested);
  const expectedObservedDigest = evidenceDigest(observed);
  expect(details).toEqual({
    guard: REFUSAL_SCHEMA,
    operation: OPERATION_ID,
    mismatches,
    requestDigest: expectedRequestDigest,
    observedDigest: expectedObservedDigest,
  });
  // A request-level mismatch (e.g. targetCompanyId) refuses on the company/scope
  // check while the evidence precondition is unchanged, so requested and observed
  // evidence — and therefore their digests — are legitimately identical. Only an
  // evidence-level mismatch must produce independent digests. The branch predicate
  // is the same canonicalization the digests use, so it cannot pass vacuously.
  if (canonicalJson(requested) === canonicalJson(observed)) {
    expect(expectedRequestDigest, "unchanged evidence must yield identical request/observed digests").toBe(expectedObservedDigest);
    expect(details?.observedDigest, "unchanged evidence must make the audit digests agree").toBe(expectedRequestDigest);
  } else {
    expect(expectedRequestDigest).not.toBe(expectedObservedDigest);
    expect(details?.observedDigest).not.toBe(expectedRequestDigest);
  }
  expect(details?.requestDigest).not.toBe("0".repeat(64));
  expect(Object.keys((details ?? {}) as object).sort()).toEqual([
    "guard", "mismatches", "observedDigest", "operation", "requestDigest",
  ]);
  const serialized = JSON.stringify(details);
  for (const forbidden of [
    ORIGINAL_COMMENT_BODY,
    ORIGINAL_COMMENT_BODY.slice(0, 18),
    TIE_COMMENT_BODY,
    COMPETING_COMMENT_BODY,
    BODY_SHAPED_ARBITRARY,
    BODY_SHAPED_ARBITRARY.slice(0, 24),
  ]) expect(serialized).not.toContain(forbidden);
  for (const value of flattenStrings(details)) {
    expect(value.length, `unbounded refusal detail string: ${value}`).toBeLessThanOrEqual(128);
  }
}

function rowById(rows: Record<string, unknown>[], id: string) {
  return rows.find((row) => row.id === id);
}

function expectOnlyIssueColumnsChanged(before: Snapshot, after: Snapshot, allowed: string[]) {
  const left = before.issue[0] ?? {};
  const right = after.issue[0] ?? {};
  const changed = Object.keys({ ...left, ...right }).filter((key) => canonicalJson(left[key]) !== canonicalJson(right[key]));
  expect(changed.filter((key) => !allowed.includes(key)), `unexpected issue columns changed: ${changed.join(", ")}`).toEqual([]);
}

function expectUnrelatedStateUnchanged(before: Snapshot, after: Snapshot) {
  expect(after.runs).toEqual(before.runs);
  expect(after.related).toEqual(before.related);
}

async function waitUntil<T>(probe: () => Promise<T | null>, description: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== null) return value;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`bounded deadline expired waiting for ${description}`);
}

describePostgres("issue evidence-guarded mutation PostgreSQL boundary", () => {
  let db!: Db;
  let guardDb!: Db;
  let writerDb!: Db;
  let readerDb!: Db;
  let gateDb!: Db;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-issue-evidence-guard-");
    db = createDb(temporary.connectionString, { maxConnections: 4, applicationName: "guarded-evidence-control" });
    // The route-bearing pools need headroom: the comment routes run nested
    // `db.transaction(...)` scopes against the same client they also use for
    // outer-pool statements. On a single-connection pool the nested reserve
    // waits forever on its own outer transaction (the writer backend sits
    // "idle in transaction" after BEGIN) and the request deadlocks. Distinct
    // application_names keep the lock-scheduling queries below unambiguous.
    guardDb = createDb(temporary.connectionString, { maxConnections: 4, applicationName: GUARD_APP_NAME });
    writerDb = createDb(temporary.connectionString, { maxConnections: 4, applicationName: WRITER_APP_NAME });
    readerDb = createDb(temporary.connectionString, { maxConnections: 1, applicationName: READER_APP_NAME });
    gateDb = createDb(temporary.connectionString, { maxConnections: 1, applicationName: GATE_APP_NAME });
    await db.execute(sql.raw(`
      create extension if not exists pgrowlocks;
      create table paperclip_test_issue_gate_config (
        issue_id uuid primary key,
        gate_key bigint not null,
        armed boolean not null default true
      );
      create table paperclip_test_issue_gate_audit (
        sequence bigserial primary key,
        backend_pid integer not null,
        transaction_id text not null,
        table_name text not null,
        operation text not null,
        issue_id uuid not null,
        issue_lock_seen boolean not null
      );
      create or replace function paperclip_test_backend_owns_issue_lock(target_issue_id uuid)
      returns boolean language sql as $fn$
        select exists (
          select 1 from pgrowlocks('issues') locked
          join issues target on target.ctid=locked.locked_row
          where target.id=target_issue_id and pg_backend_pid()=any(locked.pids)
        ) or exists (
          select 1 from pg_locks held
          join pg_class relation on relation.oid=held.relation
          where held.pid=pg_backend_pid() and held.granted
            and held.locktype='tuple' and relation.relname='issues'
        )
      $fn$;
      create or replace function paperclip_test_issue_gate() returns trigger language plpgsql as $fn$
      declare
        target_issue_id uuid;
        configured_gate bigint;
        owns_issue_lock boolean;
      begin
        target_issue_id := case when tg_table_name='issues' then (to_jsonb(new)->>'id')::uuid else (to_jsonb(new)->>'issue_id')::uuid end;
        select gate_key into configured_gate from paperclip_test_issue_gate_config
          where issue_id=target_issue_id and armed;
        if configured_gate is null then return new; end if;
        select paperclip_test_backend_owns_issue_lock(target_issue_id) into owns_issue_lock;
        insert into paperclip_test_issue_gate_audit
          (backend_pid,transaction_id,table_name,operation,issue_id,issue_lock_seen)
          values (pg_backend_pid(),txid_current()::text,tg_table_name,tg_op,target_issue_id,owns_issue_lock);
        if owns_issue_lock and current_setting('application_name') in ('guarded-evidence-http','guarded-evidence-writer')
        then perform pg_advisory_xact_lock(configured_gate); end if;
        return new;
      end $fn$;
      create trigger paperclip_test_gate_issue_write before update on issues
        for each row execute function paperclip_test_issue_gate();
      create trigger paperclip_test_gate_comment_write before insert or update on issue_comments
        for each row execute function paperclip_test_issue_gate();
      create or replace function paperclip_test_activity_audit() returns trigger language plpgsql as $fn$
      begin
        if new.entity_type='issue' and new.entity_id ~ '^[0-9a-f-]{36}$'
          and exists (select 1 from paperclip_test_issue_gate_config where issue_id=new.entity_id::uuid)
        then
          insert into paperclip_test_issue_gate_audit
            (backend_pid,transaction_id,table_name,operation,issue_id,issue_lock_seen)
            select pg_backend_pid(),txid_current()::text,tg_table_name,tg_op,new.entity_id::uuid,
              paperclip_test_backend_owns_issue_lock(new.entity_id::uuid);
        end if;
        return new;
      end $fn$;
      create trigger paperclip_test_audit_issue_activity before insert on activity_log
        for each row execute function paperclip_test_activity_audit();
      -- Stage A coupling seam (test-owned, no source changes): a per-issue fence
      -- records txid_current() inside whichever transaction writes an
      -- issue_comments row, and a guard on activity_log raises only when the
      -- paired issue.comment_added / issue.comment_deleted activity row is
      -- inserted OUTSIDE that transaction (split world), and a POISON mode that
      -- raises on the paired action UNCONDITIONALLY — the failure inducer for
      -- the rollback regressions: it faults the activity write in the split
      -- world (today, raise lands post-commit, the paired row survives) AND in
      -- the single-transaction world (post-d1, raise lands in-tx, the whole
      -- transaction rolls back), so the tests can flip green with the repair.
      -- Inert for issues without an armed fence row, inert for every other
      -- action, so the pre-existing suites in this file are unaffected. The
      -- seam faults the table write itself, so it stays honest if d1 reroutes
      -- or renames the in-transaction activity path.
      create table paperclip_activity_fence (
        issue_id uuid primary key,
        armed boolean not null default true,
        poisoned boolean not null default false,
        fence_txid bigint
      );
      create or replace function paperclip_activity_fence_comment_write()
        returns trigger language plpgsql as $fn$
      begin
        update paperclip_activity_fence
          set fence_txid = txid_current()
          where issue_id = (to_jsonb(new) ->> 'issue_id')::uuid and armed;
        return new;
      end $fn$;
      create trigger paperclip_fence_issue_comment_write
        before insert or update on issue_comments
        for each row execute function paperclip_activity_fence_comment_write();
      create or replace function paperclip_activity_coupling_guard()
        returns trigger language plpgsql as $fn$
      declare
        v_poisoned boolean;
        v_fenced_txid bigint;
      begin
        if new.entity_type = 'issue'
          and new.entity_id ~ '^[0-9a-f-]{36}$'
          and new.action in ('issue.comment_added', 'issue.comment_deleted')
        then
          select poisoned, fence_txid into v_poisoned, v_fenced_txid
            from paperclip_activity_fence
            where issue_id = new.entity_id::uuid and armed;
          if found and v_poisoned then
            raise exception
              'poisoned activity write % on issue % fails unconditionally',
              new.action, new.entity_id;
          elsif found and v_fenced_txid is not null and v_fenced_txid <> txid_current() then
            raise exception
              'activity write % on issue % is not in the comment transaction: fence txid %, current txid %',
              new.action, new.entity_id, v_fenced_txid, txid_current();
          end if;
        end if;
        return new;
      end $fn$;
      create trigger paperclip_guard_activity_write
        before insert on activity_log
        for each row execute function paperclip_activity_coupling_guard();
      -- Visibility-ordering seam: for issues with an armed pause row, the
      -- paired comment-activity insert pauses on an advisory lock the test
      -- holds, so the observing connection can read committed state at the
      -- exact moment the paired write is pending. Statement-scoped: the
      -- routes' pre-activity reads never touch this trigger.
      create table paperclip_activity_pause (
        issue_id uuid primary key
      );
      create or replace function paperclip_pause_activity_insert()
        returns trigger language plpgsql as $fn$
      begin
        if new.entity_type = 'issue'
          and new.entity_id ~ '^[0-9a-f-]{36}$'
          and new.action in ('issue.comment_added', 'issue.comment_deleted')
          and exists (select 1 from paperclip_activity_pause where issue_id = new.entity_id::uuid)
        then
          perform pg_advisory_xact_lock(${PAUSE_LOCK_KEY});
        end if;
        return new;
      end $fn$;
      create trigger paperclip_pause_activity_write
        before insert on activity_log
        for each row execute function paperclip_pause_activity_insert();
    `));
  }, 30_000);

  afterEach(async () => {
    // Disarm pause rows BEFORE releasing the advisory lock: a fire-and-forget
    // writer resumed by the unlock must find no pause row and cannot race the
    // table cleanup below.
    await db.execute(sql.raw("delete from paperclip_activity_pause"));
    await gateDb.execute(sql`select pg_advisory_unlock_all()`).catch(() => undefined);
    const cleanups = [
      () => db.execute(sql.raw("delete from paperclip_test_issue_gate_config")),
      () => db.execute(sql.raw("delete from paperclip_activity_fence")),
      () => db.execute(sql.raw("delete from paperclip_test_issue_gate_audit")),
      () => db.delete(activityLog),
      () => db.delete(heartbeatRuns),
      () => db.delete(agentWakeupRequests),
      () => db.delete(issueComments),
      () => db.delete(issues),
      () => db.delete(companyMemberships),
      () => db.delete(agents),
      () => db.delete(companies),
    ];
    for (const cleanup of cleanups) await cleanup().catch(() => undefined);
  });

  afterAll(async () => {
    await gateDb?.execute(sql`select pg_advisory_unlock_all()`).catch(() => undefined);
    await gateDb?.$client.end({ timeout: 1 });
    await guardDb?.$client.end({ timeout: 1 });
    await writerDb?.$client.end({ timeout: 1 });
    await readerDb?.$client.end({ timeout: 1 });
    await db?.$client.end({ timeout: 1 });
    await temporary?.cleanup();
  });

  async function seed(): Promise<Fixture> {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const issueId = randomUUID();
    const assigneeAgentId = randomUUID();
    const otherAgentId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "Guarded company", issuePrefix: `G${companyId.slice(0, 5)}`, requireBoardApprovalForNewAgents: false },
      { id: otherCompanyId, name: "Other company", issuePrefix: `O${otherCompanyId.slice(0, 5)}`, requireBoardApprovalForNewAgents: false },
    ]);
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: BOARD_USER_ID, status: "active", membershipRole: "owner" },
      { companyId, principalType: "user", principalId: COMPETING_USER_ID, status: "active", membershipRole: "member" },
      { companyId: otherCompanyId, principalType: "user", principalId: BOARD_USER_ID, status: "active", membershipRole: "owner" },
    ]);
    await db.insert(agents).values([
      { id: assigneeAgentId, companyId, name: "Initial assignee", role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: otherAgentId, companyId, name: "Competing assignee", role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Guard this exact issue",
      description: "description remains unchanged",
      status: "todo",
      priority: "medium",
      assigneeAgentId,
      assigneeUserId: null,
      createdByUserId: BOARD_USER_ID,
      createdAt: BASE_TIME,
      updatedAt: BASE_TIME,
    });
    await db.insert(issueComments).values([
      { id: COMMENT_LOW_ID, companyId, issueId, authorUserId: BOARD_USER_ID, authorType: "user", body: ORIGINAL_COMMENT_BODY, createdAt: BASE_TIME, updatedAt: BASE_TIME },
      { id: COMMENT_HIGH_ID, companyId, issueId, authorUserId: BOARD_USER_ID, authorType: "user", body: TIE_COMMENT_BODY, createdAt: BASE_TIME, updatedAt: BASE_TIME },
    ]);
    await db.insert(activityLog).values([
      { id: ACTIVITY_LOW_ID, companyId, actorType: "user", actorId: BOARD_USER_ID, action: "issue.fixture_created", entityType: "issue", entityId: issueId, createdAt: BASE_TIME },
      { id: ACTIVITY_HIGH_ID, companyId, actorType: "user", actorId: BOARD_USER_ID, action: "issue.fixture_tie", entityType: "issue", entityId: issueId, createdAt: BASE_TIME },
    ]);
    return {
      companyId,
      otherCompanyId,
      issueId,
      assigneeAgentId,
      otherAgentId,
      deletedCommentId: COMMENT_LOW_ID,
      commentClientRequestId: randomUUID(),
      guardApp: appFor(guardDb, boardActor(companyId)),
      anonymousApp: appFor(guardDb),
      otherCompanyApp: appFor(guardDb, boardActor(otherCompanyId)),
    };
  }

  const writers: Writer[] = [
    {
      name: "comment insert",
      firstTable: "issue_comments",
      expectedMismatchIds: ["comments.latest.createdAt", "comments.latest.id", "comments.countIncludingDeleted", "activity.latest.createdAt", "activity.latest.id", "activity.count"],
      run: (fixture) => request(appFor(writerDb, boardActor(fixture.companyId)))
        .post(`/api/issues/${fixture.issueId}/comments`)
        .send({ body: COMPETING_COMMENT_BODY, clientRequestId: fixture.commentClientRequestId }),
      assertSuccess: (response) => {
        expect(response.status, JSON.stringify(response.body)).toBe(201);
        expect(response.body).toMatchObject({ body: COMPETING_COMMENT_BODY, authorUserId: BOARD_USER_ID });
      },
      assertEffect: (before, after) => {
        expect(after.comments).toHaveLength(before.comments.length + 1);
        expect(after.comments.filter((row) => row.body === COMPETING_COMMENT_BODY)).toHaveLength(1);
        expectOnlyIssueColumnsChanged(before, after, ["updated_at"]);
        expect(after.activities.slice(before.activities.length).map((row) => row.action)).toEqual(["issue.comment_added"]);
        expectUnrelatedStateUnchanged(before, after);
      },
    },
    {
      name: "comment deletion",
      firstTable: "issue_comments",
      expectedMismatchIds: ["comments.deletionDigest", "activity.latest.createdAt", "activity.latest.id", "activity.count"],
      run: (fixture) => request(appFor(writerDb, boardActor(fixture.companyId)))
        .delete(`/api/issues/${fixture.issueId}/comments/${fixture.deletedCommentId}`),
      assertSuccess: (response) => {
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        expect(response.body).toMatchObject({ id: COMMENT_LOW_ID, body: "", deletedByType: "user", deletedByUserId: BOARD_USER_ID });
      },
      assertEffect: (before, after, fixture) => {
        expect(after.comments).toHaveLength(before.comments.length);
        expect(rowById(after.comments, fixture.deletedCommentId)).toMatchObject({ body: "", deleted_by_type: "user", deleted_by_user_id: BOARD_USER_ID });
        expectOnlyIssueColumnsChanged(before, after, ["updated_at"]);
        expect(after.activities.slice(before.activities.length).map((row) => row.action)).toEqual(["issue.comment_deleted"]);
        expect(after.wakes).toEqual(before.wakes);
        expectUnrelatedStateUnchanged(before, after);
      },
    },
    {
      name: "status update",
      firstTable: "issues",
      expectedMismatchIds: ["issue.status", "activity.latest.createdAt", "activity.latest.id", "activity.count"],
      run: (fixture) => request(appFor(writerDb, boardActor(fixture.companyId)))
        .patch(`/api/issues/${fixture.issueId}`).send({ status: "in_progress" }),
      assertSuccess: (response) => {
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        expect(response.body).toMatchObject({ status: "in_progress" });
      },
      assertEffect: (before, after) => {
        expect(after.issue[0]).toMatchObject({ status: "in_progress" });
        expectOnlyIssueColumnsChanged(before, after, ["status", "status_version", "started_at", "updated_at"]);
        expect(after.comments).toEqual(before.comments);
        expect(after.activities.slice(before.activities.length).map((row) => row.action)).toEqual(["issue.updated"]);
        expectUnrelatedStateUnchanged(before, after);
      },
    },
    {
      name: "agent assignment update",
      firstTable: "issues",
      expectedMismatchIds: ["issue.assigneeAgentId", "activity.latest.createdAt", "activity.latest.id", "activity.count"],
      run: (fixture) => request(appFor(writerDb, boardActor(fixture.companyId)))
        .patch(`/api/issues/${fixture.issueId}`).send({ assigneeAgentId: fixture.otherAgentId, assigneeUserId: null }),
      assertSuccess: (response, fixture) => {
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        expect(response.body).toMatchObject({ assigneeAgentId: fixture.otherAgentId, assigneeUserId: null });
      },
      assertEffect: (before, after, fixture) => {
        expect(after.issue[0]).toMatchObject({ assignee_agent_id: fixture.otherAgentId, assignee_user_id: null });
        expectOnlyIssueColumnsChanged(before, after, ["assignee_agent_id", "status_version", "updated_at"]);
        expect(after.comments).toEqual(before.comments);
        expect(after.activities.slice(before.activities.length).map((row) => row.action)).toEqual(["issue.updated"]);
        expectUnrelatedStateUnchanged(before, after);
      },
    },
    {
      name: "user assignment update",
      firstTable: "issues",
      expectedMismatchIds: ["issue.assigneeAgentId", "issue.assigneeUserId", "activity.latest.createdAt", "activity.latest.id", "activity.count"],
      run: (fixture) => request(appFor(writerDb, boardActor(fixture.companyId)))
        .patch(`/api/issues/${fixture.issueId}`).send({ assigneeAgentId: null, assigneeUserId: COMPETING_USER_ID }),
      assertSuccess: (response) => {
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        expect(response.body).toMatchObject({ assigneeAgentId: null, assigneeUserId: COMPETING_USER_ID });
      },
      assertEffect: (before, after) => {
        expect(after.issue[0]).toMatchObject({ assignee_agent_id: null, assignee_user_id: COMPETING_USER_ID });
        expectOnlyIssueColumnsChanged(before, after, ["assignee_agent_id", "assignee_user_id", "status_version", "updated_at"]);
        expect(after.comments).toEqual(before.comments);
        expect(after.activities.slice(before.activities.length).map((row) => row.action)).toEqual(["issue.updated"]);
        expectUnrelatedStateUnchanged(before, after);
      },
    },
  ];

  async function armGate(fixture: Fixture) {
    await db.execute(sql`insert into paperclip_test_issue_gate_config(issue_id,gate_key) values (${fixture.issueId}::uuid,${GATE_LOCK_KEY})`);
    await gateDb.execute(sql`select pg_advisory_lock(${GATE_LOCK_KEY})`);
  }

  async function releaseGate() {
    await gateDb.execute(sql`select pg_advisory_unlock(${GATE_LOCK_KEY})`);
  }

  async function audit(fixture: Fixture): Promise<AuditRow[]> {
    return db.execute<AuditRow>(sql`
      select backend_pid "backendPid",transaction_id "transactionId",table_name "tableName",
        operation,issue_id::text "issueId",issue_lock_seen "issueLockSeen"
      from paperclip_test_issue_gate_audit where issue_id=${fixture.issueId}::uuid order by sequence
    `);
  }

  async function waitForGateOrCompletion(
    fixture: Fixture,
    applicationName: string,
    settled: () => boolean,
  ): Promise<{ kind: "paused"; pid: number } | { kind: "settled"; audit: AuditRow[] }> {
    return waitUntil(async () => {
      const [state] = await db.execute<{ pid: number; waiting: boolean; gateHolder: boolean }>(sql`
        select target.pid,
          target.wait_event_type='Lock' as waiting,
          ${sql.raw(`coalesce(gate.pid = any(pg_blocking_pids(target.pid)),false)`)} as "gateHolder"
        from pg_stat_activity target
        left join pg_stat_activity gate on gate.application_name=${GATE_APP_NAME}
        where target.application_name=${applicationName} and target.state='active'
        limit 1
      `);
      if (state?.waiting && state.gateHolder) return { kind: "paused" as const, pid: state.pid };
      if (settled()) return { kind: "settled" as const, audit: await audit(fixture) };
      return null;
    }, `${applicationName} to reach the test gate or settle`);
  }

  async function expectQueuedOnIssueLock(applicationName: string, holderPid: number, settled: () => boolean) {
    return waitUntil(async () => {
      const [state] = await db.execute<{ pid: number; holderBlocks: boolean; transactionLock: boolean }>(sql`
        select waiter.pid,
          ${holderPid}=any(pg_blocking_pids(waiter.pid)) as "holderBlocks",
          exists (
            select 1 from pg_locks waiting join pg_locks held
              on held.locktype='transactionid' and waiting.locktype='transactionid'
              and held.transactionid=waiting.transactionid
            where waiting.pid=waiter.pid and not waiting.granted
              and held.pid=${holderPid} and held.granted
          ) as "transactionLock"
        from pg_stat_activity waiter
        where waiter.application_name=${applicationName} and waiter.state='active'
        limit 1
      `);
      if (state?.holderBlocks && state.transactionLock) return state;
      if (settled()) throw new Error(`${applicationName} completed instead of queuing on the shared issue row lock`);
      return null;
    }, `${applicationName} to queue on the exact holder transaction`);
  }

  async function expectTransactionScope(fixture: Fixture, firstTable: Writer["firstTable"], applicationName: string) {
    const rows = (await audit(fixture)).filter((row) => row.tableName === firstTable || row.tableName === "activity_log");
    const firstWrite = rows.find((row) => row.tableName === firstTable);
    const writerActivity = rows.find((row) => row.tableName === "activity_log" && row.backendPid === firstWrite?.backendPid)
      ?? rows.find((row) => row.tableName === "activity_log");
    expect(firstWrite?.issueLockSeen, `${applicationName} did not own the issue lock before its first relevant write`).toBe(true);
    expect(writerActivity, `${applicationName} did not insert associated activity`).toBeDefined();
    expect(writerActivity?.transactionId, `${applicationName} released the issue lock before associated activity`).toBe(firstWrite?.transactionId);
    expect(writerActivity?.issueLockSeen, `${applicationName} did not retain the issue lock through associated activity`).toBe(true);
  }

  async function overlap(fixture: Fixture, writer: Writer, order: "competing-write-first" | "mutation-first") {
    const requested = await readPrecondition(db, fixture);
    const before = await snapshot(db, fixture);
    await armGate(fixture);
    let writerSettled = false;
    let guardSettled = false;
    let writerPromise: Promise<Response> | undefined;
    let guardPromise: Promise<Response> | undefined;
    let released = false;
    const startWriter = () => {
      writerPromise = writer.run(fixture).then((response) => { writerSettled = true; return response; });
      return writerPromise;
    };
    const startGuard = () => {
      guardPromise = request(fixture.guardApp).post(endpoint(fixture))
        .send(guardedRequest(fixture, requested))
        .then((response) => { guardSettled = true; return response; });
      return guardPromise;
    };
    try {
      if (order === "competing-write-first") {
        startWriter();
        const first = await waitForGateOrCompletion(fixture, WRITER_APP_NAME, () => writerSettled);
        expect(first.kind, JSON.stringify(first)).toBe("paused");
        if (first.kind === "paused") {
          startGuard();
          const guardBoundary = await waitForGateOrCompletion(fixture, GUARD_APP_NAME, () => guardSettled);
          if (guardBoundary.kind === "paused") {
            throw new Error("guarded mutation reached its write gate instead of queuing on the competing issue lock");
          }
          // The pre-d1 endpoint returns 404 here. Once d1 exists, it must instead
          // remain queued on the exact writer transaction until the gate releases.
          if (!guardSettled) await expectQueuedOnIssueLock(GUARD_APP_NAME, first.pid, () => guardSettled);
        }
      } else {
        startGuard();
        const first = await waitForGateOrCompletion(fixture, GUARD_APP_NAME, () => guardSettled);
        if (first.kind === "paused") {
          startWriter();
          await expectQueuedOnIssueLock(WRITER_APP_NAME, first.pid, () => writerSettled);
        } else {
          // Missing endpoint is the expected test-first product failure. Release
          // the distinct gate before proving the real writer still runs cleanly.
          await releaseGate();
          released = true;
          startWriter();
        }
      }
    } finally {
      if (!released) await releaseGate();
    }
    const [writerResult, guardResult] = await Promise.allSettled([
      writerPromise ?? startWriter(),
      guardPromise ?? startGuard(),
    ]);
    if (writerResult.status === "rejected") throw writerResult.reason;
    if (guardResult.status === "rejected") throw guardResult.reason;
    return { before, requested, writerResponse: writerResult.value, guardResponse: guardResult.value };
  }

  it.each(writers)("proves the real $name route works before using it as a competitor", async (writer) => {
    const fixture = await seed();
    const before = await snapshot(db, fixture);
    const response = await writer.run(fixture);
    writer.assertSuccess(response, fixture);
    const after = await snapshot(db, fixture);
    writer.assertEffect(before, after, fixture);
  });

  it("uses the equal-createdAt ID tie-break and accepts a fresh request; exact retry is side-effect idempotent", async () => {
    const fixture = await seed();
    const precondition = await readPrecondition(db, fixture);
    expect(precondition.comments.latest).toEqual({ createdAt: BASE_TIME.toISOString(), id: COMMENT_HIGH_ID });
    expect(precondition.activity.latest).toEqual({ createdAt: BASE_TIME.toISOString(), id: ACTIVITY_HIGH_ID });
    const payload = guardedRequest(fixture, precondition);
    expect(payload).toEqual({ targetCompanyId: fixture.companyId, precondition, mutation: { status: "done" } });
    expect(JSON.stringify(payload)).not.toContain("commentBody");
    expect(JSON.stringify(payload)).not.toContain(ORIGINAL_COMMENT_BODY);

    const first = await request(fixture.guardApp).post(endpoint(fixture)).send(payload);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ operation: OPERATION_ID, issue: { id: fixture.issueId, companyId: fixture.companyId, status: "done" } });
    const afterFirst = await snapshot(db, fixture);
    expect(afterFirst.issue[0]).toMatchObject({ status: "done" });
    expect(afterFirst.comments).toHaveLength(2);
    expect(afterFirst.activities.slice(2).map((row) => row.action)).toEqual(["issue.updated"]);

    const retry = await request(fixture.guardApp).post(endpoint(fixture)).send(payload);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body).toMatchObject({ operation: OPERATION_ID, idempotentReplay: true });
    expect(await snapshot(db, fixture)).toEqual(afterFirst);
  });

  it("requires authentication and target-company scope before reading evidence", async () => {
    const fixture = await seed();
    const before = await snapshot(db, fixture);
    const payload = guardedRequest(fixture, await readPrecondition(db, fixture));
    const anonymous = await request(fixture.anonymousApp).post(endpoint(fixture)).send(payload);
    expect(anonymous.status).toBe(401);
    const wrongScope = await request(fixture.otherCompanyApp).post(endpoint(fixture)).send(payload);
    expect(wrongScope.status).toBe(403);
    const mismatchedTarget = await request(fixture.guardApp).post(endpoint(fixture)).send({ ...payload, targetCompanyId: fixture.otherCompanyId });
    expect(mismatchedTarget.status).toBe(403);
    expect(await snapshot(db, fixture)).toEqual(before);
  });

  it("answers a foreign-company issue with the exact missing-issue 404 body, no refusal audit, and zero writes", async () => {
    const fixture = await seed();
    // seed() provisions the second company + owner membership but no issue in
    // it, so the foreign (company B) target is created in-test.
    const foreignIssueId = randomUUID();
    await db.insert(issues).values({
      id: foreignIssueId,
      companyId: fixture.otherCompanyId,
      title: "Foreign company issue",
      description: "company B's issue must be invisible to company A's guarded mutation",
      status: "todo",
      priority: "medium",
      assigneeAgentId: null,
      assigneeUserId: null,
      createdByUserId: BOARD_USER_ID,
      createdAt: BASE_TIME,
      updatedAt: BASE_TIME,
    });
    const foreign = { companyId: fixture.otherCompanyId, issueId: foreignIssueId };
    const beforeCompanyA = await snapshot(db, fixture);
    const beforeForeign = await snapshot(db, foreign);
    // Company A actor, company A targetCompanyId, company B issue id: the
    // target-company scope check passes, so only the issue's OWN company can
    // betray the cross-tenant attempt.
    const payload = guardedRequest(fixture, await readPrecondition(db, fixture));
    expect(payload.targetCompanyId).toBe(fixture.companyId);

    const foreignResponse = await request(fixture.guardApp)
      .post(`/api/issues/${foreignIssueId}/evidence-guarded-mutations`)
      .send(payload);
    expect(foreignResponse.status, JSON.stringify(foreignResponse.body)).toBe(404);
    expect(foreignResponse.body, "a foreign-existing issue must be indistinguishable from a missing one")
      .toEqual({ error: "Issue not found" });
    // Existence parity: a truly missing issue id answers with the identical
    // status and body, so the foreign id leaks no existence oracle.
    const missingResponse = await request(fixture.guardApp)
      .post(`/api/issues/${randomUUID()}/evidence-guarded-mutations`)
      .send(payload);
    expect(missingResponse.status, JSON.stringify(missingResponse.body)).toBe(404);
    expect(missingResponse.body).toEqual(foreignResponse.body);

    // Decisive cross-tenant-write guard: zero new activity rows for BOTH
    // companies' issues — no refusal audit anywhere — and both issue rows
    // unchanged (the foreign issue keeps "todo").
    const afterCompanyA = await snapshot(db, fixture);
    const afterForeign = await snapshot(db, foreign);
    expect(refusalRows(afterCompanyA), "no refusal audit row in company A's log").toHaveLength(0);
    expect(refusalRows(afterForeign), "no refusal audit row in company B's log").toHaveLength(0);
    expect(afterCompanyA).toEqual(beforeCompanyA);
    expect(afterForeign).toEqual(beforeForeign);
    expect(afterForeign.issue[0]).toMatchObject({ status: "todo" });
  });

  it.each([
    ["missing precondition", (payload: Record<string, unknown>) => ({ targetCompanyId: payload.targetCompanyId, mutation: payload.mutation })],
    ["non-done status", (payload: any) => ({ ...payload, mutation: { status: "in_review" } })],
    ["extra mutation field", (payload: any) => ({ ...payload, mutation: { status: "done", title: "forbidden" } })],
    ["comment body", (payload: any) => ({ ...payload, mutation: { status: "done", commentBody: BODY_SHAPED_ARBITRARY } })],
  ])("rejects malformed or forbidden mutation without audit or side effects: %s", async (_label, mutate) => {
    const fixture = await seed();
    const before = await snapshot(db, fixture);
    const payload = mutate(guardedRequest(fixture, await readPrecondition(db, fixture)) as any);
    const response = await request(fixture.guardApp).post(endpoint(fixture)).send(payload);
    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body).toEqual({ error: { code: "invalid_issue_evidence_guard", message: expect.any(String) } });
    expect(await snapshot(db, fixture)).toEqual(before);
  });

  const mismatchCases: Array<[MismatchId, (precondition: Precondition, fixture: Fixture) => { targetCompanyId?: string; precondition: Precondition }]> = [
    ["targetCompanyId", (precondition) => ({ targetCompanyId: randomUUID(), precondition })],
    ["issue.status", (precondition) => ({ precondition: { ...precondition, issue: { ...precondition.issue, status: "in_progress" } } })],
    ["issue.assigneeAgentId", (precondition, fixture) => ({ precondition: { ...precondition, issue: { ...precondition.issue, assigneeAgentId: fixture.otherAgentId } } })],
    ["issue.assigneeUserId", (precondition) => ({ precondition: { ...precondition, issue: { ...precondition.issue, assigneeUserId: BODY_SHAPED_ARBITRARY } } })],
    ["comments.latest.createdAt", (precondition) => ({ precondition: { ...precondition, comments: { ...precondition.comments, latest: { ...precondition.comments.latest!, createdAt: new Date(BASE_TIME.getTime() - 1).toISOString() } } } })],
    ["comments.latest.id", (precondition) => ({ precondition: { ...precondition, comments: { ...precondition.comments, latest: { ...precondition.comments.latest!, id: COMMENT_LOW_ID } } } })],
    ["comments.countIncludingDeleted", (precondition) => ({ precondition: { ...precondition, comments: { ...precondition.comments, countIncludingDeleted: precondition.comments.countIncludingDeleted + 1 } } })],
    ["comments.deletionDigest", (precondition) => ({ precondition: { ...precondition, comments: { ...precondition.comments, deletionDigest: sha256("different deletion state") } } })],
    ["activity.latest.createdAt", (precondition) => ({ precondition: { ...precondition, activity: { ...precondition.activity, latest: { ...precondition.activity.latest!, createdAt: new Date(BASE_TIME.getTime() - 1).toISOString() } } } })],
    ["activity.latest.id", (precondition) => ({ precondition: { ...precondition, activity: { ...precondition.activity, latest: { ...precondition.activity.latest!, id: ACTIVITY_LOW_ID } } } })],
    ["activity.count", (precondition) => ({ precondition: { ...precondition, activity: { ...precondition.activity, count: precondition.activity.count + 1 } } })],
  ];

  it.each(mismatchCases)("returns a typed 409 for only %s, exact independent digests, and one bounded body-free audit", async (mismatch, mutate) => {
    const fixture = await seed();
    const before = await snapshot(db, fixture);
    const observed = await readPrecondition(db, fixture);
    const changed = mutate(observed, fixture);
    const requested = changed.precondition;
    const response = await request(fixture.guardApp).post(endpoint(fixture)).send({
      targetCompanyId: changed.targetCompanyId ?? fixture.companyId,
      precondition: requested,
      mutation: { status: "done" },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body).toEqual({
      error: { code: "issue_evidence_conflict", message: "Issue evidence changed", mismatches: [mismatch] },
    });
    const after = await snapshot(db, fixture);
    expect(withoutRefusal(after)).toEqual(before);
    expectRefusalAudit(after, [mismatch], requested, observed);
  });

  it.each(writers)("competing-write-first: $name holds one shared issue lock through activity; stale guarded mutation refuses", async (writer) => {
    const fixture = await seed();
    const result = await overlap(fixture, writer, "competing-write-first");
    writer.assertSuccess(result.writerResponse, fixture);
    expect(result.guardResponse.status, JSON.stringify(result.guardResponse.body)).toBe(409);
    // The 409 flushes at the probe while the refusal-audit transaction commits
    // afterwards by design: the audit row deliberately observes post-writer-commit
    // state, so the response can never trail its own audit commit. waitUntil closes
    // ONLY that commit-arrival race — the refusal row stays REQUIRED below (exact
    // length, exact digests, bounded body-free audit), and the wait does not depend
    // on writer speed: all five writer classes share this single assertion site.
    const after = await waitUntil(async () => {
      const snap = await snapshot(db, fixture);
      return refusalRows(snap).length ? snap : null;
    }, "guard refusal audit commit");
    const afterWriter = withoutRefusal(after);
    writer.assertEffect(result.before, afterWriter, fixture);
    expect(afterWriter.issue[0]?.status).not.toBe("done");
    const observed = await readPrecondition(db, fixture);
    expectRefusalAudit(after, writer.expectedMismatchIds, result.requested, observed);
    await expectTransactionScope(fixture, writer.firstTable, WRITER_APP_NAME);
  });

  it.each(writers)("mutation-first: guarded success holds the same lock through activity, then $name preserves normal semantics", async (writer) => {
    const fixture = await seed();
    const result = await overlap(fixture, writer, "mutation-first");
    expect(result.guardResponse.status, JSON.stringify(result.guardResponse.body)).toBe(200);
    writer.assertSuccess(result.writerResponse, fixture);
    const after = await snapshot(db, fixture);
    expect(after.issue[0]?.status).toBe("done");
    expect(refusalRows(after)).toHaveLength(0);
    await expectTransactionScope(fixture, "issues", GUARD_APP_NAME);
    await expectTransactionScope(fixture, writer.firstTable, WRITER_APP_NAME);
  });

  // ---------------------------------------------------------------------------
  // Stage A writer-boundary regression (board ruling 58d9a991): a comment row
  // and its issue-scoped activity row must commit in ONE transaction.
  // Intended behavior change under test (the R3 coupling, stated in-test): an
  // activity-write failure rolls the paired comment row back too, and no
  // concurrent reader may ever observe one row without the other. The fault
  // seam is test-owned Postgres DDL (paperclip_activity_fence + triggers), so
  // the RED below is the split transaction itself — never endpoint absence,
  // and never a status code.
  // ---------------------------------------------------------------------------

  async function armCouplingGuard(issueId: string) {
    await db.execute(sql`insert into paperclip_activity_fence(issue_id, armed) values (${issueId}::uuid, true)`);
  }

  // Failure inducer that works in BOTH worlds: the poisoned trigger raises on
  // the paired activity write regardless of which transaction it runs in.
  // Split world (today): raise lands post-commit, the paired row survives.
  // Single-transaction world (post-d1): raise lands in-tx, the transaction
  // rolls back, and the paired row is gone — the stated behavior change.
  async function armCouplingPoison(issueId: string) {
    await db.execute(sql`insert into paperclip_activity_fence(issue_id, armed, poisoned) values (${issueId}::uuid, true, true)`);
  }

  async function disarmCouplingGuard(issueId: string) {
    await db.execute(sql`delete from paperclip_activity_fence where issue_id=${issueId}::uuid`);
  }

  function expectCauseChainMatches(error: unknown, pattern: RegExp) {
    let current: unknown = error;
    const chain: string[] = [];
    while (current instanceof Error) {
      chain.push(current.message);
      if (pattern.test(current.message)) return;
      current = (current as { cause?: unknown }).cause;
    }
    throw new Error(
      `expected an error whose cause chain matches ${String(pattern)}; chain: ${chain.join(" || ")}`,
    );
  }

  it("seam probe: the coupling guard passes co-transactional comment+activity writes", async () => {
    const fixture = await seed();
    await armCouplingGuard(fixture.issueId);
    await db.transaction(async (tx) => {
      await tx.insert(issueComments).values({
        id: randomUUID(), companyId: fixture.companyId, issueId: fixture.issueId,
        authorUserId: BOARD_USER_ID, authorType: "user", body: "co-transactional control comment",
        createdAt: BASE_TIME, updatedAt: BASE_TIME,
      });
      await tx.insert(activityLog).values({
        companyId: fixture.companyId, actorType: "user", actorId: BOARD_USER_ID,
        action: "issue.comment_added", entityType: "issue", entityId: fixture.issueId,
      });
    });
    const [counts] = await db.execute<{ commentRows: number; activityRows: number }>(sql`
      select
        (select count(*)::int from issue_comments where issue_id=${fixture.issueId}::uuid) as "commentRows",
        (select count(*)::int from activity_log where entity_type='issue' and entity_id=${fixture.issueId} and action='issue.comment_added') as "activityRows"`);
    expect(counts?.commentRows, "co-transactional writes must pass the coupling guard and commit").toBe(3);
    expect(counts?.activityRows).toBe(1);
  });

  it("seam probe: the coupling guard detects a direct split comment+activity write", async () => {
    const fixture = await seed();
    await armCouplingGuard(fixture.issueId);
    await db.insert(issueComments).values({
      id: randomUUID(), companyId: fixture.companyId, issueId: fixture.issueId,
      authorUserId: BOARD_USER_ID, authorType: "user", body: "split probe comment",
      createdAt: BASE_TIME, updatedAt: BASE_TIME,
    });
    let probeError: unknown;
    try {
      await db.insert(activityLog).values({
        companyId: fixture.companyId, actorType: "user", actorId: BOARD_USER_ID,
        action: "issue.comment_added", entityType: "issue", entityId: fixture.issueId,
      });
    } catch (error) {
      probeError = error;
    }
    expectCauseChainMatches(probeError, /not in the comment transaction/);
    const [counts] = await db.execute<{ commentRows: number; activityRows: number }>(sql`
      select
        (select count(*)::int from issue_comments where issue_id=${fixture.issueId}::uuid) as "commentRows",
        (select count(*)::int from activity_log where entity_type='issue' and entity_id=${fixture.issueId} and action='issue.comment_added') as "activityRows"`);
    expect(counts?.commentRows).toBe(3);
    expect(counts?.activityRows, "the split write's activity row must not exist").toBe(0);
  });

  it("seam probe: poison faults the paired activity write in both worlds", async () => {
    const fixture = await seed();
    await armCouplingPoison(fixture.issueId);
    // Coupled world (post-d1 shape): the raise lands inside the transaction
    // and rolls the paired comment write back.
    let coTxError: unknown;
    try {
      await db.transaction(async (tx) => {
        await tx.insert(issueComments).values({
          id: randomUUID(), companyId: fixture.companyId, issueId: fixture.issueId,
          authorUserId: BOARD_USER_ID, authorType: "user", body: "poison co-tx comment",
          createdAt: BASE_TIME, updatedAt: BASE_TIME,
        });
        await tx.insert(activityLog).values({
          companyId: fixture.companyId, actorType: "user", actorId: BOARD_USER_ID,
          action: "issue.comment_added", entityType: "issue", entityId: fixture.issueId,
        });
      });
    } catch (error) {
      coTxError = error;
    }
    expectCauseChainMatches(coTxError, /fails unconditionally/);
    const [coTxCounts] = await db.execute<{ commentRows: number }>(sql`
      select count(*)::int as "commentRows" from issue_comments
        where issue_id=${fixture.issueId}::uuid and body='poison co-tx comment'`);
    expect(coTxCounts?.commentRows, "the in-transaction raise must roll the paired comment write back").toBe(0);
    // Split world (today's route shape): the raise lands post-commit, the
    // paired comment write survives.
    await db.insert(issueComments).values({
      id: randomUUID(), companyId: fixture.companyId, issueId: fixture.issueId,
      authorUserId: BOARD_USER_ID, authorType: "user", body: "poison split comment",
      createdAt: BASE_TIME, updatedAt: BASE_TIME,
    });
    let splitError: unknown;
    try {
      await db.insert(activityLog).values({
        companyId: fixture.companyId, actorType: "user", actorId: BOARD_USER_ID,
        action: "issue.comment_added", entityType: "issue", entityId: fixture.issueId,
      });
    } catch (error) {
      splitError = error;
    }
    expectCauseChainMatches(splitError, /fails unconditionally/);
    const [splitCounts] = await db.execute<{ commentRows: number }>(sql`
      select count(*)::int as "commentRows" from issue_comments
        where issue_id=${fixture.issueId}::uuid and body='poison split comment'`);
    expect(splitCounts?.commentRows, "the post-commit raise must leave the paired comment write in place").toBe(1);
  });

  it("comment-add atomic coupling: forcing the paired activity write to fail rolls the comment row back", async () => {
    const fixture = await seed();
    const commentBody = "atomic coupling comment";
    const clientRequestId = randomUUID();
    const before = await snapshot(db, fixture);
    // Poisoned seam: the activity write fails unconditionally — post-commit in
    // the split world (today: the comment tx already committed, so the paired
    // row survives and this test is RED), in-transaction in the coupled world
    // (post-d1: the raise aborts the whole transaction, the paired row rolls
    // back, and this test goes GREEN). The oracle is the paired row's fate.
    await armCouplingPoison(fixture.issueId);
    const response = await request(appFor(writerDb, boardActor(fixture.companyId)))
      .post(`/api/issues/${fixture.issueId}/comments`)
      .send({ body: commentBody, clientRequestId });
    expect(response.status, `activity-write failure must not report success: ${JSON.stringify(response.body)}`)
      .toBeGreaterThanOrEqual(400);
    const [commentRow] = await db.execute<{ count: number }>(sql`
      select count(*)::int as count from issue_comments
        where issue_id=${fixture.issueId}::uuid and body=${commentBody}`);
    expect(commentRow?.count, "comment-add must roll back when its paired activity write fails (one transaction)").toBe(0);
    const [activityRow] = await db.execute<{ count: number }>(sql`
      select count(*)::int as count from activity_log
        where entity_type='issue' and entity_id=${fixture.issueId} and action='issue.comment_added'`);
    expect(activityRow?.count).toBe(0);
    const afterFailed = await snapshot(db, fixture);
    expectOnlyIssueColumnsChanged(before, afterFailed, ["updated_at"]);
    expect(afterFailed.comments).toEqual(before.comments);
    expect(afterFailed.activities).toEqual(before.activities);
    expectUnrelatedStateUnchanged(before, afterFailed);
    const [wakeRow] = await db.execute<{ count: number }>(sql`
      select count(*)::int as count from agent_wakeup_requests
        where company_id=${fixture.companyId}::uuid and payload->>'issueId'=${fixture.issueId}`);
    expect(wakeRow?.count, "a rolled-back comment must not enqueue the assignee wake (wake-after-commit)").toBe(0);

    await disarmCouplingGuard(fixture.issueId);
    const retry = await request(appFor(writerDb, boardActor(fixture.companyId)))
      .post(`/api/issues/${fixture.issueId}/comments`)
      .send({ body: commentBody, clientRequestId });
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
    expect(retry.body).toMatchObject({ body: commentBody, authorUserId: BOARD_USER_ID });
    const [dedupedRow] = await db.execute<{ count: number }>(sql`
      select count(*)::int as count from issue_comments
        where issue_id=${fixture.issueId}::uuid and body=${commentBody}`);
    expect(dedupedRow?.count, "clientRequestId idempotency survives the rollback: exactly one comment row").toBe(1);
    const [retryActivity] = await db.execute<{ count: number }>(sql`
      select count(*)::int as count from activity_log
        where entity_type='issue' and entity_id=${fixture.issueId} and action='issue.comment_added'`);
    expect(retryActivity?.count).toBe(1);
    await waitUntil(async () => {
      const [wake] = await db.execute<{ count: number }>(sql`
        select count(*)::int as count from agent_wakeup_requests
          where company_id=${fixture.companyId}::uuid and payload->>'issueId'=${fixture.issueId}`);
      return wake?.count ? true : null;
    }, "the successful retry's assignee wake (wake-after-commit)", 10_000);
  });

  it("comment-deletion atomic coupling: forcing the paired activity write to fail rolls the tombstone back", async () => {
    const fixture = await seed();
    const before = await snapshot(db, fixture);
    // Poisoned seam (both worlds): see the comment-add coupling test above.
    await armCouplingPoison(fixture.issueId);
    const response = await request(appFor(writerDb, boardActor(fixture.companyId)))
      .delete(`/api/issues/${fixture.issueId}/comments/${fixture.deletedCommentId}`);
    expect(response.status, `activity-write failure must not report success: ${JSON.stringify(response.body)}`)
      .toBeGreaterThanOrEqual(400);
    const [tombstone] = await db.execute<{ count: number }>(sql`
      select count(*)::int as count from issue_comments
        where id=${fixture.deletedCommentId}::uuid and deleted_at is not null`);
    expect(tombstone?.count, "comment deletion must roll back with its paired activity write (one transaction)").toBe(0);
    const [survivor] = await db.execute<{ body: string }>(sql`
      select body from issue_comments where id=${fixture.deletedCommentId}::uuid`);
    expect(survivor?.body, "the rolled-back comment must be restored exactly, not left half-tombstoned").toBe(ORIGINAL_COMMENT_BODY);
    const [activityRow] = await db.execute<{ count: number }>(sql`
      select count(*)::int as count from activity_log
        where entity_type='issue' and entity_id=${fixture.issueId} and action='issue.comment_deleted'`);
    expect(activityRow?.count).toBe(0);
    const afterFailed = await snapshot(db, fixture);
    expectOnlyIssueColumnsChanged(before, afterFailed, ["updated_at"]);
    expect(afterFailed.comments).toEqual(before.comments);
    expect(afterFailed.activities).toEqual(before.activities);
    expectUnrelatedStateUnchanged(before, afterFailed);

    await disarmCouplingGuard(fixture.issueId);
    const retry = await request(appFor(writerDb, boardActor(fixture.companyId)))
      .delete(`/api/issues/${fixture.issueId}/comments/${fixture.deletedCommentId}`);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body).toMatchObject({ id: fixture.deletedCommentId, body: "", deletedByType: "user" });
    const [retryActivity] = await db.execute<{ count: number }>(sql`
      select count(*)::int as count from activity_log
        where entity_type='issue' and entity_id=${fixture.issueId} and action='issue.comment_deleted'`);
    expect(retryActivity?.count).toBe(1);
  });

  async function armActivityPause(issueId: string) {
    await db.execute(sql`insert into paperclip_activity_pause(issue_id) values (${issueId}::uuid)`);
    await gateDb.execute(sql`select pg_advisory_lock(${PAUSE_LOCK_KEY})`);
  }

  async function releaseActivityPause() {
    await gateDb.execute(sql`select pg_advisory_unlock(${PAUSE_LOCK_KEY})`);
  }

  it("visibility ordering, comment-add: a reader never observes the comment without its activity row", async () => {
    const fixture = await seed();
    const commentBody = "visibility ordering comment";
    const clientRequestId = randomUUID();
    await armActivityPause(fixture.issueId);
    let requestSettled: string | null = null;
    const baseRequest = request(appFor(writerDb, boardActor(fixture.companyId)))
      .post(`/api/issues/${fixture.issueId}/comments`)
      .send({ body: commentBody, clientRequestId });
    baseRequest.catch(() => undefined);
    const requestPromise = baseRequest.then(
      (r) => { requestSettled = `settled ${r.status}`; return r; },
      (e) => { requestSettled = `rejected ${e?.message ?? "?"}`; throw e; },
    );
    requestPromise.catch(() => undefined);
    // Deterministic schedule, not timing: the paired activity write pauses on
    // the test-held advisory lock exactly when it executes, in both the
    // split-write world (post-commit, red) and the single-transaction world
    // (in-tx, green). Wait for the lock-wait to appear, then observe.
    await waitUntil(async () => {
      const [state] = await db.execute<{ paused: boolean }>(sql`
        select exists (
          select 1 from pg_locks l
          join pg_stat_activity a on a.pid = l.pid
          where l.locktype = 'advisory' and not l.granted
            and l.objid = ${PAUSE_LOCK_KEY}
            and a.application_name = ${WRITER_APP_NAME}
        ) as paused`);
      if (state?.paused) return true;
      if (requestSettled) throw new Error(`request settled without pausing at its paired activity write: ${requestSettled}`);
      return null;
    }, "the comment route's paired activity write to pause on the test-held advisory lock", 15_000);
    expect(requestSettled).toBeNull();
    // Independent observing connection: the comment row is already committed
    // while the paired activity row provably cannot exist yet.
    const [observed] = await readerDb.execute<{ commentRows: number; activityRows: number }>(sql`
      select
        (select count(*)::int from issue_comments
          where issue_id=${fixture.issueId}::uuid and body=${commentBody}) as "commentRows",
        (select count(*)::int from activity_log
          where entity_type='issue' and entity_id=${fixture.issueId} and action='issue.comment_added') as "activityRows"`);
    expect(observed?.activityRows, "visibility ordering: a concurrent reader must never observe the added comment row without its paired activity row")
      .toBe(observed?.commentRows);
    expect(observed?.commentRows, "the coupled pair must not be partially visible while the paired write is pending").toBe(0);
    await releaseActivityPause();
    const response = await requestPromise;
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const [finalCounts] = await db.execute<{ commentRows: number; activityRows: number }>(sql`
      select
        (select count(*)::int from issue_comments
          where issue_id=${fixture.issueId}::uuid and body=${commentBody}) as "commentRows",
        (select count(*)::int from activity_log
          where entity_type='issue' and entity_id=${fixture.issueId} and action='issue.comment_added') as "activityRows"`);
    expect(finalCounts?.commentRows).toBe(1);
    expect(finalCounts?.activityRows).toBe(1);
    await waitUntil(async () => {
      const [wake] = await db.execute<{ count: number }>(sql`
        select count(*)::int as count from agent_wakeup_requests
          where company_id=${fixture.companyId}::uuid and payload->>'issueId'=${fixture.issueId}`);
      return wake?.count ? true : null;
    }, "the committed comment's assignee wake (wake-after-commit)", 10_000);
  });

  it("visibility ordering, comment deletion: a reader never observes the tombstone without its activity row", async () => {
    const fixture = await seed();
    await armActivityPause(fixture.issueId);
    let requestSettled: string | null = null;
    const baseRequest = request(appFor(writerDb, boardActor(fixture.companyId)))
      .delete(`/api/issues/${fixture.issueId}/comments/${fixture.deletedCommentId}`);
    baseRequest.catch(() => undefined);
    const requestPromise = baseRequest.then(
      (r) => { requestSettled = `settled ${r.status}`; return r; },
      (e) => { requestSettled = `rejected ${e?.message ?? "?"}`; throw e; },
    );
    requestPromise.catch(() => undefined);
    await waitUntil(async () => {
      const [state] = await db.execute<{ paused: boolean }>(sql`
        select exists (
          select 1 from pg_locks l
          join pg_stat_activity a on a.pid = l.pid
          where l.locktype = 'advisory' and not l.granted
            and l.objid = ${PAUSE_LOCK_KEY}
            and a.application_name = ${WRITER_APP_NAME}
        ) as paused`);
      if (state?.paused) return true;
      if (requestSettled) throw new Error(`request settled without pausing at its paired activity write: ${requestSettled}`);
      return null;
    }, "the deletion route's paired activity write to pause on the test-held advisory lock", 15_000);
    expect(requestSettled).toBeNull();
    const [observed] = await readerDb.execute<{ tombstoneRows: number; activityRows: number }>(sql`
      select
        (select count(*)::int from issue_comments
          where id=${fixture.deletedCommentId}::uuid and deleted_at is not null) as "tombstoneRows",
        (select count(*)::int from activity_log
          where entity_type='issue' and entity_id=${fixture.issueId} and action='issue.comment_deleted') as "activityRows"`);
    expect(observed?.activityRows, "visibility ordering: a concurrent reader must never observe the tombstone without its paired activity row")
      .toBe(observed?.tombstoneRows);
    expect(observed?.tombstoneRows, "the coupled pair must not be partially visible while the paired write is pending").toBe(0);
    await releaseActivityPause();
    const response = await requestPromise;
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const [finalCounts] = await db.execute<{ tombstoneRows: number; activityRows: number }>(sql`
      select
        (select count(*)::int from issue_comments
          where id=${fixture.deletedCommentId}::uuid and deleted_at is not null) as "tombstoneRows",
        (select count(*)::int from activity_log
          where entity_type='issue' and entity_id=${fixture.issueId} and action='issue.comment_deleted') as "activityRows"`);
    expect(finalCounts?.tombstoneRows).toBe(1);
    expect(finalCounts?.activityRows).toBe(1);
  });
});
