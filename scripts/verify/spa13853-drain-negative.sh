#!/usr/bin/env bash
# SPA-13853 g17 — mutation-based NEGATIVE control for the heartbeat stall E2E
# fixture (server/src/__tests__/heartbeat-stall-e2e.test.ts, commit ad0d7f5f2).
#
# Proves scenario B actually detects the loss of the onLog drain bound: this
# script mutates server/src/services/heartbeat.ts so the bound can no longer
# drop a hung persist in test time — BOTH return paths of
# resolveOnLogDrainTimeoutMs are scaled x1000 (the 3000 default literal, and
# the env-resolved `Math.floor(parsed)`; scenario B sets
# PAPERCLIP_ONLOG_TIMEOUT_MS=150 via withEnv, so it exercises the env path —
# mutating only the 3000 literal would leave scenario B green) — then re-runs
# the fixture. The file is restored via trap on EXIT (including Ctrl-C).
#
# Exit codes: 0 = mutation NOT caught (fixture vacuous — BAD outcome)
#             1 = mutation caught, failure confined to scenario B (GOOD — the
#                 gate expects exit 1)
#             2 = environment/setup error (mutate failed, vitest missing,
#                 failure not confined to scenario B) — distinct code, never
#                 conflated with 0 or 1.
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TARGET="$ROOT/server/src/services/heartbeat.ts"
FIXTURE="$ROOT/server/src/__tests__/heartbeat-stall-e2e.test.ts"
PAT_DEFAULT='export const ONLOG_DRAIN_TIMEOUT_MS = 3000;'
MUT_DEFAULT='export const ONLOG_DRAIN_TIMEOUT_MS = 3000000;'
PAT_ENVPATH='return Math.floor(parsed);'
MUT_ENVPATH='return Math.floor(parsed) * 1000;'

TMP="$(mktemp -d "${TMPDIR:-/tmp}/spa13853-negative.XXXXXX")"
SAVED="$TMP/heartbeat.ts.saved"
LOG="$TMP/vitest.log"
CLEAN="$TMP/vitest.log.clean"

cleanup() {
  # Restore the mutated file and VERIFY restoration byte-for-byte; the tree
  # must never be left mutated, even on Ctrl-C. On verification failure the
  # saved copy is KEPT for manual recovery.
  if [ -f "$SAVED" ]; then
    cp "$SAVED" "$TARGET"
    if cmp -s "$SAVED" "$TARGET"; then
      rm -rf "$TMP"
    else
      # An exit inside the EXIT trap overrides the pending status, so a
      # not-caught run can no longer exit 0 (nor a caught run exit 1) while
      # heartbeat.ts sits mutated. Saved copy KEPT for manual recovery.
      echo "SPA13853-NEGATIVE: env-error (FATAL: restoration verification failed; saved copy kept at $SAVED)" >&2
      exit 2
    fi
  else
    rm -rf "$TMP"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

env_err() {
  echo "SPA13853-NEGATIVE: env-error ($1)" >&2
  exit 2
}

# --- preflight: each fallible stage's status checked separately (fail-closed) ---
[ -f "$TARGET" ] || env_err "missing $TARGET"
[ -f "$FIXTURE" ] || env_err "missing $FIXTURE"
command -v pnpm >/dev/null 2>&1 || env_err "pnpm not on PATH"
[ -x "$ROOT/node_modules/.bin/vitest" ] || env_err "vitest not installed at $ROOT/node_modules/.bin/vitest"

cp "$TARGET" "$SAVED" || env_err "could not save a copy of heartbeat.ts"
cmp -s "$SAVED" "$TARGET" || env_err "saved copy differs from target before mutation"

# --- pre-mutation uniqueness: mutate only the literal we meant to ---
n_default="$(grep -cF "$PAT_DEFAULT" "$TARGET")"
[ "$n_default" = "1" ] || env_err "default-literal pattern count=$n_default (expected 1)"
n_envpath="$(grep -cF "$PAT_ENVPATH" "$TARGET")"
[ "$n_envpath" = "1" ] || env_err "env-path pattern count=$n_envpath (expected 1)"

# --- pre-mutation baseline: the fixture must be GREEN on the UNMUTATED tree,
# else an inherently-red scenario B would masquerade as "caught" once the
# mutation lands. Same focused selection, foreground, under timeout. ---
cd "$ROOT" || env_err "cannot cd to repo root"
timeout 300 pnpm vitest run server/src/__tests__/heartbeat-stall-e2e.test.ts >"$LOG" 2>&1
baseline_rc=$?
echo "baseline: pnpm vitest run server/src/__tests__/heartbeat-stall-e2e.test.ts (exit $baseline_rc)"
if [ "$baseline_rc" -ne 0 ]; then
  sed 's/\x1b\[[0-9;]*[a-zA-Z]//g' "$LOG" >"$CLEAN" || env_err "ansi strip failed (baseline log)"
  env_err "scenario B red before mutation — masquerade risk (baseline exit $baseline_rc); last lines:
$(tail -n 20 "$CLEAN")"
fi

# --- mutation: resolveOnLogDrainTimeoutMs can no longer return a bound that
# fires in test time. Scenario B (env=150 -> 150000ms; default 3000 -> 3e6)
# then never drops the hung persist at the bound: progress_flush_dropped
# never lands, stdout stops draining, and scenario B's assertions fail. ---
sed -i "s/$PAT_DEFAULT/$MUT_DEFAULT/" "$TARGET" || env_err "sed (default literal) failed"
sed -i "s/$PAT_ENVPATH/$MUT_ENVPATH/" "$TARGET" || env_err "sed (env path) failed"
[ "$(grep -cF "$MUT_DEFAULT" "$TARGET")" = "1" ] || env_err "default mutation not applied"
[ "$(grep -cF "$MUT_ENVPATH" "$TARGET")" = "1" ] || env_err "env-path mutation not applied"
[ "$(grep -cF "$PAT_DEFAULT" "$TARGET")" = "0" ] || env_err "original default literal still present after mutation"
[ "$(grep -cF "$PAT_ENVPATH" "$TARGET")" = "0" ] || env_err "original env-path return still present after mutation"
echo "mutation applied: ONLOG_DRAIN_TIMEOUT_MS 3000 -> 3000000; resolveOnLogDrainTimeoutMs env return Math.floor(parsed) -> Math.floor(parsed) * 1000 (bound can no longer drop a hung persist in test time)"

# --- run ONLY the focused selection: foreground, under timeout, output to a
# file, exit status captured separately (no pipeline, so no fail-open). ---
cd "$ROOT" || env_err "cannot cd to repo root"
timeout 300 pnpm vitest run server/src/__tests__/heartbeat-stall-e2e.test.ts >"$LOG" 2>&1
vitest_rc=$?
echo "selection: pnpm vitest run server/src/__tests__/heartbeat-stall-e2e.test.ts (exit $vitest_rc)"

sed 's/\x1b\[[0-9;]*[a-zA-Z]//g' "$LOG" >"$CLEAN" || env_err "ansi strip failed"

if [ "$vitest_rc" -eq 0 ]; then
  echo "SPA13853-NEGATIVE: not-caught (fixture passed under mutation — scenario B does not detect the lost bound)"
  exit 0
fi

# A failure counts as CAUGHT only if it is IN scenario B and ONLY there.
# Any scenario A failure means the mutation hit an unintended path (env error).
b_line="$(grep -m1 -E '(FAIL|✕|×|✗).*scenario B|scenario B.*(FAIL|✕|×|✗)' "$CLEAN")"
a_fail="$(grep -m1 -E '(FAIL|✕|×|✗).*scenario A|scenario A.*(FAIL|✕|×|✗)' "$CLEAN")"
if [ -n "$b_line" ] && [ -z "$a_fail" ]; then
  echo "failing test: $b_line"
  echo "SPA13853-NEGATIVE: caught"
  exit 1
fi
if [ -n "$a_fail" ]; then
  echo "unexpected failure outside scenario B: $a_fail" >&2
  echo "--- last 20 lines of vitest output ---" >&2
  tail -n 20 "$CLEAN" >&2
fi
env_err "vitest exited $vitest_rc without a scenario-B failure; last lines:
$(tail -n 20 "$CLEAN")"
