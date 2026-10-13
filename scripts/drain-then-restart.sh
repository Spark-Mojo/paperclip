#!/usr/bin/env bash
# drain-then-restart.sh — the ONE sanctioned way to restart paperclip.service
# (SPA-12085, James ruling 2026-10-13: engine restarts killed 20+ runs each).
#
# Sequence: record the fleet cap -> PATCH it to 0 (pause admissions; running
# runs are never killed) -> wait until the live process reports zero in-flight
# runs -> restart the service -> probe the board UI (GET /) and health
# (GET /api/health) so a UI-less install fails loudly (SPA-11913) -> restore
# the recorded cap -> verify the restore.
#
# A drain timeout names the still-live runs and exits NONZERO. It never
# force-kills anything: no SIGKILL, no SIGTERM to runs, no `systemctl kill`.
# The restart itself is the only destructive act, and it happens only after a
# clean drain.
#
# Only the monitor session's daily drained window should run this. Agents must
# NOT restart paperclip.service by hand (see skills/paperclip/SKILL.md,
# "Engine restarts and installs" on the Spark Mojo fleet).
#
# Usage:
#   scripts/drain-then-restart.sh [--dry-run] [--stub] [options]
#
# Options:
#   --dry-run             Print every step, execute nothing destructive.
#   --stub                Canned API/service responses from $DRAIN_STUB_FIXTURE
#                         (JSON). For tests and dry-runs only; refuses a real
#                         restart while set.
#   --api-url URL         Paperclip API base (default $PAPERCLIP_API_URL).
#   --api-token TOKEN     Board/admin bearer token (default $PAPERCLIP_API_KEY).
#   --service NAME        systemd unit to restart (default paperclip.service).
#   --timeout-seconds N   Drain budget before a nonzero, run-listing abort
#                         (default 1800).
#   --poll-seconds N      Seconds between drain polls (default 15).
#   --skip-restart        Record cap, pause, drain, then restore without
#                         restarting (drain rehearsal).
set -euo pipefail

DRY_RUN=0
STUB=0
SKIP_RESTART=0
API_URL="${PAPERCLIP_API_URL:-http://127.0.0.1:3100}"
API_TOKEN="${PAPERCLIP_API_KEY:-}"
SERVICE_NAME="paperclip.service"
TIMEOUT_SECONDS=1800
POLL_SECONDS=15

log() { printf '[drain-then-restart] %s\n' "$*"; }
die() { printf '[drain-then-restart] ERROR: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --stub) STUB=1 ;;
    --skip-restart) SKIP_RESTART=1 ;;
    --api-url) API_URL="${2:?}"; shift ;;
    --api-token) API_TOKEN="${2:?}"; shift ;;
    --service) SERVICE_NAME="${2:?}"; shift ;;
    --timeout-seconds) TIMEOUT_SECONDS="${2:?}"; shift ;;
    --poll-seconds) POLL_SECONDS="${2:?}"; shift ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

FLEET_CAP_PATH="/api/instance/settings/fleet-max-concurrent-runs"
TASK_DRAIN_PATH="/api/instance/task-drain"

# --- transport ------------------------------------------------------------

stub_field() {
  # stub_field <dotted.key> — read a (dotted-path) value out of the stub
  # fixture JSON. Exit 3 when absent, so a malformed fixture fails loudly.
  node -e '
    const fs = require("fs");
    const fix = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const value = process.argv[2].split(".").reduce((acc, part) => (acc == null ? acc : acc[part]), fix);
    if (value === undefined) process.exit(3);
    process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
  ' "${DRAIN_STUB_FIXTURE:?DRAIN_STUB_FIXTURE required with --stub}" "$1"
}

stub_step() {
  # A stub run walks fixture keys cap.before / cap.after, drain.quiescent
  # (a number: remaining polls before quiescent), ui.probe, health.probe,
  # restore.ok, drain.stuck_run_ids (JSON array for the timeout case).
  case "$1" in
    cap-before)
      local before
      before="$(stub_field "cap.before")"
      printf '{"value":%s,"source":"stub"}' "$before"
      ;;
    cap-after-pause)
      local after
      after="$(stub_field "cap.afterPause")"
      printf '{"value":%s,"source":"stub"}' "$after"
      ;;
    task-drain)
      local remain
      remain="$(stub_field "drain.quiescentAfter")"
      if [ "$remain" -gt 0 ] 2>/dev/null; then
        node -e '
          const fs = require("fs");
          const fix = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
          fix.drain.quiescentAfter -= 1;
          fs.writeFileSync(process.argv[1], JSON.stringify(fix, null, 2));
        ' "${DRAIN_STUB_FIXTURE:?}"
        printf '{"draining":false,"activeRuns":%s,"pendingWakes":0,"quiescent":false}' "$remain"
      else
        printf '{"draining":false,"activeRuns":0,"pendingWakes":0,"quiescent":true}'
      fi
      ;;
    live-runs) stub_field "drain.stuckRunIds" ;;
    ui-probe) stub_field "ui.body" ;;
    health-probe) stub_field "health.body" ;;
    restore)
      local restored
      restored="$(stub_field "restore.status")"
      printf '{"value":%s,"source":"stub"}' "$restored"
      ;;
    *) die "stub step not modelled: $1" ;;
  esac
}

# api <METHOD> <PATH> [BODY] — prints the response body; exits nonzero on a
# non-2xx. The exit code (not prose) is the contract every caller checks.
api() {
  local method="$1" path="$2" body="${3:-}"
  if [ "$STUB" = "1" ]; then
    case "$path" in
      "$FLEET_CAP_PATH")
        if [ "$method" = "GET" ]; then stub_step cap-before; return 0; fi
        if [ "$method" = "PATCH" ]; then
          # Body-based phase dispatch: api() runs inside command substitution
          # (a subshell), so an in-memory call counter cannot survive between
          # calls. The pause PATCH is exactly {"value":0}; the restore PATCH
          # carries the recorded value. When the recorded cap IS 0 the two
          # bodies are identical and both must serve 0 — which is correct.
          if [ "$body" = '{"value":0}' ]; then
            stub_step cap-after-pause
          else
            stub_step restore
          fi
          return 0
        fi
        ;;
      "$TASK_DRAIN_PATH") [ "$method" = "GET" ] && { stub_step task-drain; return 0; } ;;
    esac
    die "stub cannot serve $method $path"
  fi
  [ -n "$API_TOKEN" ] || die "no API token: pass --api-token or set PAPERCLIP_API_KEY"
  local args=(-sS -o /dev/null -w '%{http_code}' -X "$method"
    -H "Authorization: Bearer $API_TOKEN"
    -H 'Content-Type: application/json')
  [ -n "$body" ] && args+=(-d "$body")
  local code
  code="$(curl "${args[@]}" "$API_URL$path")" || die "curl failed for $method $path"
  case "$code" in 2*) ;; *) die "API $method $path -> HTTP $code" ;; esac
  curl -sS -X "$method" -H "Authorization: Bearer $API_TOKEN" \
    -H 'Content-Type: application/json' ${body:+-d "$body"} "$API_URL$path"
}

json_field() {
  # json_field <JSON> <key> -> raw value (number, string, or JSON fragment).
  # With `node -e`, user args start at argv[1] (there is no script file entry).
  node -e '
    const [input, key] = process.argv.slice(1);
    const parsed = JSON.parse(input);
    const value = key.split(".").reduce((acc, part) => (acc == null ? acc : acc[part]), parsed);
    if (value === undefined) process.exit(3);
    process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
  ' "$1" "$2"
}

# restart_service — the ONLY destructive call in this script.
restart_service() {
  # DRY-RUN is the most conservative claim, so it wins over STUB's line.
  if [ "$DRY_RUN" = "1" ]; then
    log "DRY-RUN: would run: systemctl --user restart $SERVICE_NAME"
    return 0
  fi
  if [ "$STUB" = "1" ]; then
    log "STUB: would run: systemctl --user restart $SERVICE_NAME"
    return 0
  fi
  log "restarting $SERVICE_NAME"
  systemctl --user restart "$SERVICE_NAME"
}

# probe <PATH> <EXPECTED-SUBSTRING> <LABEL> — fails loudly on a miss.
probe() {
  local path="$1" expect="$2" label="$3" body=""
  if [ "$STUB" = "1" ]; then
    case "$path" in
      /) body="$(stub_step ui-probe)" ;;
      /api/health) body="$(stub_step health-probe)" ;;
    esac
  elif [ "$DRY_RUN" = "1" ]; then
    log "DRY-RUN: would probe GET $path for '$expect'"
    return 0
  else
    body="$(curl -sS --max-time 10 "$API_URL$path")" || body=""
  fi
  case "$body" in
    *"$expect"*) log "probe OK: $label" ;;
    *)
      printf '[drain-then-restart] ERROR: probe FAILED: GET %s (%s) is missing %s\n' \
        "$path" "$label" "$expect" >&2
      printf '%s\n' "--- response head ---" >&2
      printf '%s\n' "${body:0:400}" >&2
      exit 1
      ;;
  esac
}

# --- steps ----------------------------------------------------------------

log "step 1/5: record current fleet cap"
CAP_BEFORE_JSON="$(api GET "$FLEET_CAP_PATH")"
CAP_BEFORE_VALUE="$(json_field "$CAP_BEFORE_JSON" value)"
CAP_BEFORE_SOURCE="$(json_field "$CAP_BEFORE_JSON" source)"
log "recorded cap: value=$CAP_BEFORE_VALUE source=$CAP_BEFORE_SOURCE"
# "none" (null) means no ceiling; restore must re-apply null, not 0.
if [ "$CAP_BEFORE_VALUE" = "null" ]; then
  RESTORE_BODY='{"value":null}'
  RESTORE_EXPECT="null"
else
  RESTORE_BODY="{\"value\":$CAP_BEFORE_VALUE}"
  RESTORE_EXPECT="$CAP_BEFORE_VALUE"
fi

log "step 2/5: pause admissions (fleet cap -> 0)"
if [ "$DRY_RUN" = "1" ]; then
  log "DRY-RUN: would PATCH $FLEET_CAP_PATH {\"value\":0}"
else
  PAUSED_JSON="$(api PATCH "$FLEET_CAP_PATH" '{"value":0}')"
  PAUSED_VALUE="$(json_field "$PAUSED_JSON" value)"
  [ "$PAUSED_VALUE" = "0" ] || die "pause did not land: effective cap is $PAUSED_VALUE"
  log "admissions paused (cap=0). Running runs are NOT touched; queued stays queued."
fi

log "step 3/5: waiting for in-flight runs to finish (timeout ${TIMEOUT_SECONDS}s)"
DEADLINE=$(( $(date +%s) + TIMEOUT_SECONDS ))
while :; do
  DRAIN_JSON="$(api GET "$TASK_DRAIN_PATH")"
  ACTIVE_RUNS="$(json_field "$DRAIN_JSON" activeRuns)"
  PENDING_WAKES="$(json_field "$DRAIN_JSON" pendingWakes)"
  if [ "$ACTIVE_RUNS" = "0" ] && [ "$PENDING_WAKES" = "0" ]; then
    log "drained: 0 active runs, 0 pending wakes."
    break
  fi
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    log "DRAIN TIMEOUT after ${TIMEOUT_SECONDS}s: activeRuns=$ACTIVE_RUNS pendingWakes=$PENDING_WAKES"
    log "still-live runs (NOT killed — resolve them, then re-run this command):"
    if [ "$STUB" = "1" ]; then
      stub_step live-runs
    else
      # Best-effort run listing across companies; the drain verdict above is
      # authoritative, this is the operator's "which runs" answer.
      COMPANIES_JSON="$(curl -sS -H "Authorization: Bearer $API_TOKEN" "$API_URL/api/companies" || true)"
      for COMPANY_ID in $(json_field "$COMPANIES_JSON" 2>/dev/null | node -e '
        let input = "";
        process.stdin.on("data", (c) => (input += c));
        process.stdin.on("end", () => {
          try {
            const rows = JSON.parse(input);
            for (const row of Array.isArray(rows) ? rows : rows.items ?? []) {
              if (row && row.id) process.stdout.write(row.id + "\n");
            }
          } catch { /* listing is best-effort */ }
        });
      ' 2>/dev/null); do
        # shellcheck disable=SC2016  # the node program is intentionally single-quoted
        curl -sS -H "Authorization: Bearer $API_TOKEN" \
          "$API_URL/api/companies/$COMPANY_ID/live-runs" 2>/dev/null | node -e '
          let input = "";
          process.stdin.on("data", (c) => (input += c));
          process.stdin.on("end", () => {
            try {
              for (const run of JSON.parse(input)) {
                if (run && (run.status === "running" || run.status === "queued")) {
                  process.stdout.write(`${run.status}\t${run.id}\t${run.agentId ?? ""}\t${run.issueId ?? ""}\n`);
                }
              }
            } catch { /* best-effort */ }
          });
        ' 2>/dev/null || true
      done
    fi
    log "restoring the recorded cap before exiting so the fleet resumes by itself"
    api PATCH "$FLEET_CAP_PATH" "$RESTORE_BODY" >/dev/null \
      || log "WARNING: cap restore failed after timeout; restore manually with: curl -X PATCH -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' -d '$RESTORE_BODY' $API_URL$FLEET_CAP_PATH"
    die "drain timeout: runs still live; nothing was restarted, nothing was killed"
  fi
  sleep "$POLL_SECONDS"
done

log "step 4/5: restart"
if [ "$SKIP_RESTART" = "1" ]; then
  log "SKIP_RESTART: skipping the service restart (drain rehearsal)"
else
  restart_service
  if [ "$DRY_RUN" = "0" ] && [ "$STUB" = "0" ]; then
    log "waiting for the service to come back"
    WAITED=0
    until curl -sS --max-time 5 -o /dev/null "$API_URL/api/health" 2>/dev/null; do
      WAITED=$((WAITED + 2))
      [ "$WAITED" -ge 120 ] && die "service did not come back within 120s"
      sleep 2
    done
  fi
fi

log "step 5/5: probes (UI + health), then restore the recorded cap"
# SPA-11913: a UI-less install must fail loudly here, not 404 the board.
probe "/" 'id="root"' "board UI served"
probe "/api/health" '"status"' "health endpoint"

if [ "$DRY_RUN" = "1" ]; then
  log "DRY-RUN: would PATCH $FLEET_CAP_PATH $RESTORE_BODY"
else
  RESTORED_JSON="$(api PATCH "$FLEET_CAP_PATH" "$RESTORE_BODY")"
  RESTORED_VALUE="$(json_field "$RESTORED_JSON" value)"
  [ "$RESTORED_VALUE" = "$RESTORE_EXPECT" ] \
    || die "cap restore did not land: expected $RESTORE_EXPECT, got $RESTORED_VALUE (fix with: curl -X PATCH -d '$RESTORE_BODY' $API_URL$FLEET_CAP_PATH)"
  log "cap restored to value=$RESTORED_VALUE (source: $(json_field "$RESTORED_JSON" source))"
fi

log "DONE: drained restart complete. Queued wakes admit again from the restored cap."
