#!/usr/bin/env bash
# t1 (tests-for: d1, SPA-16859): RED-first N-cycle repro check for the
# legacy-execution recovery-action create/settle loop. Report only.
set -euo pipefail

cd "$(dirname "$0")/../.."

HARNESS="server/src/services/__tests__/legacy-execution-loop-repro.test.ts"

if [[ ! -f "$HARNESS" ]]; then
  echo "RED: harness missing: $HARNESS (d1 not yet implemented)"
  exit 1
fi

echo "harness found: $HARNESS - running N-cycle repro..."
set +e
OUTPUT="$(timeout 600 pnpm vitest run "$HARNESS" --reporter=verbose 2>&1)"
STATUS=$?
set -e
echo "$OUTPUT"
if [[ "$STATUS" -ne 0 ]]; then
  echo "RED: vitest exited $STATUS"
  exit "$STATUS"
fi

if ! grep -E -q "CYCLE [0-9]+ actions=" <<<"$OUTPUT"; then echo "RED: vitest passed but CYCLE row-count-per-cycle lines missing"; exit 1; fi
if ! grep -q "legacy-execution:" <<<"$OUTPUT"; then echo "RED: vitest passed but legacy-execution:<runId> fingerprint lines missing"; exit 1; fi

echo "GREEN: N-cycle loop reproduced (~1 row/cycle, fresh UUIDs, same fingerprint)"
