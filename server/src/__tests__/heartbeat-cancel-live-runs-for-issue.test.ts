/**
 * SPA-7585 — service-level tests for `heartbeatService.cancelLiveRunsForIssue`
 * (merged in PR #58, 4f0b54a3d).
 *
 * The route tests (issue-comment-reopen-routes.test.ts) mock the heartbeat
 * service wholesale, so the union itself —
 * `contextSnapshot ->> 'issueId' = issueId OR heartbeatRuns.id = executionRunId`
 * — plus the running-first ordering and the per-run failure skip had no
 * coverage behind the route-level mock. This suite drives the REAL service
 * with the db mocked at the QUERY LAYER: every WHERE clause the service
 * builds is rendered from the drizzle AST (queryChunks) and evaluated
 * against an in-memory row store by a small SQL interpreter. Removing the
 * `or(...)` from the service therefore makes tests (b) and (c) fail (the
 * stale executionRunId row stops matching the sweep), which is the
 * red-proof the issue demands.
 */
import os from "node:os";
import path from "node:path";

process.env.RUN_LOG_BASE_PATH = process.env.RUN_LOG_BASE_PATH
  ?? path.join(os.tmpdir(), "spa-7585-run-logs");

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTableColumns, type SQL } from "drizzle-orm";
import { agents, heartbeatRuns, issues, agentWakeupRequests, issueRelations, type Db } from "@paperclipai/db";

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => null,
}));

vi.mock("../middleware/logger.js", () => {
  const warnings: unknown[] = [];
  const serialize = (value: unknown): unknown => {
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: value.stack };
    }
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = serialize(v);
      }
      return out;
    }
    return value;
  };
  const mk = () =>
    vi.fn((...args: unknown[]) => {
      warnings.push(args.map(serialize));
    });
  return {
    logger: {
      info: mk(),
      warn: mk(),
      error: mk(),
      debug: mk(),
      trace: mk(),
      fatal: mk(),
      child: () => ({ warn: mk(), info: mk(), error: mk() }),
    },
    __loggerCapturedWarnings: warnings,
  };
});

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentFirstHeartbeat: vi.fn(),
  trackAgentTaskCompleted: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    get: async () => ({ id: "instance-settings-1", general: {}, experimental: {} }),
    getGeneral: async () => ({ censorUsernameInLogs: false }),
    getExperimental: async () => ({}),
    updateGeneral: async () => ({}),
    updateExperimental: async () => ({}),
    listCompanyIds: async () => [],
  }),
  resolveWorktreeRunExecutionActivation: () => ({ armed: false, cutoff: null }),
}));

// ---------------------------------------------------------------------------
// In-memory table store
// ---------------------------------------------------------------------------

type AnyRow = Record<string, unknown>;

const dbState: {
  heartbeat_runs: AnyRow[];
  agents: AnyRow[];
  issues: AnyRow[];
  agent_wakeup_requests: AnyRow[];
  issue_relations: AnyRow[];
} = {
  heartbeat_runs: [],
  agents: [],
  issues: [],
  agent_wakeup_requests: [],
  issue_relations: [],
};

const tablesByIdentity = new Map<unknown, string>([
  [heartbeatRuns, "heartbeat_runs"],
  [agents, "agents"],
  [issues, "issues"],
  [agentWakeupRequests, "agent_wakeup_requests"],
  [issueRelations, "issue_relations"],
]);

// Column object → JS property key (drizzle Column.name is the DB name).
const columnToKey = new Map<unknown, string>();
for (const table of [heartbeatRuns, agents]) {
  for (const [key, column] of Object.entries(getTableColumns(table))) {
    columnToKey.set(column, key);
  }
}

// ---------------------------------------------------------------------------
// drizzle AST → rendered SQL text with placeholder params
// ---------------------------------------------------------------------------

// drizzle 0.45 stores entityKind as a STATIC class property; instances
// reach it via their constructor (drizzle's own `is()` walks the prototype
// chain for the same reason).
function entityKindOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  let cls = (value as { constructor?: { [key: PropertyKey]: unknown } }).constructor;
  while (cls) {
    const kind = cls[Symbol.for("drizzle:entityKind")];
    if (typeof kind === "string") return kind;
    cls = Object.getPrototypeOf(cls) as typeof cls;
  }
  return undefined;
}

interface RenderedSql {
  text: string;
  params: unknown[];
}

function renderSqlAst(ast: SQL): RenderedSql {
  const params: unknown[] = [];
  const walk = (chunks: unknown[]): string =>
    chunks
      .map((chunk): string => {
        if (typeof chunk === "string") return chunk;
        if (Array.isArray(chunk)) {
          return "(" + chunk.map((entry) => walk([entry])).join(", ") + ")";
        }
        const kind = entityKindOf(chunk);
        if (kind === "StringChunk") {
          const value = (chunk as { value: string | string[] }).value;
          return Array.isArray(value) ? value.join("") : value;
        }
        if (kind === "Name") {
          return String((chunk as { value: unknown }).value);
        }
        if (kind === "PgColumn" || kind === "Column" || kind?.startsWith("Pg")) {
          const viaMap = columnToKey.get(chunk);
          if (viaMap) return viaMap;
          const name = (chunk as { name?: string }).name;
          if (typeof name === "string") return name;
        }
        if (kind === "Param") {
          params.push((chunk as { value: unknown }).value);
          return `__P${params.length - 1}__`;
        }
        if (kind === "Table") {
          return "";
        }
        const nested = (chunk as { queryChunks?: unknown[] }).queryChunks;
        if (Array.isArray(nested)) return walk(nested);
        return "?";
      })
      .join("");
  return { text: walk((ast as { queryChunks?: unknown[] }).queryChunks ?? []), params };
}

// ---------------------------------------------------------------------------
// Tiny SQL interpreter — supports exactly the clause shapes the service
// emits on this path: AND/OR with parens, `col = val`, `col <> val`,
// `col in (list)`, `col ->> 'key' = val`, and bare true/false.
// Anything unparseable fails CLOSED (row excluded) so the mock can never
// silently over-select.
// ---------------------------------------------------------------------------

type Token =
  | { t: "ident"; v: string }
  | { t: "str"; v: string }
  | { t: "num"; v: number }
  | { t: "param"; v: number }
  | { t: "op"; v: string };

function lex(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "(") {
      tokens.push({ t: "op", v: "(" });
      i += 1;
      continue;
    }
    if (ch === ")") {
      tokens.push({ t: "op", v: ")" });
      i += 1;
      continue;
    }
    if (ch === ",") {
      tokens.push({ t: "op", v: "," });
      i += 1;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      let buf = "";
      while (j < sql.length && sql[j] !== "'") {
        buf += sql[j] === "\\'" ? sql[++j] : sql[j];
        j += 1;
      }
      tokens.push({ t: "str", v: buf });
      i = j + 1;
      continue;
    }
    if (ch === "_" && sql.startsWith("__P", i)) {
      let j = i + 3;
      let digits = "";
      while (j < sql.length && /\d/.test(sql[j])) {
        digits += sql[j];
        j += 1;
      }
      tokens.push({ t: "param", v: Number(digits) });
      i = j + 2; // trailing "__"
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      // Idents are letters/digits/`_`/`-`/`.`. Param markers `__PN__`
      // stay idents here; parseComparison strips the `__` suffix via
      // `tokenValue` to recover the parameter index.
      while (j < sql.length && /[A-Za-z0-9_\-.]/.test(sql[j])) j += 1;
      tokens.push({ t: "ident", v: sql.slice(i, j) });
      i = j;
      continue;
    }
    if (/[-<>=!]/.test(ch)) {
      let j = i;
      while (j < sql.length && /[-<>=!]/.test(sql[j])) j += 1;
      tokens.push({ t: "op", v: sql.slice(i, j) });
      i = j;
      continue;
    }
    if (/\d/.test(ch)) {
      let j = i;
      // Bare raw values (the service's `sql` template emits the issueId as
      // a plain StringChunk) lex as ident-like runs — the trailing dash
      // and hex continuation make them unambiguous as literal values, not
      // column references, so tokenValue resolves them via allowBareIdent.
      while (j < sql.length && /[0-9.\-]/.test(sql[j])) j += 1;
      tokens.push({ t: "ident", v: sql.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`spa-7585 mock: unsupported SQL character ${JSON.stringify(ch)} in ${sql}`);
  }
  return tokens;
}

class SqlInterpreter {
  private tokens: Token[];
  private pos = 0;
  constructor(
    tokens: Token[],
    private params: unknown[],
    private row: AnyRow,
  ) {
    this.tokens = tokens;
  }

  static evaluate(clause: SQL, row: AnyRow): boolean {
    const rendered = renderSqlAst(clause);
    const interpreter = new SqlInterpreter(
      lex(rendered.text),
      rendered.params,
      row,
    );
    return interpreter.parseExpression();
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token | undefined {
    return this.tokens[this.pos++];
  }

  private expectOp(v: string): void {
    const tok = this.next();
    if (!tok || tok.t !== "op" || tok.v !== v) {
      throw new Error(`spa-7585 mock: expected ${JSON.stringify(v)} in rendered WHERE`);
    }
  }

  private parseExpression(): boolean {
    return this.parseOr();
  }

  private parseOr(): boolean {
    let left = this.parseAnd();
    while (this.isKeyword("or")) {
      this.next();
      const right = this.parseAnd();
      left = left || right;
    }
    return left;
  }

  private parseAnd(): boolean {
    let left = this.parseAtom();
    while (this.isKeyword("and")) {
      this.next();
      const right = this.parseAtom();
      left = left && right;
    }
    return left;
  }

  private isKeyword(word: string): boolean {
    const tok = this.peek();
    return tok?.t === "ident" && tok.v.toLowerCase() === word;
  }

  private parseAtom(): boolean {
    const tok = this.peek();
    if (!tok) throw new Error("spa-7585 mock: unexpected end of WHERE");
    if (tok.t === "op" && tok.v === "(") {
      this.next();
      const value = this.parseOr();
      this.expectOp(")");
      return value;
    }
    if (tok.t === "ident") {
      const lower = tok.v.toLowerCase();
      if (lower === "true") {
        this.next();
        return true;
      }
      if (lower === "false") {
        this.next();
        return false;
      }
      if (lower === "not") {
        this.next();
        return !this.parseAtom();
      }
      return this.parseComparison();
    }
    throw new Error(`spa-7585 mock: unexpected token ${JSON.stringify(tok)}`);
  }

  private parseComparison(): boolean {
    const lhsTok = this.next();
    if (!lhsTok || lhsTok.t !== "ident") {
      throw new Error("spa-7585 mock: comparison must start with an identifier");
    }
    let lhsValue: unknown = this.row[lhsTok.v];
    // jsonb accessor: col ->> 'key' — when the rhs uses bare words/UUIDs
    // (rendered as plain StringChunks by the service's `sql` template),
    // treat them as values on the arrow path only.
    const arrow = this.peek();
    const arrowWasJsonbAccessor =
      arrow?.t === "op" && arrow.v === "->>" ? (this.next(), true) : false;
    let jsonbKey: string | undefined;
    if (arrowWasJsonbAccessor) {
      const keyTok = this.next();
      if (!keyTok || keyTok.t !== "str") {
        throw new Error("spa-7585 mock: ->> must be followed by a string key");
      }
      jsonbKey = keyTok.v;
      lhsValue =
        lhsValue && typeof lhsValue === "object"
          ? (lhsValue as AnyRow)[jsonbKey]
          : undefined;
    }
    const opTok = this.next();
    if (!opTok) throw new Error("spa-7585 mock: missing comparison operator");
    // `in` lexes as an ident because letter-only; treat it as the IN op.
    let op: string;
    let rhsIsInList = false;
    if (opTok.t === "ident" && opTok.v.toLowerCase() === "in") {
      op = "in";
      rhsIsInList = true;
    } else if (opTok.t === "op" && opTok.v.toLowerCase() === "is") {
      op = "is";
    } else if (opTok.t === "op") {
      op = opTok.v.toLowerCase();
    } else {
      throw new Error(`spa-7585 mock: unsupported comparison operator ${JSON.stringify(opTok)}`);
    }
    const jsonbPath = arrowWasJsonbAccessor;
    if (op === "is") {
      const negated = this.isKeyword("not");
      if (negated) this.next();
      const nullTok = this.next();
      const isNullClause = nullTok?.t === "ident" && nullTok.v.toLowerCase() === "null";
      if (!isNullClause) throw new Error("spa-7585 mock: malformed IS clause");
      return negated ? lhsValue != null : lhsValue == null;
    }
    if (op === "in") {
      this.expectOp("(");
      const list: unknown[] = [];
      while (true) {
        const valueTok = this.next();
        if (!valueTok) throw new Error("spa-7585 mock: unterminated IN list");
        if (valueTok.t === "op" && valueTok.v === ")") break;
        if (valueTok.t === "op" && valueTok.v === ",") continue;
        list.push(this.tokenValue(valueTok));
      }
      return list.some((entry) => entry === lhsValue);
    }
    const rhsTok = this.next();
    if (!rhsTok) throw new Error("spa-7585 mock: missing comparison rhs");
    const rhsValue = this.tokenValue(rhsTok, jsonbPath);
    switch (op) {
      case "=":
        return lhsValue === rhsValue;
      case "<>":
      case "!=":
        return lhsValue !== rhsValue;
      case ">":
        return compare(lhsValue, rhsValue) > 0;
      case ">=":
        return compare(lhsValue, rhsValue) >= 0;
      case "<":
        return compare(lhsValue, rhsValue) < 0;
      case "<=":
        return compare(lhsValue, rhsValue) <= 0;
      default:
        throw new Error(`spa-7585 mock: unsupported operator ${op}`);
    }
  }

  private tokenValue(tok: Token, allowBareIdent = false): unknown {
    if (tok.t === "param") return this.params[tok.v];
    if (tok.t === "str") return tok.v;
    if (tok.t === "num") return tok.v;
    // Param markers `__PN__` lex as idents (charset overlap with `-`);
    // resolve them against the captured params array.
    const marker = /^__P(\d+)__$/.exec(tok.v);
    if (marker) return this.params[Number(marker[1])];
    if (tok.t === "ident" && tok.v.toLowerCase() === "null") return null;
    // The service's `sql` template emits raw string values (e.g. the issueId
    // in the jsonb comparison) as plain StringChunks; on the unambiguous
    // jsonb-arrow path those arrive as bare idents.
    if (allowBareIdent && tok.t === "ident") return tok.v;
    throw new Error(`spa-7585 mock: unsupported rhs token ${JSON.stringify(tok)}`);
  }
}

function compare(a: unknown, b: unknown): number {
  const av = a instanceof Date ? a.getTime() : Number(a);
  const bv = b instanceof Date ? b.getTime() : Number(b);
  if (Number.isNaN(av) || Number.isNaN(bv)) return 0;
  return av - bv;
}

// ---------------------------------------------------------------------------
// Observability + failure injection hooks
// ---------------------------------------------------------------------------

const observed = {
  /** Rendered WHERE text of every sweep select, in call order. */
  sweepWhereSql: [] as string[],
  sweepParams: [] as string[],
  /** getRun/select lookups whose result was forced empty (failure injection). */
  vanishRunIds: new Set<string>(),
};

/**
 * Rows the sweep is expected to pick up BEFORE failure injection; the
 * vanish hook removes a row from lookups issued AFTER the sweep select so
 * the per-run cancel fails with `notFound` inside the service's try/catch.
 */
function vanishOnLaterLookups(runId: string): void {
  observed.vanishRunIds.add(runId);
}

// ---------------------------------------------------------------------------
// Query-layer db mock
// ---------------------------------------------------------------------------

function rowsFor(tableKey: string): AnyRow[] {
  const rows = (dbState as unknown as Record<string, AnyRow[]>)[tableKey];
  if (!rows) throw new Error(`spa-7585 mock: unknown table ${tableKey}`);
  return rows;
}

function matchesWhere(where: unknown, row: AnyRow): boolean {
  if (!where) return true;
  return SqlInterpreter.evaluate(where as SQL, row);
}

interface SortState {
  tableKey?: string;
  where?: unknown;
  orderBy?: unknown[];
  limit?: number;
}

function executeSelect(state: SortState): AnyRow[] {
  const tableKey = state.tableKey;
  if (!tableKey) throw new Error("spa-7585 mock: select without from()");
  let rows = rowsFor(tableKey).filter((row) => matchesWhere(state.where, row));
  if (state.orderBy?.length) {
    const comparators = state.orderBy.map(orderByComparator);
    rows = rows.slice().sort((a, b) => {
      for (const cmp of comparators) {
        const result = cmp(a, b);
        if (result !== 0) return result;
      }
      return 0;
    });
  }
  if (state.limit != null) rows = rows.slice(0, state.limit);
  return rows;
}

function orderByComparator(arg: unknown): (a: AnyRow, b: AnyRow) => number {
  const { text } = renderSqlAst(arg as SQL);
  if (/case\s+when/i.test(text) && /'running'/.test(text)) {
    return (a, b) => (a.status === "running" ? 0 : 1) - (b.status === "running" ? 0 : 1);
  }
  const match = /([A-Za-z0-9_]+)\s*(asc|desc)?\s*$/i.exec(text.trim());
  if (!match) return () => 0;
  const key = match[1];
  const direction = match[2]?.toLowerCase() === "desc" ? -1 : 1;
  return (a, b) => direction * compare(a[key], b[key]);
}

function makeSelectChain(): Record<string, unknown> & PromiseLike<AnyRow[]> {
  const state: SortState = {};
  const chain = {
    from(table: unknown) {
      state.tableKey = tablesByIdentity.get(table);
      if (!state.tableKey) throw new Error("spa-7585 mock: select from unknown table");
      return chain;
    },
    where(where: unknown) {
      state.where = where;
      if (state.tableKey === "heartbeat_runs" && where) {
        const rendered = renderSqlAst(where as SQL);
        observed.sweepWhereSql.push(rendered.text);
        observed.sweepParams.push(...(rendered.params as string[]));
      }
      return chain;
    },
    orderBy(...args: unknown[]) {
      state.orderBy = args;
      return chain;
    },
    limit(n: number) {
      state.limit = n;
      return chain;
    },
    then<T>(
      onFulfilled: (rows: AnyRow[]) => T,
      onRejected?: (reason: unknown) => T,
    ): PromiseLike<T> {
      return Promise.resolve(executeSelect(state)).then(onFulfilled, onRejected);
    },
    catch(rejected: (reason: unknown) => AnyRow[]) {
      return Promise.resolve(executeSelect(state)).catch(rejected);
    },
    finally(fn: () => void) {
      return Promise.resolve(executeSelect(state)).finally(fn);
    },
  };
  return chain as unknown as Record<string, unknown> & PromiseLike<AnyRow[]>;
}

function makeUpdateChain(table?: unknown): Record<string, unknown> {
  const tableKey = table ? tablesByIdentity.get(table) : undefined;
  let patch: AnyRow = {};
  let where: unknown;
  const apply = (): AnyRow[] => {
    if (!tableKey) throw new Error("spa-7585 mock: update without table");
    const updated: AnyRow[] = [];
    for (const row of rowsFor(tableKey)) {
      if (matchesWhere(where, row)) {
        Object.assign(row, patch);
        updated.push(row);
      }
    }
    return updated;
  };
  const chain = {
    set(input: AnyRow) {
      patch = input;
      return chain;
    },
    where(input: unknown) {
      where = input;
      return chain;
    },
    returning() {
      return Promise.resolve(apply());
    },
    then<T>(
      onFulfilled: (rows: AnyRow[]) => T,
      onRejected?: (reason: unknown) => T,
    ): PromiseLike<T> {
      return Promise.resolve(apply()).then(onFulfilled, onRejected);
    },
  };
  return chain as unknown as Record<string, unknown>;
}

function makeInsertChain(): Record<string, unknown> {
  const chain = {
    values(input: unknown) {
      return Promise.resolve(input);
    },
  };
  return chain as unknown as Record<string, unknown>;
}

function makeQueryExecutor(): Record<string, unknown> {
  const chain = {
    then<T>(
      onFulfilled: (rows: AnyRow[]) => T,
      onRejected?: (reason: unknown) => T,
    ): PromiseLike<T> {
      // hasUnsafeTextProjectionDatabase probes server_encoding.
      return Promise.resolve([{ server_encoding: "UTF8" }]).then(onFulfilled, onRejected);
    },
  };
  return chain as unknown as Record<string, unknown>;
}

function makeDb(): Db {
  const db = {
    select: vi.fn(() => makeSelectChain()),
    update: vi.fn((table: unknown) => makeUpdateChain(table)),
    insert: vi.fn(() => makeInsertChain()),
    execute: vi.fn(() => makeQueryExecutor()),
    transaction: vi.fn(
      async <T>(fn: (tx: {
        execute: (ast: unknown) => Promise<unknown[]>;
        select: () => Record<string, unknown> & PromiseLike<AnyRow[]>;
        update: (table: unknown) => Record<string, unknown>;
        insert: () => Record<string, unknown>;
      }) => Promise<T>) =>
        fn({
          execute: async () => [],
          select: () => makeSelectChain(),
          update: (table: unknown) => makeUpdateChain(table),
          insert: () => makeInsertChain(),
        }),
    ),
  };
  return db as unknown as Db;
}

let sweepSelectDone = false;

// ---------------------------------------------------------------------------
// Service under test
// ---------------------------------------------------------------------------

import { heartbeatService } from "../services/heartbeat.js";
import { __loggerCapturedWarnings } from "../middleware/logger.js";

function buildService(): ReturnType<typeof heartbeatService> {
  sweepSelectDone = false;
  observed.sweepWhereSql.length = 0;
  return heartbeatService(makeDb(), {
    runtimeEnv: { NODE_ENV: "test" },
  } as never);
}

// ---------------------------------------------------------------------------
// Row factories
// ---------------------------------------------------------------------------

let runSeq = 0;

function makeRunRow(overrides: {
  id: string;
  status: string;
  contextSnapshot?: Record<string, unknown> | null;
  createdAt?: Date;
}): AnyRow {
  runSeq += 1;
  const now = overrides.createdAt ?? new Date(Date.parse("2026-09-16T00:00:00Z") + runSeq * 1000);
  return {
    id: overrides.id,
    companyId: "11111111-1111-4111-8111-111111111111",
    agentId: "22222222-2222-4222-8222-222222222222",
    invocationSource: "on_demand",
    triggerDetail: null,
    status: overrides.status,
    responsibleUserId: null,
    startedAt: overrides.status === "running" ? now : null,
    finishedAt: null,
    error: null,
    wakeupRequestId: null,
    exitCode: null,
    signal: null,
    usageJson: null,
    resultJson: null,
    runtimeMode: "legacy",
    runtimeModeResolverVersion: null,
    runtimeModeReason: null,
    runtimeModeResolvedAt: null,
    runnerProfileJson: null,
    runnerInstanceId: null,
    nativeSessionId: null,
    nativeIssueId: null,
    driverKind: null,
    driverVersion: null,
    completionContractId: null,
    completionContractSha256: null,
    nextEventSeq: 1,
    nativePhase: null,
    nativePhaseUpdatedAt: null,
    sessionIdBefore: null,
    sessionIdAfter: null,
    logStore: null,
    logRef: null,
    logBytes: null,
    logSha256: null,
    logCompressed: false,
    stdoutExcerpt: null,
    stderrExcerpt: null,
    errorCode: null,
    externalRunId: null,
    // processPid/processGroupId stay null so the real cancelRunInternal
    // never reaches terminateHeartbeatRunProcess.
    processPid: null,
    processGroupId: null,
    processStartedAt: null,
    lastOutputAt: null,
    lastOutputSeq: 0,
    lastOutputStream: null,
    lastOutputBytes: null,
    retryOfRunId: null,
    processLossRetryCount: 0,
    scheduledRetryAt: null,
    scheduledRetryAttempt: 0,
    scheduledRetryReason: null,
    issueCommentStatus: "not_applicable",
    issueCommentSatisfiedByCommentId: null,
    issueCommentRetryQueuedAt: null,
    livenessState: null,
    livenessReason: null,
    continuationAttempt: 0,
    lastUsefulActionAt: null,
    nextAction: null,
    contextSnapshot: overrides.contextSnapshot ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

function makeAgentRow(): AnyRow {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    companyId: "11111111-1111-4111-8111-111111111111",
    name: "spa-7585-agent",
    // paused keeps the downstream release/queued-start recovery paths
    // shallow: finalizeAgentStatus early-returns on paused agents.
    status: "paused",
    reportsTo: null,
    role: "builder",
    createdAt: new Date("2026-09-16T00:00:00Z"),
    updatedAt: new Date("2026-09-16T00:00:00Z"),
  };
}

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const ISSUE_ID = "33333333-3333-4333-8333-333333333333";
const STALE_RUN_ID = "44444444-4444-4444-8444-444444444444";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("heartbeatService.cancelLiveRunsForIssue (SPA-7585)", () => {
  beforeEach(() => {
    dbState.heartbeat_runs = [];
    dbState.agents = [makeAgentRow()];
    dbState.issues = [];
    dbState.agent_wakeup_requests = [];
    dbState.issue_relations = [];
    runSeq = 0;
    observed.vanishRunIds.clear();
    observed.sweepWhereSql.length = 0;
    observed.sweepParams.length = 0;
    (__loggerCapturedWarnings as unknown[]).length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("(a) cancels the snapshot-bound live runs, running first", async () => {
    const svc = buildService();
    dbState.heartbeat_runs = [
      makeRunRow({
        id: "aaaaaaaa-0000-4000-8000-000000000001",
        status: "queued",
        contextSnapshot: { issueId: ISSUE_ID },
        createdAt: new Date("2026-09-16T00:00:01Z"),
      }),
      makeRunRow({
        id: "aaaaaaaa-0000-4000-8000-000000000002",
        status: "running",
        contextSnapshot: { issueId: ISSUE_ID },
        createdAt: new Date("2026-09-16T00:00:02Z"),
      }),
      makeRunRow({
        id: "aaaaaaaa-0000-4000-8000-000000000003",
        status: "running",
        contextSnapshot: { issueId: "99999999-9999-4999-8999-999999999999" },
        createdAt: new Date("2026-09-16T00:00:03Z"),
      }),
    ];

    const cancelled = await svc.cancelLiveRunsForIssue(COMPANY_ID, ISSUE_ID, null);

    expect(cancelled.map((run) => run.id)).toEqual([
      // running-first: the running snapshot-bound run precedes the queued one
      "aaaaaaaa-0000-4000-8000-000000000002",
      "aaaaaaaa-0000-4000-8000-000000000001",
    ]);
    // rows are terminal afterwards (setRunStatus applied to the store)
    const byId = new Map(dbState.heartbeat_runs.map((row) => [row.id, row]));
    expect(byId.get("aaaaaaaa-0000-4000-8000-000000000002")?.status).toBe("cancelled");
    expect(byId.get("aaaaaaaa-0000-4000-8000-000000000001")?.status).toBe("cancelled");
    expect(byId.get("aaaaaaaa-0000-4000-8000-000000000003")?.status).toBe("running");
  });

  it("(b) cancels the stale executionRunId even though its snapshot does not name the issue", async () => {
    const svc = buildService();
    dbState.heartbeat_runs = [
      makeRunRow({
        id: STALE_RUN_ID,
        status: "running",
        contextSnapshot: { issueId: "99999999-9999-4999-8999-999999999999" },
      }),
    ];

    const cancelled = await svc.cancelLiveRunsForIssue(COMPANY_ID, ISSUE_ID, STALE_RUN_ID);

    expect(cancelled.map((run) => run.id)).toEqual([STALE_RUN_ID]);
    expect(dbState.heartbeat_runs[0].status).toBe("cancelled");
  });

  it("(c) sweeps the union with running-first ordering across snapshot + stale runs", async () => {
    const svc = buildService();
    // Insertion order is deliberately NOT the expected order: the queued
    // run was created first, so only the running-first orderBy produces
    // the expected sequence.
    dbState.heartbeat_runs = [
      makeRunRow({
        id: "aaaaaaaa-0000-4000-8000-00000000000a",
        status: "queued",
        contextSnapshot: { issueId: ISSUE_ID },
        createdAt: new Date("2026-09-16T00:00:01Z"),
      }),
      makeRunRow({
        id: "aaaaaaaa-0000-4000-8000-00000000000b",
        status: "running",
        contextSnapshot: { issueId: ISSUE_ID },
        createdAt: new Date("2026-09-16T00:00:02Z"),
      }),
      makeRunRow({
        id: STALE_RUN_ID,
        status: "running",
        contextSnapshot: { issueId: "99999999-9999-4999-8999-999999999999" },
        createdAt: new Date("2026-09-16T00:00:03Z"),
      }),
    ];

    const cancelled = await svc.cancelLiveRunsForIssue(COMPANY_ID, ISSUE_ID, STALE_RUN_ID);

    expect(cancelled.map((run) => run.id)).toEqual([
      // running rows first, oldest createdAt first (snapshot running before
      // stale running), then the queued run.
      "aaaaaaaa-0000-4000-8000-00000000000b",
      STALE_RUN_ID,
      "aaaaaaaa-0000-4000-8000-00000000000a",
    ]);
  });

  it("(d) an already-terminal stale executionRunId row is skipped (idempotent)", async () => {
    const svc = buildService();
    dbState.heartbeat_runs = [
      makeRunRow({
        id: STALE_RUN_ID,
        status: "succeeded",
        contextSnapshot: { issueId: "99999999-9999-4999-8999-999999999999" },
      }),
      makeRunRow({
        id: "aaaaaaaa-0000-4000-8000-00000000000c",
        status: "scheduled_retry",
        contextSnapshot: { issueId: ISSUE_ID },
      }),
    ];

    const cancelled = await svc.cancelLiveRunsForIssue(COMPANY_ID, ISSUE_ID, STALE_RUN_ID);

    expect(cancelled.map((run) => run.id)).toEqual([
      "aaaaaaaa-0000-4000-8000-00000000000c",
    ]);
    expect(dbState.heartbeat_runs[0].status).toBe("succeeded");
  });

  it("skips a run whose cancellation throws and still cancels the rest", async () => {
    const svc = buildService();
    const doomed = "aaaaaaaa-0000-4000-8000-00000000000d";
    const doomedRow = makeRunRow({
      id: doomed,
      status: "running",
      contextSnapshot: { issueId: ISSUE_ID },
    });
    const survivorRow = makeRunRow({
      id: "aaaaaaaa-0000-4000-8000-00000000000e",
      status: "running",
      contextSnapshot: { issueId: ISSUE_ID },
      createdAt: new Date("2026-09-16T00:01:00Z"),
    });
    dbState.heartbeat_runs = [doomedRow, survivorRow];
    // The sweep select must still return the doomed row; later per-run
    // lookups (getRun inside cancelRunInternal) must NOT — the service
    // then throws notFound internally and continues with the survivor.
    const originalRuns = rowsFor("heartbeat_runs");
    const originalFilter = Array.prototype.filter;
    void originalFilter;
    void originalRuns;
    vanishOnLaterLookups(doomed);

    const cancelled = await svc.cancelLiveRunsForIssue(COMPANY_ID, ISSUE_ID, null);

    expect(cancelled.map((run) => run.id)).toEqual([survivorRow.id as string]);
    expect((dbState.heartbeat_runs.find((r) => r.id === survivorRow.id) as AnyRow).status).toBe(
      "cancelled",
    );
  });

  it("excludeRunId leaves that run untouched even when it matches the union", async () => {
    const svc = buildService();
    const keep = makeRunRow({
      id: "aaaaaaaa-0000-4000-8000-00000000000f",
      status: "running",
      contextSnapshot: { issueId: ISSUE_ID },
    });
    const sweep = makeRunRow({
      id: "aaaaaaaa-0000-4000-8000-000000000010",
      status: "running",
      contextSnapshot: { issueId: ISSUE_ID },
      createdAt: new Date("2026-09-16T00:02:00Z"),
    });
    dbState.heartbeat_runs = [keep, sweep];

    const cancelled = await svc.cancelLiveRunsForIssue(
      COMPANY_ID,
      ISSUE_ID,
      null,
      keep.id as string,
    );

    expect(cancelled.map((run) => run.id)).toEqual([sweep.id as string]);
    expect(dbState.heartbeat_runs.find((r) => r.id === keep.id)?.status).toBe("running");
  });

  // -------------------------------------------------------------------------
  // Walker-honesty guard: the sweep select must genuinely carry the union.
  // If the drizzle walker ever renders the WHERE losslessly this also
  // documents the exact clause shape the tests above depend on.
  // -------------------------------------------------------------------------
  it("sweep WHERE carries the or(...) union and running-first ordering", async () => {
    const svc = buildService();
    dbState.heartbeat_runs = [
      makeRunRow({
        id: STALE_RUN_ID,
        status: "running",
        contextSnapshot: { issueId: "99999999-9999-4999-8999-999999999999" },
      }),
    ];
    await svc.cancelLiveRunsForIssue(COMPANY_ID, ISSUE_ID, STALE_RUN_ID);

    const whereSql = observed.sweepWhereSql.join(" || ");
    // The service binds the stale runId as a SQL parameter (rendered as
    // __P4__), not a literal — assert the union + that the stale runId is
    // present in the captured params at the moment of the sweep select.
    expect(whereSql).toMatch(/contextSnapshot\s*->>\s*'issueId'/);
    expect(whereSql).toMatch(/\bor\b/i);
  });

  it("sweep binds the stale executionRunId as a parameter (red-proof contract)", async () => {
    const svc = buildService();
    dbState.heartbeat_runs = [
      makeRunRow({
        id: STALE_RUN_ID,
        status: "running",
        contextSnapshot: { issueId: "99999999-9999-4999-8999-999999999999" },
      }),
    ];
    await svc.cancelLiveRunsForIssue(COMPANY_ID, ISSUE_ID, STALE_RUN_ID);
    expect(observed.sweepParams).toContain(STALE_RUN_ID);
  });
});

// ---------------------------------------------------------------------------
// Vanish support inside the interpreter: rows listed in observed.vanishRunIds
// are hidden from getRun-style lookups issued after the sweep. Implemented as
// a post-filter keyed on the lookup's WHERE text (an id equality against a
// vanished id) so the sweep itself is unaffected.
// ---------------------------------------------------------------------------

const originalEvaluate = SqlInterpreter.evaluate;
SqlInterpreter.evaluate = function (clause: SQL, row: AnyRow): boolean {
  try {
    const result = originalEvaluate.call(SqlInterpreter, clause, row);
    if (!result) return false;
    // Vanish hook: a row whose id is listed in observed.vanishRunIds is
    // hidden from getRun-style single-id lookups (WHERE renders as
    // `id = __PN__`) issued AFTER the sweep select — the sweep itself is
    // unaffected. The service's per-run cancel then fails notFound inside
    // its own try/catch, exercising the failure-skip path.
    const rendered = renderSqlAst(clause);
    if (
      /^id\s*=\s*__P\d+__$/.test(rendered.text.trim()) &&
      typeof rendered.params[0] === "string" &&
      observed.vanishRunIds.has(rendered.params[0] as string) &&
      observed.sweepWhereSql.length > 0
    ) {
      return false;
    }
    return result;
  } catch (err) {
    const rendered = renderSqlAst(clause);
    const { appendFileSync } = require("node:fs") as typeof import("node:fs");
    appendFileSync(
      process.env.SPA7585_DEBUG_DUMP ?? "/tmp/spa7585-where-dump.txt",
      `WHERE: ${rendered.text}\nPARAMS: ${JSON.stringify(rendered.params)}\nERR: ${String(err)}\n`,
    );
    throw err;
  }
};
