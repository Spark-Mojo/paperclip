#!/usr/bin/env bash
# r3-base-red.sh — prove the R3 test set is RED on base commit bba6a45 for exactly
# the expected reasons, with self-diagnostic fault injection.
#
# Modes (env R3_FAULT):
#   (unset)        base run must classify RED_OK   -> exit 0
#   R3_FAULT=suite injected broken-import file must classify SUITE_ERROR -> exit 0
#   R3_FAULT=green expected-red tests skipped on the copies must classify GREEN -> exit 0
#
# EXPECTED_RED titles are never hand-typed here: they are extracted from the
# copied test files via short distinctive keys, each required to match exactly
# one `it("...")` title, reconciled to 12 entries.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
BASE="bba6a45f0d364cfd962ac59b3bdf2426a8222adb"
FAULT="${R3_FAULT:-}"
FILE_A="server/src/__tests__/issue-recovery-actions.test.ts"
FILE_B="server/src/__tests__/issue-agent-mutation-ownership-routes.test.ts"

fail() { echo "FAIL: $*" >&2; exit 1; }

# --- a. dirty guard: only test-ledger paths and .unlazy/ may be modified ----
while IFS= read -r line; do
  [ -z "$line" ] && continue
  path="${line:3}"
  case "$path" in
    server/src/__tests__/*|".unlazy/"|".unlazy/"*) ;;
    *) fail "dirty-guard: unexpected worktree change -> ${line}" ;;
  esac
done < <(git status --porcelain)

TMP="$(mktemp -d)"
cleanup() {
  git worktree remove --force "$TMP/base" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

# --- c. base worktree, test copies, module symlinks --------------------------
git worktree add --detach "$TMP/base" "$BASE" >/dev/null 2>&1 \
  || fail "git worktree add of ${BASE} failed"
mkdir -p "$TMP/base/server/src/__tests__"
cp "$ROOT/$FILE_A" "$ROOT/$FILE_B" "$TMP/base/server/src/__tests__/"
ln -s "$ROOT/node_modules" "$TMP/base/node_modules"
ln -s "$ROOT/server/node_modules" "$TMP/base/server/node_modules"

BA="$TMP/base/$FILE_A"
BB="$TMP/base/$FILE_B"

extract_titles() { grep -oP '^\s*it\("\K[^"]+' "$1" || true; }

pick() { # $1=key -> exact title from the copied files (must match exactly one)
  local key="$1" match="" f t
  for f in "$BA" "$BB"; do
    while IFS= read -r t; do
      case "$t" in
        *"$key"*) [ -n "$match" ] && fail "key matches multiple titles: ${key}"; match="$t" ;;
      esac
    done < <(extract_titles "$f")
  done
  [ -n "$match" ] || fail "key matched no test title: ${key}"
  printf '%s\n' "$match"
}

# --- g. EXPECTED_RED: 12 exact titles pulled from the files ------------------
: > "$TMP/expected_red.txt"
while IFS= read -r key; do pick "$key" >> "$TMP/expected_red.txt"; done <<'KEYS'
cited retry run does not exist
concluded without success
only after engaging the GitHub lookup
fails closed when the GitHub lookup raises
refuses a bare run citation
refuses a backtick-wrapped run citation
refuses a GitHub Actions URL citation
refuses a posted-activation-receipt claim
refuses a bridge-posted-receipt claim
refuses a phantom citation when the card is already terminal
refuses moving a PR-classified card to done
pins the issue.recovery_evidence_refused action to the user-participation
KEYS
N_EXPECTED="$(wc -l < "$TMP/expected_red.txt")"
[ "$N_EXPECTED" -eq 12 ] || fail "expected-red reconciliation failed: ${N_EXPECTED} != 12"

# Base-green proceed controls (reported, not required green):
: > "$TMP/controls.txt"
while IFS= read -r key; do pick "$key" >> "$TMP/controls.txt"; done <<'CTRLS'
allows a citation-free terminal resolution
accepts a receipt claim backed by the marker comment
does not treat a non-run decimal as a citation
resolves a card with no PR signal
keeps an already-terminal PR card closable
CTRLS
if grep -Fxq -f "$TMP/controls.txt" "$TMP/expected_red.txt" 2>/dev/null; then
  fail "a proceed control leaked into EXPECTED_RED"
fi

# --- d. fault injection BEFORE the run --------------------------------------
case "$FAULT" in
  suite)
    printf 'import "./does-not-exist-xyz.js";\n' \
      > "$TMP/base/server/src/__tests__/r3-fault-broken-import.test.ts"
    ;;
  green)
    # ONE deterministic mechanism: flip it("T" -> it.skip("T") on the copies.
    while IFS= read -r title; do
      python3 - "$BA" "$BB" "$title" <<'PYEOF'
import sys
needle = 'it("%s"' % sys.argv[3]
for path in (sys.argv[1], sys.argv[2]):
    s = open(path).read()
    c = s.count(needle)
    if c:
        assert c == 1, (path, sys.argv[3], c)
        open(path, "w").write(s.replace(needle, 'it.skip("%s"' % sys.argv[3]))
PYEOF
    done < "$TMP/expected_red.txt"
    ;;
  "") ;;
  *) fail "unknown R3_FAULT value: ${FAULT}" ;;
esac

# --- e. run vitest on base, JSON only ---------------------------------------
FAULT_FILE="server/src/__tests__/r3-fault-broken-import.test.ts"
RUN_FILES=("$FILE_A" "$FILE_B")
[ "$FAULT" = "suite" ] && RUN_FILES+=("$FAULT_FILE")

RUN_RC=0
cd "$TMP/base"
VITEST_HOOK_TIMEOUT=120000 npx vitest run "${RUN_FILES[@]}" \
  --reporter=json --outputFile.json="$TMP/out.json" \
  > "$TMP/vitest.out" 2> "$TMP/vitest.err" || RUN_RC=$?

# --- f/g. classify + verdict block ------------------------------------------
R3_BASE="$BASE" R3_RUN_RC="$RUN_RC" python3 - "$TMP" "$FAULT" <<'PYEOF'
import json, os, sys

tmp, fault = sys.argv[1], sys.argv[2]
expected = [l for l in open(f"{tmp}/expected_red.txt").read().splitlines() if l]
controls = [l for l in open(f"{tmp}/controls.txt").read().splitlines() if l]
data = json.load(open(f"{tmp}/out.json"))

suite_err_files, per_file, fails = [], {}, []
for tr in data.get("testResults") or []:
    name = os.path.basename(tr.get("name") or "?")
    msg = (tr.get("message") or "").strip()
    ars = tr.get("assertionResults") or []
    ff = [a.get("title", "") for a in ars if a.get("status") == "failed"]
    if tr.get("status") == "failed" and (not ars or msg):
        suite_err_files.append(name)
    per_file[name] = ff
    fails.extend(ff)

missing = sorted(set(expected) - set(fails))
# DEFAULT mode additionally gates the count: RED_OK requires failing-test
# count == len(EXPECTED_RED) == 12 exactly, so extra unexpected failures fail
# the classification even though every expected-red title did fail.
count_ok = fault != "" or len(fails) == len(expected)
if suite_err_files:
    verdict = "SUITE_ERROR"
elif not fails:
    verdict = "GREEN"
elif not missing and count_ok:
    verdict = "RED_OK"
else:
    verdict = "MISMATCH"

want = {"suite": "SUITE_ERROR", "green": "GREEN"}.get(fault, "RED_OK")
ok = verdict == want

print("=" * 74)
print(f"BASE            {os.environ['R3_BASE']}")
print(f"FAULT           {fault or '(none)'}   vitest-rc {os.environ['R3_RUN_RC']}"
      f"   tests {data.get('numPassedTests')}passed/{data.get('numFailedTests')}failed"
      f"/{data.get('numTotalTests')}total")
for name in sorted(per_file):
    print(f"  {name}: {len(per_file[name])} failed")
print(f"CLASSIFICATION  {verdict}  (required: {want})  -> exit {'0' if ok else '1'}")
print(f"EXPECTED_RED    {len(expected)} entries; actual failing {len(fails)};"
      f" missing {len(missing)}; extra {sorted(set(fails) - set(expected))}")
print("EXPECTED_RED titles:")
for t in expected:
    print(f"  - {t}")
print(f"PROCEED CONTROLS found in files: {len(controls)} (not required green on base)")
for t in controls:
    print(f"  - {t}")
if suite_err_files:
    print(f"suite-level errors in: {suite_err_files}")
print("=" * 74)
sys.exit(0 if ok else 1)
PYEOF
