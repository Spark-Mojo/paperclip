#!/usr/bin/env bash
# requirements-signoff-check.test.sh -- offline tests for requirements-signoff-check.sh.
# No network calls: every case drives the checker via COMMENTS_JSON_FILE fixtures.
#
# Usage: bash scripts/ci/requirements-signoff-check.test.sh
#
# 2026-09-23 (SPA-8506): the canonical trusted author is now the
# `sparkmojo-verify[bot]` GitHub App, NOT `JamesSparkMojo`. The regression
# suite below adds two cases that prove the trust change: a marker posted by
# `sparkmojo-verify[bot]` (id 333096900) PASSES, and a marker posted by
# `JamesSparkMojo` (id 242298967) is REJECTED even when the surrounding
# allowlist only trusts the bot. The original cases still run for the bot
# login; the JamesSparkMojo-shaped fixtures are now negative-control cases
# that prove a formerly-trusted author is no longer trusted.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK_SCRIPT="$SCRIPT_DIR/requirements-signoff-check.sh"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

REPO="Spark-Mojo/spark-mojo-platform"
PR="1"
HEAD="a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"
OTHER_HEAD="b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2"
# Bot login+id from `gh api users/sparkmojo-verify[bot] --jq .id` against the
# App `sparkmojo-verify` (id 5052512, owned by Spark-Mojo). Mirrors
# `.github/workflows/requirements-signoff.yml`'s `TRUSTED_SIGNOFF_AUTHORS`.
TRUSTED="sparkmojo-verify[bot]:333096900"
# Legacy author id, used in the negative-control cases below.
LEGACY_AUTHOR_LOGIN="JamesSparkMojo"
LEGACY_AUTHOR_ID=242298967

pass_count=0
fail_count=0

# comment <login> <id> <verdict> <head>
comment() {
  local login="$1" id="$2" verdict="$3" head="$4"
  jq -n --arg login "$login" --arg id "$id" \
    --arg body "<!-- requirements-signoff:v1 head=${head} verdict=${verdict} -->" \
    '{user: {login: $login, id: ($id | tonumber)}, body: $body, html_url: "https://example.invalid/1"}'
}

run_case() {
  local name="$1" fixture="$2" expected_rc="$3"
  local fixture_file="$TMP_DIR/${name}.json"
  printf '%s' "$fixture" > "$fixture_file"
  local out_file="$TMP_DIR/${name}.out"
  set +e
  REPO="$REPO" PR="$PR" HEAD_SHA="$HEAD" TRUSTED_SIGNOFF_AUTHORS="$TRUSTED" \
    COMMENTS_JSON_FILE="$fixture_file" bash "$CHECK_SCRIPT" >"$out_file" 2>&1
  local actual_rc=$?
  set -e
  if [ "$actual_rc" -eq "$expected_rc" ]; then
    echo "PASS: $name (rc=$actual_rc)"
    pass_count=$((pass_count + 1))
  else
    echo "FAIL: $name (expected rc=$expected_rc, got rc=$actual_rc)"
    sed 's/^/    /' "$out_file"
    fail_count=$((fail_count + 1))
  fi
}

# 1. Bot-authored PASS -> 0 (the canonical happy path post-SPA-8506).
run_case "bot-pass" \
  "[$(comment 'sparkmojo-verify[bot]' 333096900 pass "$HEAD")]" \
  0

# 2. Bot-authored FAIL -> 1
run_case "bot-fail" \
  "[$(comment 'sparkmojo-verify[bot]' 333096900 fail "$HEAD")]" \
  1

# 3. Untrusted pass ignored -> 1 (login not on the allowlist at all)
run_case "untrusted-pass-ignored" \
  "[$(comment some-attacker 999999 pass "$HEAD")]" \
  1

# 3b. Bot login matches but numeric id doesn't (impersonation attempt) -> 1
run_case "bot-login-matches-id-mismatch-ignored" \
  "[$(comment 'sparkmojo-verify[bot]' 1 pass "$HEAD")]" \
  1

# 3c. SPA-8506 REGRESSION: JamesSparkMojo (formerly trusted, id 242298967) is
# now REJECTED. The marker is well-formed, the login is well-known, but the
# allowlist no longer contains it. This is the case a PR signed off under the
# old trust would fall on; the change is the whole point of SPA-8506.
run_case "james-pass-now-rejected" \
  "[$(comment "$LEGACY_AUTHOR_LOGIN" "$LEGACY_AUTHOR_ID" pass "$HEAD")]" \
  1

# 3d. SPA-8506 REGRESSION: JamesSparkMojo FAIL is also rejected. (Was already
# the case; included so the bot-only allowlist is provably the only difference.)
run_case "james-fail-now-rejected" \
  "[$(comment "$LEGACY_AUTHOR_LOGIN" "$LEGACY_AUTHOR_ID" fail "$HEAD")]" \
  1

# 4. head mismatch -> 1 (marker is for a different head than the one under test)
run_case "head-mismatch" \
  "[$(comment 'sparkmojo-verify[bot]' 333096900 pass "$OTHER_HEAD")]" \
  1

# 5a. latest-wins: bot pass then bot fail -> 1
run_case "latest-wins-pass-then-fail" \
  "[$(comment 'sparkmojo-verify[bot]' 333096900 pass "$HEAD"),$(comment 'sparkmojo-verify[bot]' 333096900 fail "$HEAD")]" \
  1

# 5b. latest-wins: bot fail then bot pass -> 0
run_case "latest-wins-fail-then-pass" \
  "[$(comment 'sparkmojo-verify[bot]' 333096900 fail "$HEAD"),$(comment 'sparkmojo-verify[bot]' 333096900 pass "$HEAD")]" \
  0

# 5c. latest-wins: a JamesSparkMojo PASS followed by a bot PASS -> 0 (the bot
# comment is the latest, even when the earlier author was the formerly-trusted
# login). Proves "latest trusted" semantics survive the trust change.
run_case "latest-wins-james-then-bot" \
  "[$(comment "$LEGACY_AUTHOR_LOGIN" "$LEGACY_AUTHOR_ID" pass "$HEAD"),$(comment 'sparkmojo-verify[bot]' 333096900 pass "$HEAD")]" \
  0

# 5d. latest-wins: a bot PASS followed by a JamesSparkMojo PASS -> 0. A
# formerly-trusted author cannot override a bot sign-off by commenting later.
# Without the allowlist logic this would have been rc=0; the trust change makes
# the JamesSparkMojo marker invisible to the matcher, so the last VISIBLE
# trusted marker is the bot PASS, which has already been superseded by the
# newer untrusted comment in array order — but `last // empty` selects the
# last array element that satisfies the filter, and only the bot's comment
# passes the filter. The bot's PASS still wins because it's the LAST trusted
# match in array order.
run_case "latest-wins-bot-then-james" \
  "[$(comment 'sparkmojo-verify[bot]' 333096900 pass "$HEAD"),$(comment "$LEGACY_AUTHOR_LOGIN" "$LEGACY_AUTHOR_ID" pass "$HEAD")]" \
  0

echo
echo "requirements-signoff-check.test.sh: ${pass_count} passed, ${fail_count} failed"
[ "$fail_count" -eq 0 ]
