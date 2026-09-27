#!/usr/bin/env bash
# requirements-signoff-check.sh (2026-09-21, ADVISORY workflow companion;
# comment-trigger + trusted-author gate added 2026-09-22)
#
# Looks for a requirements sign-off marker comment on a PR, matching its CURRENT head SHA,
# posted by an author on the trusted allowlist. The marker is produced by the builder's
# in-session requirements sign-off step (opencode workflow: build -> verify -> sign-off
# against the card requirements). This script makes that artifact mechanical to check so an
# orchestrator cannot silently skip its own verifier -- AND so a comment from an untrusted
# account can't forge a pass. Login alone is spoofable (anyone can create an account with a
# similar name); the numeric GitHub user id is not, so a marker only counts when BOTH the
# login and the id match an allowlist entry (same "id, not just login" lesson as
# codex-pr-head-clean.mjs's CODEX_LOGINS / canary PR #671 finding).
#
# Marker shape (may appear anywhere in a comment body):
#   <!-- requirements-signoff:v1 head=<40-hex-sha> verdict=pass -->
#
# Usage:
#   REPO=owner/repo PR=123 HEAD_SHA=<40-hex-sha> \
#   TRUSTED_SIGNOFF_AUTHORS="login:id,login:id" \
#   bash scripts/ci/requirements-signoff-check.sh
#
# TRUSTED_SIGNOFF_AUTHORS is comma-separated `login:id` pairs. Look up a login's numeric id
# with `gh api users/<login> --jq .id`. This is the SAME allowlist the workflow's job-level
# `if` gates on for issue_comment events (see requirements-signoff.yml's TRUSTED_SIGNOFF_AUTHORS
# workflow env for the canonical source -- the job-level `if` duplicates the login literal
# because GitHub Actions does not expose the `env` context to `jobs.<job_id>.if`).
#
# Testing (no network): set COMMENTS_JSON_FILE to a file containing the JSON array that
# `gh api repos/$REPO/issues/$PR/comments --paginate` would print, and this script reads
# that file instead of calling `gh`.
set -euo pipefail

: "${REPO:?REPO env var required (owner/repo)}"
: "${PR:?PR env var required (PR number)}"
: "${HEAD_SHA:?HEAD_SHA env var required (40-hex PR head SHA)}"
: "${TRUSTED_SIGNOFF_AUTHORS:?TRUSTED_SIGNOFF_AUTHORS env var required (login:id,login:id)}"
COMMENTS_JSON_FILE="${COMMENTS_JSON_FILE:-}"

if ! [[ "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::HEAD_SHA is not a 40-hex sha: '$HEAD_SHA'" >&2
  exit 1
fi

# Build a JSON array of {login,id} from "login:id,login:id" so jq can match comment authors
# against it below.
trusted_json="$(
  IFS=',' read -ra pairs <<<"$TRUSTED_SIGNOFF_AUTHORS"
  printf '['
  first=true
  for pair in "${pairs[@]}"; do
    login="${pair%%:*}"
    id="${pair#*:}"
    if [ -z "$login" ] || [ -z "$id" ] || ! [[ "$id" =~ ^[0-9]+$ ]]; then
      echo "::error::malformed TRUSTED_SIGNOFF_AUTHORS entry: '$pair' (expected login:id)" >&2
      exit 1
    fi
    $first || printf ','
    first=false
    printf '{"login":%s,"id":%s}' "$(jq -Rn --arg s "$login" '$s')" "$id"
  done
  printf ']'
)"

if [ -n "$COMMENTS_JSON_FILE" ]; then
  comments_json="$(cat "$COMMENTS_JSON_FILE")"
else
  # --paginate emits one JSON array per page; slurp+add flattens them so
  # "latest comment wins" holds past the first page (30 comments).
  # Fetch first, then flatten: a failed `gh api` must abort here (set -e on the
  # assignment) instead of feeding jq an empty stream that reads as "no marker".
  raw_pages="$(gh api "repos/${REPO}/issues/${PR}/comments" --paginate)"
  comments_json="$(jq -s 'add // []' <<<"$raw_pages")"
fi

marker_pattern="<!-- requirements-signoff:v1 head=${HEAD_SHA} verdict=(?<verdict>pass|fail) -->"

# Find the LATEST comment (by array order, which `gh api --paginate` returns oldest-first)
# whose body contains a marker for this exact head SHA AND whose author (login + numeric id)
# is on the trusted allowlist. An untrusted author's marker is invisible to this match --
# it neither passes nor fails the PR, it simply doesn't count.
match_json="$(jq -c --arg pat "$marker_pattern" --argjson trusted "$trusted_json" '
  ($trusted | map(.login + ":" + (.id | tostring))) as $trustedSet |
  [ .[] | select(.body | test($pat))
        | select((((.user.login // "") + ":" + ((.user.id // 0) | tostring)) as $k | $trustedSet | index($k) != null))
  ] | last // empty
' <<<"$comments_json")"

if [ -z "$match_json" ] || [ "$match_json" = "null" ]; then
  echo "::error::no TRUSTED requirements sign-off for head ${HEAD_SHA}; the build session's sign-off step must post \`<!-- requirements-signoff:v1 head=${HEAD_SHA} verdict=pass -->\` on this PR from a trusted account (${TRUSTED_SIGNOFF_AUTHORS})" >&2
  exit 1
fi

verdict="$(jq -r --arg pat "$marker_pattern" '.body | capture($pat).verdict' <<<"$match_json")"
author="$(jq -r '.user.login // "unknown"' <<<"$match_json")"
url="$(jq -r '.html_url // "unknown"' <<<"$match_json")"

if [ "$verdict" = "fail" ]; then
  echo "::error::requirements sign-off for head ${HEAD_SHA} is FAIL (comment by ${author}: ${url})" >&2
  exit 1
fi

echo "Requirements sign-off found for head ${HEAD_SHA} (verdict=pass), posted by trusted author ${author}: ${url}"
exit 0
