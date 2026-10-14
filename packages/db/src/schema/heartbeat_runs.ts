import { sql, type SQL } from "drizzle-orm";
import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  integer,
  bigint,
  boolean,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { agentWakeupRequests } from "./agent_wakeup_requests.js";

export const heartbeatRuns = pgTable(
  "heartbeat_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    invocationSource: text("invocation_source").notNull().default("on_demand"),
    triggerDetail: text("trigger_detail"),
    status: text("status").notNull().default("queued"),
    responsibleUserId: text("responsible_user_id"),
    // The service validates the company/run boundary; avoid a cyclic schema import.
    activeIdentityContextId: uuid("active_identity_context_id"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    // Set only after provider execution settles; never a timeout on thinking.
    executionControlDeadlineAt: timestamp("execution_control_deadline_at", { withTimezone: true }),
    // Transactional delivery marker. Null on historical rows; publication never replays provider work.
    executionStatusDeliveryId: uuid("execution_status_delivery_id"),
    error: text("error"),
    wakeupRequestId: uuid("wakeup_request_id").references(() => agentWakeupRequests.id),
    exitCode: integer("exit_code"),
    signal: text("signal"),
    usageJson: jsonb("usage_json").$type<Record<string, unknown>>(),
    resultJson: jsonb("result_json").$type<Record<string, unknown>>(),
    runtimeMode: text("runtime_mode").notNull().default("legacy"),
    runtimeModeResolverVersion: text("runtime_mode_resolver_version"),
    runtimeModeReason: text("runtime_mode_reason"),
    runtimeModeResolvedAt: timestamp("runtime_mode_resolved_at", { withTimezone: true }),
    runnerProfileJson: jsonb("runner_profile_json").$type<Record<string, unknown>>(),
    runnerInstanceId: uuid("runner_instance_id"),
    nativeSessionId: uuid("native_session_id"),
    nativeIssueId: uuid("native_issue_id"),
    driverKind: text("driver_kind"),
    driverVersion: text("driver_version"),
    completionContractId: uuid("completion_contract_id"),
    completionContractSha256: text("completion_contract_sha256"),
    nextEventSeq: bigint("next_event_seq", { mode: "number" }).notNull().default(1),
    nativePhase: text("native_phase"),
    nativePhaseUpdatedAt: timestamp("native_phase_updated_at", { withTimezone: true }),
    sessionIdBefore: text("session_id_before"),
    sessionIdAfter: text("session_id_after"),
    logStore: text("log_store"),
    logRef: text("log_ref"),
    logBytes: bigint("log_bytes", { mode: "number" }),
    logSha256: text("log_sha256"),
    logCompressed: boolean("log_compressed").notNull().default(false),
    stdoutExcerpt: text("stdout_excerpt"),
    stderrExcerpt: text("stderr_excerpt"),
    errorCode: text("error_code"),
    externalRunId: text("external_run_id"),
    // Legacy controller lease. A PID alone is not an identity across containers.
    controllerBootId: uuid("controller_boot_id"),
    controllerLeaseExpiresAt: timestamp("controller_lease_expires_at", { withTimezone: true }),
    executionStage: text("execution_stage"),
    processPid: integer("process_pid"),
    processGroupId: integer("process_group_id"),
    processStartedAt: timestamp("process_started_at", { withTimezone: true }),
    lastOutputAt: timestamp("last_output_at", { withTimezone: true }),
    lastOutputSeq: integer("last_output_seq").notNull().default(0),
    lastOutputStream: text("last_output_stream"),
    lastOutputBytes: bigint("last_output_bytes", { mode: "number" }),
    retryOfRunId: uuid("retry_of_run_id").references((): AnyPgColumn => heartbeatRuns.id, {
      onDelete: "set null",
    }),
    processLossRetryCount: integer("process_loss_retry_count").notNull().default(0),
    scheduledRetryAt: timestamp("scheduled_retry_at", { withTimezone: true }),
    scheduledRetryAttempt: integer("scheduled_retry_attempt").notNull().default(0),
    scheduledRetryReason: text("scheduled_retry_reason"),
    issueCommentStatus: text("issue_comment_status").notNull().default("not_applicable"),
    issueCommentSatisfiedByCommentId: uuid("issue_comment_satisfied_by_comment_id"),
    issueCommentRetryQueuedAt: timestamp("issue_comment_retry_queued_at", { withTimezone: true }),
    livenessState: text("liveness_state"),
    livenessReason: text("liveness_reason"),
    continuationAttempt: integer("continuation_attempt").notNull().default(0),
    lastUsefulActionAt: timestamp("last_useful_action_at", { withTimezone: true }),
    nextAction: text("next_action"),
    contextSnapshot: jsonb("context_snapshot").$type<Record<string, unknown>>(),
    // SPA-11865 — STORED generated columns let the failed-run attention feed
    // project issueId/taskId without dereferencing the 70 KB JSONB TOAST for
    // every row in the window. The companion covering btree (declared in
    // migration 9284 — Drizzle 0.45.2 has no .include() API) INCLUDEs these
    // two columns and lets the planner satisfy the query with an index-only
    // scan, eliminating the 2.6 GB de-TOAST stall that backed up the board
    // API on 2026-10-12.
    contextIssueId: text("context_issue_id").generatedAlwaysAs(
      (): SQL => sql`${heartbeatRuns.contextSnapshot} ->> 'issueId'`,
    ),
    contextTaskId: text("context_task_id").generatedAlwaysAs(
      (): SQL => sql`${heartbeatRuns.contextSnapshot} ->> 'taskId'`,
    ),
    // SPA-11947 — the two run-list projections the board polls on every
    // request (`activityService.runsForIssue` and `heartbeatService.list`)
    // return these context scalars. Same STORED-generated-column shape as the
    // two ids above, extended to the remaining keys those projections read so
    // neither has to dereference the wide JSONB TOAST document per row.
    contextTaskKey: text("context_task_key").generatedAlwaysAs(
      (): SQL => sql`${heartbeatRuns.contextSnapshot} ->> 'taskKey'`,
    ),
    contextCommentId: text("context_comment_id").generatedAlwaysAs(
      (): SQL => sql`${heartbeatRuns.contextSnapshot} ->> 'commentId'`,
    ),
    contextWakeCommentId: text("context_wake_comment_id").generatedAlwaysAs(
      (): SQL => sql`${heartbeatRuns.contextSnapshot} ->> 'wakeCommentId'`,
    ),
    // `->` (not `->>`): the ledger returns the wake-comment id ARRAY verbatim,
    // so the column holds the same JSONB value the old expression returned.
    contextWakeCommentIds: jsonb("context_wake_comment_ids")
      .$type<string[] | null>()
      .generatedAlwaysAs(
        (): SQL => sql`${heartbeatRuns.contextSnapshot} -> 'wakeCommentIds'`,
      ),
    contextWakeReason: text("context_wake_reason").generatedAlwaysAs(
      (): SQL => sql`${heartbeatRuns.contextSnapshot} ->> 'wakeReason'`,
    ),
    contextWakeSource: text("context_wake_source").generatedAlwaysAs(
      (): SQL => sql`${heartbeatRuns.contextSnapshot} ->> 'wakeSource'`,
    ),
    contextWakeTriggerDetail: text("context_wake_trigger_detail").generatedAlwaysAs(
      (): SQL => sql`${heartbeatRuns.contextSnapshot} ->> 'wakeTriggerDetail'`,
    ),
    // SPA-11947 — `heartbeatService.list`'s non-summary projection reads the
    // result scalars below with `left(..., HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS)`.
    // The columns store the UNTRUNCATED text so the bound stays owned by
    // server/src/services/heartbeat-run-summary.ts (this package must not
    // import from server); the projection keeps applying `left()` itself.
    resultListSummary: text("result_list_summary").generatedAlwaysAs(
      (): SQL => sql`${heartbeatRuns.resultJson} ->> 'summary'`,
    ),
    resultListResult: text("result_list_result").generatedAlwaysAs(
      (): SQL => sql`${heartbeatRuns.resultJson} ->> 'result'`,
    ),
    resultListMessage: text("result_list_message").generatedAlwaysAs(
      (): SQL => sql`${heartbeatRuns.resultJson} ->> 'message'`,
    ),
    resultListError: text("result_list_error").generatedAlwaysAs(
      (): SQL => sql`${heartbeatRuns.resultJson} ->> 'error'`,
    ),
    resultListTotalCostUsd: text("result_list_total_cost_usd").generatedAlwaysAs(
      (): SQL => sql`${heartbeatRuns.resultJson} ->> 'total_cost_usd'`,
    ),
    resultListCostUsd: text("result_list_cost_usd").generatedAlwaysAs(
      (): SQL => sql`${heartbeatRuns.resultJson} ->> 'cost_usd'`,
    ),
    resultListCostUsdCamel: text("result_list_cost_usd_camel").generatedAlwaysAs(
      (): SQL => sql`${heartbeatRuns.resultJson} ->> 'costUsd'`,
    ),
    // SPA-11947 — `activityService.runsForIssue` returns a narrowed result
    // summary. The poll reads this one narrow JSONB column instead of
    // de-TOASTing `result_json` for every run in the window, and the stored
    // value is byte-for-byte what the per-row expression used to return.
    //
    // The obvious spelling of that expression —
    // jsonb_strip_nulls(jsonb_build_object(...)) — is NOT usable here: both
    // functions are STABLE rather than IMMUTABLE, and PostgreSQL rejects a
    // STORED generated column whose expression is not immutable (SQLSTATE
    // 42P17, observed when this migration was applied inside the
    // embedded-Postgres test cluster). Wrapping them in a function marked
    // IMMUTABLE would assert a false fact to the planner.
    //
    // So the object is assembled from pieces PostgreSQL does classify as
    // IMMUTABLE: the jsonb operators (-> and ->>), jsonb_set, and jsonb
    // concatenation (||). Each key contributes either a single-key object or
    // '{}', and the fragments are concatenated:
    //
    //   * SQL NULL (key absent) and the JSON literal null (key present with a
    //     null value) both contribute '{}', i.e. the key is omitted — the same
    //     result jsonb_strip_nulls produced, reached with an equality test
    //     against 'null'::jsonb instead of a call to jsonb_strip_nulls.
    //   * Every surviving value is written verbatim by jsonb_set, so scalars,
    //     arrays and nested objects are preserved unchanged.
    //
    // Inherited behaviour worth knowing (not introduced here): `->` on a key
    // that is present with a JSON null returns the jsonb value null, not SQL
    // NULL, so coalesce does NOT fall through to the snake_case alias and the
    // null is then omitted.
    resultLedgerSummary: jsonb("result_ledger_summary")
      .$type<Record<string, unknown> | null>()
      .generatedAlwaysAs(
        (): SQL => sql`
        case
          when ${heartbeatRuns.resultJson} is null then null
          else
            case when (${heartbeatRuns.resultJson} -> 'conversationReset') is null or (${heartbeatRuns.resultJson} -> 'conversationReset') = 'null'::jsonb then '{}'::jsonb else jsonb_set('{}'::jsonb, '{conversationReset}', ${heartbeatRuns.resultJson} -> 'conversationReset', true) end
            || case when (coalesce(${heartbeatRuns.resultJson} -> 'billingType', ${heartbeatRuns.resultJson} -> 'billing_type')) is null or (coalesce(${heartbeatRuns.resultJson} -> 'billingType', ${heartbeatRuns.resultJson} -> 'billing_type')) = 'null'::jsonb then '{}'::jsonb else jsonb_set('{}'::jsonb, '{billingType}', coalesce(${heartbeatRuns.resultJson} -> 'billingType', ${heartbeatRuns.resultJson} -> 'billing_type'), true) end
            || case when (coalesce(${heartbeatRuns.resultJson} -> 'billing_type', ${heartbeatRuns.resultJson} -> 'billingType')) is null or (coalesce(${heartbeatRuns.resultJson} -> 'billing_type', ${heartbeatRuns.resultJson} -> 'billingType')) = 'null'::jsonb then '{}'::jsonb else jsonb_set('{}'::jsonb, '{billing_type}', coalesce(${heartbeatRuns.resultJson} -> 'billing_type', ${heartbeatRuns.resultJson} -> 'billingType'), true) end
            || case when (coalesce(${heartbeatRuns.resultJson} -> 'costUsd', ${heartbeatRuns.resultJson} -> 'cost_usd', ${heartbeatRuns.resultJson} -> 'total_cost_usd')) is null or (coalesce(${heartbeatRuns.resultJson} -> 'costUsd', ${heartbeatRuns.resultJson} -> 'cost_usd', ${heartbeatRuns.resultJson} -> 'total_cost_usd')) = 'null'::jsonb then '{}'::jsonb else jsonb_set('{}'::jsonb, '{costUsd}', coalesce(${heartbeatRuns.resultJson} -> 'costUsd', ${heartbeatRuns.resultJson} -> 'cost_usd', ${heartbeatRuns.resultJson} -> 'total_cost_usd'), true) end
            || case when (coalesce(${heartbeatRuns.resultJson} -> 'cost_usd', ${heartbeatRuns.resultJson} -> 'costUsd', ${heartbeatRuns.resultJson} -> 'total_cost_usd')) is null or (coalesce(${heartbeatRuns.resultJson} -> 'cost_usd', ${heartbeatRuns.resultJson} -> 'costUsd', ${heartbeatRuns.resultJson} -> 'total_cost_usd')) = 'null'::jsonb then '{}'::jsonb else jsonb_set('{}'::jsonb, '{cost_usd}', coalesce(${heartbeatRuns.resultJson} -> 'cost_usd', ${heartbeatRuns.resultJson} -> 'costUsd', ${heartbeatRuns.resultJson} -> 'total_cost_usd'), true) end
            || case when (coalesce(${heartbeatRuns.resultJson} -> 'total_cost_usd', ${heartbeatRuns.resultJson} -> 'cost_usd', ${heartbeatRuns.resultJson} -> 'costUsd')) is null or (coalesce(${heartbeatRuns.resultJson} -> 'total_cost_usd', ${heartbeatRuns.resultJson} -> 'cost_usd', ${heartbeatRuns.resultJson} -> 'costUsd')) = 'null'::jsonb then '{}'::jsonb else jsonb_set('{}'::jsonb, '{total_cost_usd}', coalesce(${heartbeatRuns.resultJson} -> 'total_cost_usd', ${heartbeatRuns.resultJson} -> 'cost_usd', ${heartbeatRuns.resultJson} -> 'costUsd'), true) end
            || case when (${heartbeatRuns.resultJson} -> 'stopReason') is null or (${heartbeatRuns.resultJson} -> 'stopReason') = 'null'::jsonb then '{}'::jsonb else jsonb_set('{}'::jsonb, '{stopReason}', ${heartbeatRuns.resultJson} -> 'stopReason', true) end
            || case when (${heartbeatRuns.resultJson} -> 'effectiveTimeoutSec') is null or (${heartbeatRuns.resultJson} -> 'effectiveTimeoutSec') = 'null'::jsonb then '{}'::jsonb else jsonb_set('{}'::jsonb, '{effectiveTimeoutSec}', ${heartbeatRuns.resultJson} -> 'effectiveTimeoutSec', true) end
            || case when (${heartbeatRuns.resultJson} -> 'effectiveTimeoutMs') is null or (${heartbeatRuns.resultJson} -> 'effectiveTimeoutMs') = 'null'::jsonb then '{}'::jsonb else jsonb_set('{}'::jsonb, '{effectiveTimeoutMs}', ${heartbeatRuns.resultJson} -> 'effectiveTimeoutMs', true) end
            || case when (${heartbeatRuns.resultJson} -> 'timeoutConfigured') is null or (${heartbeatRuns.resultJson} -> 'timeoutConfigured') = 'null'::jsonb then '{}'::jsonb else jsonb_set('{}'::jsonb, '{timeoutConfigured}', ${heartbeatRuns.resultJson} -> 'timeoutConfigured', true) end
            || case when (${heartbeatRuns.resultJson} -> 'timeoutSource') is null or (${heartbeatRuns.resultJson} -> 'timeoutSource') = 'null'::jsonb then '{}'::jsonb else jsonb_set('{}'::jsonb, '{timeoutSource}', ${heartbeatRuns.resultJson} -> 'timeoutSource', true) end
            || case when (${heartbeatRuns.resultJson} -> 'timeoutFired') is null or (${heartbeatRuns.resultJson} -> 'timeoutFired') = 'null'::jsonb then '{}'::jsonb else jsonb_set('{}'::jsonb, '{timeoutFired}', ${heartbeatRuns.resultJson} -> 'timeoutFired', true) end
        end
      `,
      ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    executionStatusDeliveryIdx: index("heartbeat_runs_execution_status_delivery_idx")
      .on(table.executionStatusDeliveryId).where(sql`${table.executionStatusDeliveryId} is not null`),
    executionControlDeadlineIdx: index("heartbeat_runs_execution_control_deadline_idx")
      .on(table.executionControlDeadlineAt).where(sql`${table.executionControlDeadlineAt} is not null`),
    nativeReplacementPredecessorUq: uniqueIndex("heartbeat_runs_native_replacement_predecessor_uq")
      .on(table.companyId, table.retryOfRunId)
      .where(sql`${table.scheduledRetryReason} = 'native_safe_replacement'`),
    companyNativeIssueRunUq: unique("heartbeat_runs_company_native_issue_id_uq").on(
      table.companyId,
      table.nativeIssueId,
      table.id,
    ),
    companyNativeIssueRunContractUq: unique(
      "heartbeat_runs_company_native_issue_contract_id_uq",
    ).on(
      table.companyId,
      table.nativeIssueId,
      table.id,
      table.completionContractId,
    ),
    companyAgentStartedIdx: index("heartbeat_runs_company_agent_started_idx").on(
      table.companyId,
      table.agentId,
      table.startedAt,
    ),
    companyResponsibleUserIdx: index("heartbeat_runs_company_responsible_user_idx").on(
      table.companyId,
      table.responsibleUserId,
      table.createdAt,
    ),
    companyLivenessIdx: index("heartbeat_runs_company_liveness_idx").on(
      table.companyId,
      table.livenessState,
      table.createdAt,
    ),
    companyMissingTerminalLivenessIdx: index("heartbeat_runs_company_missing_terminal_liveness_idx")
      .on(table.companyId)
      .where(sql`${table.livenessState} is null and ${table.status} not in ('queued', 'running')`),
    companyStatusLastOutputIdx: index("heartbeat_runs_company_status_last_output_idx").on(
      table.companyId,
      table.status,
      table.lastOutputAt,
    ),
    companyStatusProcessStartedIdx: index("heartbeat_runs_company_status_process_started_idx").on(
      table.companyId,
      table.status,
      table.processStartedAt,
    ),
    companyCreatedAtDescIdx: index("heartbeat_runs_company_created_at_desc_idx").on(
      table.companyId,
      table.createdAt.desc(),
    ),
    companyCtxIssueCreatedIdx: index("heartbeat_runs_company_ctx_issue_created_idx").on(
      table.companyId,
      sql`(${table.contextSnapshot} ->> 'issueId')`,
      table.createdAt.desc(),
    ),
    companyCtxTaskCreatedIdx: index("heartbeat_runs_company_ctx_task_created_idx").on(
      table.companyId,
      sql`(${table.contextSnapshot} ->> 'taskId')`,
      table.createdAt.desc(),
    ),
    companyCtxTaskKeyCreatedIdx: index("heartbeat_runs_company_ctx_taskkey_created_idx").on(
      table.companyId,
      sql`(${table.contextSnapshot} ->> 'taskKey')`,
      table.createdAt.desc(),
    ),
  }),
);
