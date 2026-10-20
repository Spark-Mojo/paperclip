#!/usr/bin/env bash
# SPA-13888 oracle item 5 — mutation-based NEGATIVE control for the choke-point
# PATCH builder ban (server/src/services/issue-execution-policy.ts) as exercised
# by the two ban tests in
# server/src/__tests__/issue-patch-stage-decision-ban.test.ts.
#
# Proves the ban tests actually detect the loss of the ban: this script reverts
# the ban block (the `if (principalsEqual(currentParticipant, actor))` branch's
# returnAssignee-keyed throw + createdBy fallback, anchored by the comment
# carrying `Mirrors issue-stage-decisions.`) — then re-runs the ban suite. BOTH
# ban tests must FAIL. The file is restored byte-equal via an explicit restore
# step AND a trap on EXIT (including Ctrl-C), so the tree is never left mutated.
#
# Fail-closed by construction: every fallible stage's status is checked
# separately; the suite passing (or skipping) under the revert is a FAILURE of
# this script, never a pass. Exit 0 is printed ONLY as the final line
# `NEGCTL:RED-CONFIRMED` after restoration is verified.
#
# Exit codes: 0 = revert NOT caught is impossible here — 0 means both ban tests
#                 failed under the revert AND the file was restored byte-equal
#                 (GOOD — the negative control held)
#             1 = NEGCTL:FAILED (control failure: revert not applied, suite
#                 green/skipped under revert, titles missing, ...)
#             2 = NEGCTL:FAILED restoration failure — saved copy KEPT for
#                 manual recovery, never conflated with 0 or 1.
set -u

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "NEGCTL:FAILED not inside a git work tree" >&2
  exit 1
}
cd "$ROOT" || {
  echo "NEGCTL:FAILED cannot cd to $ROOT" >&2
  exit 1
}

TARGET="server/src/services/issue-execution-policy.ts"
TEST_SPEC="src/__tests__/issue-patch-stage-decision-ban.test.ts"
BAN_MSG='The card builder cannot record a stage decision'
TITLE1='PATCH done by the builder misconfigured as participant is forbidden'
TITLE2='PATCH done by the creator on a legacy null-returnAssignee card is forbidden'

TMP="$(mktemp -d "${TMPDIR:-/tmp}/spa13888-negctl.XXXXXX")" || {
  echo "NEGCTL:FAILED mktemp -d failed" >&2
  exit 1
}
SAVED="$TMP/issue-execution-policy.ts.saved"
LOG="$TMP/vitest.log"
CLEAN="$TMP/vitest.log.clean"

fail() {
  echo "NEGCTL:FAILED $1" >&2
  exit 1
}

cleanup() {
  # Restore the mutated file and VERIFY restoration byte-for-byte; the tree
  # must never be left mutated, even on Ctrl-C. On the success path SAVED is
  # already consumed by the explicit restore below, so this is a no-op. On
  # verification failure the saved copy is KEPT for manual recovery; an exit
  # inside the EXIT trap overrides the pending status, so no path exits 0 (or
  # 1 as a "control" outcome) while issue-execution-policy.ts sits mutated.
  if [ -f "$SAVED" ]; then
    cp "$SAVED" "$TARGET" || {
      echo "NEGCTL:FAILED restoration cp failed; saved copy kept at $SAVED" >&2
      exit 2
    }
    if cmp -s "$SAVED" "$TARGET"; then
      rm -rf "$TMP"
    else
      echo "NEGCTL:FAILED restoration verification failed (byte mismatch); saved copy kept at $SAVED" >&2
      exit 2
    fi
  else
    rm -rf "$TMP"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# --- preflight: each fallible stage's status checked separately (fail-closed) ---
[ -f "$TARGET" ] || fail "missing $TARGET"
command -v pnpm >/dev/null 2>&1 || fail "pnpm not on PATH"
[ -x "$ROOT/node_modules/.bin/vitest" ] || [ -x "$ROOT/server/node_modules/.bin/vitest" ] ||
  fail "vitest not installed (node_modules/.bin/vitest)"

cp "$TARGET" "$SAVED" || fail "could not save a copy of $TARGET"
cmp -s "$SAVED" "$TARGET" || fail "saved copy differs from target before revert"

# --- revert the ban: locate the block by its exact text and ASSERT exactly one
# occurrence (0 or >1 exits nonzero). The block is the full comment + the
# returnAssignee-keyed / createdBy-fallback if-else inside the
# `if (principalsEqual(currentParticipant, actor))` branch. ---
python3 - "$TARGET" <<'PYEOF' || fail "ban-block revert failed (occurrence count or write error)"
import sys

path = sys.argv[1]
with open(path, "rb") as f:
    src = f.read()

block = """
      // Builder ban is absolute (self-approval is impossible even if
      // misconfigured as participant): it keys on the build executor — the
      // parked build-stage returnAssignee — not the card creator (filing a
      // card is not building it). Legacy cards with a null returnAssignee
      // fall back to the createdBy check. Mirrors issue-stage-decisions.
      if (existingState?.returnAssignee) {
        if (principalsEqual(existingState.returnAssignee, actor)) {
          throw forbidden("The card builder cannot record a stage decision");
        }
      } else if (
        (input.actor.agentId && input.issue.createdByAgentId === input.actor.agentId) ||
        (input.actor.userId && input.issue.createdByUserId === input.actor.userId)
      ) {
        throw forbidden("The card builder cannot record a stage decision");
      }
""".encode("utf-8")

anchor = "Mirrors issue-stage-decisions.".encode("utf-8")
branch = "if (principalsEqual(currentParticipant, actor)) {".encode("utf-8")
needle = "The card builder cannot record a stage decision".encode("utf-8")

if src.count(anchor) != 1:
    sys.stderr.write("anchor 'Mirrors issue-stage-decisions.' count=%d (expected 1)\n" % src.count(anchor))
    sys.exit(1)
if src.count(block) != 1:
    sys.stderr.write("ban block count=%d (expected exactly 1)\n" % src.count(block))
    sys.exit(1)
if src.count(branch) != 1 or src.index(branch) > src.index(block):
    sys.stderr.write("ban block not found inside the currentParticipant==actor branch\n")
    sys.exit(1)

patched = src.replace(block, b"", 1)
if patched.count(needle) != 0:
    sys.stderr.write("ban message still present after removal (count=%d)\n" % patched.count(needle))
    sys.exit(1)

with open(path, "wb") as f:
    f.write(patched)
sys.exit(0)
PYEOF

# --- sanity: the revert must remove the ban message and actually change the file ---
grep -qF "$BAN_MSG" "$TARGET" && fail "ban message still present after revert"
cmp -s "$SAVED" "$TARGET" && fail "revert produced no change"
echo "revert applied: ban block removed from $TARGET"

# --- run ONLY the ban suite: foreground, under timeout, output to a file in
# the temp dir, exit status captured separately (no pipeline, so no fail-open).
# The run MUST exit nonzero; a passing suite under the revert means the ban
# tests do not detect the lost ban. ---
timeout 300 pnpm --filter @paperclipai/server exec vitest run "$TEST_SPEC" >"$LOG" 2>&1
vitest_rc=$?
echo "selection: pnpm --filter @paperclipai/server exec vitest run $TEST_SPEC (exit $vitest_rc)"

sed 's/\x1b\[[0-9;]*[a-zA-Z]//g' "$LOG" >"$CLEAN" || fail "ansi strip failed"

if [ "$vitest_rc" -eq 0 ]; then
  echo "--- last 20 lines of vitest output ---" >&2
  tail -n 20 "$CLEAN" >&2
  fail "suite passed with ban reverted"
fi

# A vacuous skip (embedded postgres unsupported) also exits nonzero-but-redless:
# the skipped suite proves nothing. Both ban titles must appear AND a failure
# marker must be present, so only a genuine red counts.
grep -q "Skipping issue patch stage-decision ban tests" "$CLEAN" &&
  fail "embedded postgres unsupported — suite skipped, control vacuous"
grep -qF "$TITLE1" "$CLEAN" || fail "title not found in vitest output: $TITLE1"
grep -qF "$TITLE2" "$CLEAN" || fail "title not found in vitest output: $TITLE2"
grep -qE '✕|×|FAIL' "$CLEAN" || fail "no failure marker in vitest output despite nonzero exit"
echo "failing titles confirmed:"
grep -F "$TITLE1" "$CLEAN" | head -n 1
grep -F "$TITLE2" "$CLEAN" | head -n 1

# --- restore the pristine file byte-equal and VERIFY (step: cp back, cmp -s) ---
cp "$SAVED" "$TARGET" || fail "restore cp failed"
cmp -s "$SAVED" "$TARGET" || fail "restore verification failed (byte mismatch)"
grep -qF "$BAN_MSG" "$TARGET" || fail "restored file lost the ban message (restore suspect)"
rm -f "$SAVED"

echo "NEGCTL:RED-CONFIRMED"
exit 0
