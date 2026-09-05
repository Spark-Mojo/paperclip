#!/usr/bin/env bash
# scripts/engine/tests/test-install-dry-run.sh
#
# Local, offline test of install.sh / rollback.sh orchestration under
# PAPERCLIP_ENGINE_DRY_RUN=1: symlink switch, automatic rollback on a failed
# health check, idempotent re-install, and explicit rollback.sh. Nothing here
# touches bigbox, npmjs.org, GitHub, or the laptop's real Paperclip install —
# install/build steps are short-circuited by install.sh's own dry-run path
# (stage_fake_payload), and the only real network I/O is curl against a
# local Node HTTP stub standing in for GET /api/health.

set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_DIR="$(cd "$TEST_DIR/.." && pwd)"

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-engine-test.XXXXXX")"
cleanup() {
  if [ -n "${SERVER_PID:-}" ]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$SANDBOX"
}
trap cleanup EXIT

PASS=0
FAIL=0

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  ok   - $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL - $desc (expected '$expected', got '$actual')"
    FAIL=$((FAIL + 1))
  fi
}

assert_true() {
  local desc="$1"; shift
  if "$@"; then
    echo "  ok   - $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL - $desc"
    FAIL=$((FAIL + 1))
  fi
}

# Plain bash substring match — deliberately NOT `echo "$haystack" | grep`
# re-parsed through a constructed `bash -c "..."` string: captured script
# output can contain literal double quotes (e.g. the unit-file diff below
# includes `ExecStart="..."`), which prematurely closes a hand-built
# double-quoted command string and mis-parses the rest as commands.
assert_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "  ok   - $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL - $desc"
    FAIL=$((FAIL + 1))
  fi
}

# ---------------------------------------------------------------------------
# Sandbox environment shared by every install.sh / rollback.sh invocation.
# ---------------------------------------------------------------------------

ENGINE_ROOT="$SANDBOX/engine-root"
PAPERCLIP_HOME="$ENGINE_ROOT/.paperclip-831"
INSTANCE_ROOT="$PAPERCLIP_HOME/instances/default"
CURRENT_LINK="$ENGINE_ROOT/paperclip-current"
UNIT_NAME="paperclip-831.service"
mkdir -p "$INSTANCE_ROOT"

MODE_FILE="$SANDBOX/health-mode"
echo "ok" > "$MODE_FILE"

node "$TEST_DIR/health-stub-server.mjs" "$MODE_FILE" > "$SANDBOX/server.port" 2>"$SANDBOX/server.log" &
SERVER_PID=$!
for _ in $(seq 1 50); do
  [ -s "$SANDBOX/server.port" ] && break
  sleep 0.1
done
HEALTH_PORT="$(cat "$SANDBOX/server.port")"
if [ -z "$HEALTH_PORT" ]; then
  echo "FAIL - could not start health stub server" >&2
  cat "$SANDBOX/server.log" >&2 || true
  exit 1
fi

cat > "$INSTANCE_ROOT/config.json" <<EOF
{
  "server": { "host": "127.0.0.1", "port": $HEALTH_PORT },
  "database": {
    "mode": "postgres",
    "connectionString": "postgres://fake:fake@127.0.0.1:5432/paperclip831"
  }
}
EOF

export PAPERCLIP_ENGINE_DRY_RUN=1
export ENGINE_ROOT PAPERCLIP_HOME
export PAPERCLIP_INSTANCE_ID=default
export CURRENT_LINK
export UNIT_NAME
export EXPECTED_DB=paperclip831
export BACKUP_DIR="$ENGINE_ROOT/paperclip-backups"
export STATE_DIR="$ENGINE_ROOT/.paperclip-engine"
export HEALTH_TIMEOUT_SECS=3
export HEALTH_POLL_SECS=1

# Captures stdout+stderr and exit code of a command WITHOUT letting a
# non-zero exit trip this test script's own `set -e` (several of these
# invocations are expected to fail).
capture() {
  local __out_var="$1" __code_var="$2"; shift 2
  local out code
  set +e
  out="$("$@" 2>&1)"
  code=$?
  set -e
  printf -v "$__out_var" '%s' "$out"
  printf -v "$__code_var" '%s' "$code"
}

echo "== test 1: first install (npm:1.2.3), health ok =="
echo "ok" > "$MODE_FILE"
capture out1 code1 "$ENGINE_DIR/install.sh" npm:1.2.3
echo "$out1" | sed 's/^/    /'
assert_eq "install exits 0" "0" "$code1"
assert_true "current symlink exists" test -L "$CURRENT_LINK"
assert_eq "current -> paperclip-1.2.3" "$ENGINE_ROOT/paperclip-1.2.3" "$(readlink "$CURRENT_LINK")"
assert_true "new prefix has a fake package.json" test -f "$ENGINE_ROOT/paperclip-1.2.3/lib/node_modules/paperclipai/package.json"
assert_true "no previous-prefix state file yet (first install)" bash -c '[ ! -f "'"$STATE_DIR"'/previous-prefix" ]'

echo "== test 1b: idempotent re-install of the same version =="
capture out1b code1b "$ENGINE_DIR/install.sh" npm:1.2.3
assert_eq "re-install exits 0" "0" "$code1b"
assert_contains "re-install logs reuse, not a fresh stage" "$out1b" "Reusing already-installed prefix"

echo "== test 2: upgrade to npm:9.9.9 with health FAILING -> automatic rollback =="
echo "fail" > "$MODE_FILE"
capture out2 code2 "$ENGINE_DIR/install.sh" npm:9.9.9
echo "$out2" | sed 's/^/    /'
assert_eq "failed install exits non-zero" "1" "$code2"
assert_eq "current rolled back to paperclip-1.2.3" "$ENGINE_ROOT/paperclip-1.2.3" "$(readlink "$CURRENT_LINK")"
assert_true "new (bad) prefix left on disk for investigation" test -d "$ENGINE_ROOT/paperclip-9.9.9"
assert_contains "install.sh warns DB was not rolled back" "$out2" "DATABASE SCHEMA WAS NOT ROLLED BACK"

echo "== test 2b: upgrade to npm:8.8.8 where systemctl start itself fails (Type=notify timeout/crash) =="
echo "ok" > "$MODE_FILE"
export PAPERCLIP_ENGINE_TEST_FAIL_START=1
capture out2b code2b "$ENGINE_DIR/install.sh" npm:8.8.8
unset PAPERCLIP_ENGINE_TEST_FAIL_START
echo "$out2b" | sed 's/^/    /'
assert_eq "start-failure install exits non-zero" "1" "$code2b"
assert_eq "current rolled back to paperclip-1.2.3 (not left on the broken prefix)" "$ENGINE_ROOT/paperclip-1.2.3" "$(readlink "$CURRENT_LINK")"
assert_contains "install.sh reports the systemctl start failure, not a silent set -e death" "$out2b" "systemctl start FAILED"

echo "== test 3: healthy upgrade to npm:2.0.0, then explicit rollback.sh with no args =="
echo "ok" > "$MODE_FILE"
capture out3 code3 "$ENGINE_DIR/install.sh" npm:2.0.0
assert_eq "install to 2.0.0 exits 0" "0" "$code3"
assert_eq "current -> paperclip-2.0.0" "$ENGINE_ROOT/paperclip-2.0.0" "$(readlink "$CURRENT_LINK")"
assert_eq "previous-prefix state file recorded 1.2.3" "$ENGINE_ROOT/paperclip-1.2.3" "$(cat "$STATE_DIR/previous-prefix")"

capture out3b code3b "$ENGINE_DIR/rollback.sh"
echo "$out3b" | sed 's/^/    /'
assert_eq "rollback.sh exits 0" "0" "$code3b"
assert_eq "current rolled back to paperclip-1.2.3" "$ENGINE_ROOT/paperclip-1.2.3" "$(readlink "$CURRENT_LINK")"
assert_eq "previous-prefix state file now records 2.0.0" "$ENGINE_ROOT/paperclip-2.0.0" "$(cat "$STATE_DIR/previous-prefix")"

echo "== test 4: fork:<ref> source resolves to a paperclip-fork-<sha> prefix =="
capture out4 code4 "$ENGINE_DIR/install.sh" fork:HEAD
echo "$out4" | sed 's/^/    /'
assert_eq "fork install exits 0" "0" "$code4"
assert_true "current symlink now points at a paperclip-fork-* prefix" bash -c '[[ "$(readlink "'"$CURRENT_LINK"'")" == "'"$ENGINE_ROOT"'"/paperclip-fork-* ]]'

echo "== test 5: status.sh runs cleanly against the sandbox =="
capture status_out status_code "$ENGINE_DIR/status.sh"
echo "$status_out" | sed 's/^/    /'
assert_eq "status.sh exits 0" "0" "$status_code"
assert_contains "status.sh reports the current symlink target" "$status_out" "paperclip-current ->"

echo "== test 6: rollback.sh --restore is gated on --yes =="
capture out6a code6a "$ENGINE_DIR/rollback.sh" "$ENGINE_ROOT/paperclip-1.2.3" --restore /tmp/does-not-matter.dump
echo "$out6a" | sed 's/^/    /'
assert_eq "no --yes: rollback.sh exits non-zero" "1" "$code6a"
assert_contains "no --yes: rollback.sh refuses the restore" "$out6a" "requires --yes"

capture out6b code6b "$ENGINE_DIR/rollback.sh" "$ENGINE_ROOT/paperclip-1.2.3" --restore /tmp/does-not-matter.dump --yes
echo "$out6b" | sed 's/^/    /'
assert_eq "with --yes: rollback.sh exits 0" "0" "$code6b"
assert_contains "with --yes: rollback.sh logs the (dry-run) pg_restore invocation" "$out6b" "pg_restore --clean --if-exists"

echo "== test 7: unit_ensure_installed refuses to silently overwrite a differing unit file =="
FAKE_UNIT_DIR="$SANDBOX/fake-home/.config/systemd/user"
mkdir -p "$FAKE_UNIT_DIR"
echo "# a unit file installed by someone else (e.g. leaf 2)" > "$FAKE_UNIT_DIR/$UNIT_NAME"
capture out7 code7 env \
  HOME="$SANDBOX/fake-home" \
  PAPERCLIP_ENGINE_DRY_RUN=0 \
  ENGINE_ROOT="$ENGINE_ROOT" \
  PAPERCLIP_HOME="$PAPERCLIP_HOME" \
  PAPERCLIP_INSTANCE_ID=default \
  CURRENT_LINK="$CURRENT_LINK" \
  UNIT_NAME="$UNIT_NAME" \
  EXPECTED_DB=paperclip831 \
  BACKUP_DIR="$BACKUP_DIR" \
  STATE_DIR="$STATE_DIR" \
  HEALTH_TIMEOUT_SECS=3 \
  HEALTH_POLL_SECS=1 \
  ENGINE_DIR_FOR_TEST="$ENGINE_DIR" \
  bash -c '
    # Exercise only unit_ensure_installed in isolation (a real systemctl is
    # not available in this sandbox, so we cannot run install.sh end to end
    # with DRY_RUN=0 here) — source lib.sh directly and call the guarded
    # function. ENGINE_DIR_FOR_TEST is an inherited env var, not a
    # nested-quoting substitution, to keep this readable.
    set -euo pipefail
    . "$ENGINE_DIR_FOR_TEST/lib.sh"
    unit_ensure_installed "$ENGINE_DIR_FOR_TEST/systemd/paperclip-831.service"
  '
echo "$out7" | sed 's/^/    /'
assert_eq "differing unit file: refuses and exits non-zero" "1" "$code7"
assert_contains "differing unit file: names the escape hatch" "$out7" "PAPERCLIP_ENGINE_REPLACE_UNIT"
assert_eq "differing unit file: left untouched on disk" "# a unit file installed by someone else (e.g. leaf 2)" "$(cat "$FAKE_UNIT_DIR/$UNIT_NAME")"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
