# packages/db

Paperclip engine database client (postgres.js + drizzle). This file documents
the environment variables the client reads; there is no deployment env
template file in this repo, so this is the reference surface for them.

## Connection tuning environment variables

Every variable is optional; self-hosted setups need none of them. See
`src/client.ts` for the parser and defaults.

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_STATEMENT_TIMEOUT_MS` | `60000` | Per-connection `statement_timeout` (ms) on the pooled runtime client. `0` disables the timeout (Postgres semantics). |
| `DATABASE_LOCK_TIMEOUT_MS` | `5000` | Per-connection `lock_timeout` (ms) on the pooled runtime client. `0` disables the timeout. |
| `DATABASE_POOL_MAX` | `10` | postgres.js `max` for the pooled client. Sized as `ceil(peak concurrent runs) + slack` — see the formula comment on `DEFAULT_DATABASE_POOL_MAX` in `src/client.ts`. Raise only alongside the DB's `max_connections`. |
| `DATABASE_IDLE_TIMEOUT_SECONDS` | `60` | postgres.js `idle_timeout` (s). `0` disables idle reaping. |
| `DATABASE_CONNECT_TIMEOUT_SECONDS` | driver default (30) | postgres.js `connect_timeout` (s). |
| `DATABASE_MAX_LIFETIME_SECONDS` | driver default (30–60 min random) | postgres.js `max_lifetime` (s). |
| `DATABASE_APPLICATION_NAME` | `paperclip` | `application_name` shown in `pg_stat_activity`. |
| `DATABASE_PREPARED_STATEMENTS` | driver default (enabled) | Set `false` behind transaction-mode poolers (pgbouncer / Neon `-pooler` / Supavisor transaction ports). |

### Why statement 60s but lock 5s (PR #227 review T1)

The two timeouts bound different failure classes:

- **`statement_timeout` default 60s** — raised from 5s during PR #227 review:
  a 5s default applied to every pooled connection could abort long-running
  statements (migrations, analytics, backfills) that previously ran unbounded
  against the engine database. 60s is a runaway backstop, not the hang-killer.
  For queries over 60s that should stay bounded, raise the timeout per
  transaction with `set_config('statement_timeout', ...)`.
- **`lock_timeout` default 5s** — the diagnosed incident class is unbounded
  row-LOCK waits (e.g. on `heartbeat_runs`), which the tight lock bound
  kills. Kept at 5s.
- The heartbeat onLog path additionally drops a chunk's progress flush after
  3s (`progress_flush_dropped`, `server/src/services/heartbeat.ts`), so the
  pooled-client statement bound is a second line of defense, not the primary.

### Utility / migration client exemption (PR #227 review T2)

The utility client (`createUtilitySql`, used for migrations, inspection and
repair SQL) does **not** inherit the pooled client's timeout defaults: by
default it runs with no statement/lock timeout at all, because migrations and
repair SQL may legitimately exceed them. Only an **explicitly set**
`DATABASE_STATEMENT_TIMEOUT_MS` / `DATABASE_LOCK_TIMEOUT_MS` bounds utility
work; `DATABASE_POOL_MAX` and other pool settings still apply (pool forced to
`max: 1` — utility work is serial).

### Relationship to the heartbeat onLog drain bound (PR #227 review T6)

The server's onLog path drops a chunk's persistence wait after
`PAPERCLIP_ONLOG_TIMEOUT_MS` (default **3000** ms,
`server/src/services/heartbeat.ts`), while the adapter's log-chain close
settle waits `PAPERCLIP_LOG_CHAIN_SETTLE_TIMEOUT_MS` (default **4000** ms,
`packages/adapter-utils/src/server-utils.ts`). If you raise
`PAPERCLIP_ONLOG_TIMEOUT_MS`, raise `PAPERCLIP_LOG_CHAIN_SETTLE_TIMEOUT_MS`
to at least the same value — otherwise the close path cuts appends earlier
than onLog would have. No cross-package clamp is enforced:
`adapter-utils` deliberately does not read the server-side env var.
