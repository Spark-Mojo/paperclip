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
export PAPERCLIP_WHATS_RUNNING_PATH="$SANDBOX/bin/whats-running"
mkdir -p "$(dirname "$PAPERCLIP_WHATS_RUNNING_PATH")"
printf 'stale-report\n' > "$PAPERCLIP_WHATS_RUNNING_PATH"
echo "fail" > "$MODE_FILE"
capture out2 code2 "$ENGINE_DIR/install.sh" npm:9.9.9
echo "$out2" | sed 's/^/    /'
assert_eq "failed install exits non-zero" "1" "$code2"
assert_eq "current rolled back to paperclip-1.2.3" "$ENGINE_ROOT/paperclip-1.2.3" "$(readlink "$CURRENT_LINK")"
assert_true "new (bad) prefix left on disk for investigation" test -d "$ENGINE_ROOT/paperclip-9.9.9"
assert_contains "install.sh warns DB was not rolled back" "$out2" "DATABASE SCHEMA WAS NOT ROLLED BACK"
assert_eq "failed install preserves existing runtime report" "stale-report" "$(cat "$PAPERCLIP_WHATS_RUNNING_PATH")"

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

echo "== test 4: fork source uses distinct receipt-bound overlay prefix =="
LEGACY_SHA="$(git -C "$ENGINE_DIR/../.." rev-parse HEAD | cut -c1-12)"
LEGACY_PREFIX="$ENGINE_ROOT/paperclip-fork-$LEGACY_SHA"
mkdir -p "$LEGACY_PREFIX/lib/node_modules/paperclipai"
printf '%s\n' '{"name":"paperclipai","version":"legacy"}' > "$LEGACY_PREFIX/lib/node_modules/paperclipai/package.json"
capture out4 code4 "$ENGINE_DIR/install.sh" fork:HEAD
echo "$out4" | sed 's/^/    /'
assert_eq "fork install exits 0" "0" "$code4"
assert_true "current symlink points at distinct overlay prefix" bash -c '[[ "$(readlink "'"$CURRENT_LINK"'")" == "'"$ENGINE_ROOT"'"/paperclip-overlay-2026.831.1-* ]]'
assert_true "legacy same-source prefix was not reused" test "$(readlink "$CURRENT_LINK")" != "$LEGACY_PREFIX"

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

FAKE_BIN="$SANDBOX/fake-bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/pg_restore" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$FAKE_BIN/pg_restore"
VALID_DUMP="$SANDBOX/valid.dump"
echo "fixture" > "$VALID_DUMP"
capture out6b code6b env PATH="$FAKE_BIN:$PATH" "$ENGINE_DIR/rollback.sh" "$ENGINE_ROOT/paperclip-1.2.3" --restore "$VALID_DUMP" --yes
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

echo "== test 8: install rejects a conflicting unit before any install mutation =="
before_link="$(readlink "$CURRENT_LINK")"
capture out8 code8 env HOME="$SANDBOX/fake-home" "$ENGINE_DIR/install.sh" npm:7.7.7
echo "$out8" | sed 's/^/    /'
assert_eq "conflicting unit: install exits non-zero" "1" "$code8"
assert_contains "conflicting unit: refusal happens in preflight" "$out8" "Preflight: systemd unit compatibility"
assert_eq "conflicting unit: current symlink is unchanged" "$before_link" "$(readlink "$CURRENT_LINK")"
assert_true "conflicting unit: no new prefix was staged" test ! -e "$ENGINE_ROOT/paperclip-7.7.7"

echo "== test 9: corrupt restore dump is rejected before service or symlink mutation =="
cat > "$FAKE_BIN/pg_restore" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "--list" ]; then
  exit 1
fi
exit 99
EOF
chmod +x "$FAKE_BIN/pg_restore"
CORRUPT_DUMP="$SANDBOX/corrupt.dump"
echo "not a postgres archive" > "$CORRUPT_DUMP"
before_link="$(readlink "$CURRENT_LINK")"
capture out9 code9 env PATH="$FAKE_BIN:$PATH" "$ENGINE_DIR/rollback.sh" "$ENGINE_ROOT/paperclip-2.0.0" --restore "$CORRUPT_DUMP" --yes
echo "$out9" | sed 's/^/    /'
assert_eq "corrupt dump: rollback exits non-zero" "1" "$code9"
assert_contains "corrupt dump: validation explains failure" "$out9" "not a readable PostgreSQL archive"
assert_eq "corrupt dump: current symlink is unchanged" "$before_link" "$(readlink "$CURRENT_LINK")"
assert_true "corrupt dump: unit stop was never attempted" bash -c '[[ "$1" != *"systemctl --user stop"* ]]' _ "$out9"

echo "== test 9b: missing restore dump is rejected before service or symlink mutation =="
before_link="$(readlink "$CURRENT_LINK")"
capture out9b code9b env PATH="$FAKE_BIN:$PATH" "$ENGINE_DIR/rollback.sh" "$ENGINE_ROOT/paperclip-2.0.0" --restore "$SANDBOX/missing.dump" --yes
assert_eq "missing dump: rollback exits non-zero" "1" "$code9b"
assert_contains "missing dump: validation explains failure" "$out9b" "Restore dump does not exist"
assert_eq "missing dump: current symlink is unchanged" "$before_link" "$(readlink "$CURRENT_LINK")"

echo "== test 9c: failed restore restarts original service without flipping symlink =="
cat > "$FAKE_BIN/pg_restore" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "--list" ]; then
  exit 0
fi
case "$*" in
  *postgres://*|*fake:fake*) exit 81 ;;
esac
[ "${PGSERVICE:-}" = paperclip_engine ]
[ -f "${PGSERVICEFILE:-}" ]
[ -f "${PGPASSFILE:-}" ]
printf '%s\n' "$*" > "$RESTORE_MARKER"
exit 99
EOF
chmod +x "$FAKE_BIN/pg_restore"
cat > "$FAKE_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
printf 'fake systemctl %s\n' "$*" >&2
exit 0
EOF
chmod +x "$FAKE_BIN/systemctl"
cat > "$FAKE_BIN/uname" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' Linux
EOF
chmod +x "$FAKE_BIN/uname"
RESTORE_MARKER="$SANDBOX/restore-invoked"
before_link="$(readlink "$CURRENT_LINK")"
capture out9c code9c env PATH="$FAKE_BIN:$PATH" RESTORE_MARKER="$RESTORE_MARKER" PAPERCLIP_ENGINE_DRY_RUN=0 "$ENGINE_DIR/rollback.sh" "$ENGINE_ROOT/paperclip-2.0.0" --restore "$VALID_DUMP" --yes
echo "$out9c" | sed 's/^/    /'
assert_eq "failed restore: rollback exits non-zero" "1" "$code9c"
assert_eq "failed restore: current symlink is unchanged" "$before_link" "$(readlink "$CURRENT_LINK")"
assert_contains "failed restore: uses exit-on-error" "$out9c" "--exit-on-error"
assert_contains "failed restore: uses single transaction" "$out9c" "--single-transaction"
assert_contains "failed restore: original service restart attempted" "$out9c" "systemctl --user start"
assert_true "failed restore: fake restore command was invoked" test -s "$RESTORE_MARKER"
assert_true "failed restore: output contains no database URI" bash -c '[[ "$1" != *postgres://* && "$1" != *fake:fake* ]]' _ "$out9c"

echo "== test 10: fork server package verification accepts real nested npm layout =="
SERVER_FIXTURE="$SANDBOX/server-fixture"
SERVER_PAYLOAD="$SANDBOX/server-payload"
mkdir -p "$SERVER_FIXTURE/package" "$SERVER_PAYLOAD/lib/node_modules/paperclipai/node_modules/@paperclipai/server"
printf '%s\n' '{"name":"@paperclipai/server","version":"9.8.7","gitHead":"fixture-sha"}' > "$SERVER_FIXTURE/package/package.json"
cp "$SERVER_FIXTURE/package/package.json" "$SERVER_PAYLOAD/lib/node_modules/paperclipai/node_modules/@paperclipai/server/package.json"
PACKED_RUNNER="$SERVER_FIXTURE/package/dist/vendor/paperclip-runner/bin/paperclip-runnerd"
INSTALLED_RUNNER="$SERVER_PAYLOAD/lib/node_modules/paperclipai/node_modules/@paperclipai/server/dist/vendor/paperclip-runner/bin/paperclip-runnerd"
mkdir -p "$(dirname "$PACKED_RUNNER")" "$(dirname "$INSTALLED_RUNNER")"
printf '%s\n' 'runner-binary-fixture' > "$PACKED_RUNNER"
cp "$PACKED_RUNNER" "$INSTALLED_RUNNER"
chmod 0644 "$PACKED_RUNNER" "$INSTALLED_RUNNER"
tar -czf "$SANDBOX/paperclipai-server-9.8.7.tgz" -C "$SERVER_FIXTURE" package
capture out10 code10 env ENGINE_DIR_FOR_TEST="$ENGINE_DIR" SERVER_PAYLOAD="$SERVER_PAYLOAD" SERVER_TARBALL="$SANDBOX/paperclipai-server-9.8.7.tgz" bash -c '
  set -euo pipefail
  . "$ENGINE_DIR_FOR_TEST/lib.sh"
  verify_fork_server_package "$SERVER_PAYLOAD" "$SERVER_TARBALL"
'
assert_eq "real nested layout: verification exits 0" "0" "$code10"
assert_contains "real nested layout: reports verified source package" "$out10" "Verified fork server package"
assert_true "npm-normalized runner mode is repaired to executable" test -x "$INSTALLED_RUNNER"

printf '%s\n' 'tampered-runner' > "$INSTALLED_RUNNER"
chmod 0755 "$INSTALLED_RUNNER"
capture out10b code10b env ENGINE_DIR_FOR_TEST="$ENGINE_DIR" SERVER_PAYLOAD="$SERVER_PAYLOAD" SERVER_TARBALL="$SANDBOX/paperclipai-server-9.8.7.tgz" bash -c '
  set -euo pipefail
  . "$ENGINE_DIR_FOR_TEST/lib.sh"
  verify_fork_server_package "$SERVER_PAYLOAD" "$SERVER_TARBALL"
'
assert_eq "runner hash mismatch fails closed" "1" "$code10b"
assert_contains "runner hash mismatch explains failure" "$out10b" "runner binary hash mismatch"

: > "$INSTALLED_RUNNER"
capture out10z code10z env ENGINE_DIR_FOR_TEST="$ENGINE_DIR" SERVER_PAYLOAD="$SERVER_PAYLOAD" SERVER_TARBALL="$SANDBOX/paperclipai-server-9.8.7.tgz" bash -c '
  set -euo pipefail
  . "$ENGINE_DIR_FOR_TEST/lib.sh"
  verify_fork_server_package "$SERVER_PAYLOAD" "$SERVER_TARBALL"
'
assert_eq "zero-byte staged runner fails closed" "1" "$code10z"
assert_contains "zero-byte runner explains failure" "$out10z" "missing or empty"

echo "== test 11: fork server package verification rejects missing installed server =="
rm -rf "$SERVER_PAYLOAD/lib/node_modules/paperclipai/node_modules/@paperclipai/server"
capture out11 code11 env ENGINE_DIR_FOR_TEST="$ENGINE_DIR" SERVER_PAYLOAD="$SERVER_PAYLOAD" SERVER_TARBALL="$SANDBOX/paperclipai-server-9.8.7.tgz" bash -c '
  set -euo pipefail
  . "$ENGINE_DIR_FOR_TEST/lib.sh"
  verify_fork_server_package "$SERVER_PAYLOAD" "$SERVER_TARBALL"
'
assert_eq "missing server: verification exits non-zero" "1" "$code11"
assert_contains "missing server: abort is explicit" "$out11" "Required fork server package"

echo "== test 12: existing live topology is adopted before staging a replacement =="
ADOPT_HOME="$SANDBOX/adopt-home"
ADOPT_ROOT="$SANDBOX/adopt-root"
ADOPT_PREFIX="$SANDBOX/usr"
ADOPT_LINK="$ADOPT_ROOT/paperclip-current"
ADOPT_STATE="$ADOPT_ROOT/.paperclip-engine"
mkdir -p "$ADOPT_HOME/.config/systemd/user" "$ADOPT_PREFIX/lib/node_modules/paperclipai" "$ADOPT_PREFIX/bin"
printf '%s\n' '[Service]' 'ExecStart=/usr/bin/node /usr/lib/node_modules/paperclipai/dist/index.js run' > "$ADOPT_HOME/.config/systemd/user/paperclip.service"
mkdir -p "$ADOPT_HOME/.config/systemd/user/paperclip.service.d"
printf '%s\n' '[Service]' 'Environment=KEEP_ME=1' > "$ADOPT_HOME/.config/systemd/user/paperclip.service.d/override-opencode.conf"
printf '%s\n' '{"name":"paperclipai","version":"2026.831.1"}' > "$ADOPT_PREFIX/lib/node_modules/paperclipai/package.json"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$ADOPT_PREFIX/bin/paperclipai"
chmod +x "$ADOPT_PREFIX/bin/paperclipai"
capture out12 code12 env \
  HOME="$ADOPT_HOME" \
  ENGINE_ROOT="$ADOPT_ROOT" \
  PAPERCLIP_HOME="$PAPERCLIP_HOME" \
  CURRENT_LINK="$ADOPT_LINK" \
  UNIT_NAME=paperclip.service \
  STATE_DIR="$ADOPT_STATE" \
  PAPERCLIP_ENGINE_ADOPT_EXISTING_PREFIX="$ADOPT_PREFIX" \
  "$ENGINE_DIR/install.sh" npm:12.0.0
echo "$out12" | sed 's/^/    /'
assert_eq "adoption install exits 0" "0" "$code12"
assert_eq "adoption records legacy prefix for rollback" "$ADOPT_PREFIX" "$(cat "$ADOPT_STATE/previous-prefix")"
assert_eq "adoption cutover points at staged prefix" "$ADOPT_ROOT/paperclip-12.0.0" "$(readlink "$ADOPT_LINK")"
adopt_log_pos="$(printf '%s\n' "$out12" | grep -n "Seeded current link from adopted prefix" | cut -d: -f1)"
stage_log_pos="$(printf '%s\n' "$out12" | grep -n "Staged fake dry-run payload" | cut -d: -f1)"
assert_true "legacy link is seeded before replacement staging" test "$adopt_log_pos" -lt "$stage_log_pos"
assert_contains "adoption reports managed drop-in dry-run" "$out12" "would ensure adoption drop-in"

echo "== test 12b: adoption is idempotent after managed cutover =="
capture out12b code12b env \
  HOME="$ADOPT_HOME" \
  ENGINE_ROOT="$ADOPT_ROOT" \
  PAPERCLIP_HOME="$PAPERCLIP_HOME" \
  CURRENT_LINK="$ADOPT_LINK" \
  UNIT_NAME=paperclip.service \
  STATE_DIR="$ADOPT_STATE" \
  PAPERCLIP_ENGINE_ADOPT_EXISTING_PREFIX="$ADOPT_PREFIX" \
  "$ENGINE_DIR/install.sh" npm:12.0.0
assert_eq "adoption re-install exits 0" "0" "$code12b"
assert_contains "adoption re-install reuses staged prefix" "$out12b" "Reusing already-installed prefix"

echo "== test 12c: adoption rejects an unknown current link before staging =="
UNKNOWN_PREFIX="$SANDBOX/unknown-prefix"
mkdir -p "$UNKNOWN_PREFIX"
ln -sfn "$UNKNOWN_PREFIX" "$ADOPT_LINK"
capture out12c code12c env \
  HOME="$ADOPT_HOME" \
  ENGINE_ROOT="$ADOPT_ROOT" \
  PAPERCLIP_HOME="$PAPERCLIP_HOME" \
  CURRENT_LINK="$ADOPT_LINK" \
  UNIT_NAME=paperclip.service \
  STATE_DIR="$ADOPT_STATE" \
  PAPERCLIP_ENGINE_ADOPT_EXISTING_PREFIX="$ADOPT_PREFIX" \
  "$ENGINE_DIR/install.sh" npm:13.0.0
assert_eq "unknown adoption link exits non-zero" "1" "$code12c"
assert_contains "unknown adoption link explains conflict" "$out12c" "points outside the adopted or managed prefixes"
assert_true "unknown adoption link fails before staging" test ! -e "$ADOPT_ROOT/paperclip-13.0.0"

echo "== test 13: real adoption writes only a managed ExecStart drop-in and verifies it =="
FAKE_ADOPT_BIN="$SANDBOX/fake-adopt-bin"
mkdir -p "$FAKE_ADOPT_BIN"
cat > "$FAKE_ADOPT_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "--user" ] && [ "${2:-}" = "show" ]; then
  printf '%s\n' "ExecStart={ path=${EXPECTED_CURRENT_LINK}/bin/paperclipai ; argv[]=${EXPECTED_CURRENT_LINK}/bin/paperclipai run --instance default ; }"
fi
exit 0
EOF
chmod +x "$FAKE_ADOPT_BIN/systemctl"
rm -f "$ADOPT_LINK"
capture out13 code13 env \
  PATH="$FAKE_ADOPT_BIN:$PATH" \
  HOME="$ADOPT_HOME" \
  ENGINE_ROOT="$ADOPT_ROOT" \
  PAPERCLIP_HOME="$PAPERCLIP_HOME" \
  CURRENT_LINK="$ADOPT_LINK" \
  UNIT_NAME=paperclip.service \
  STATE_DIR="$ADOPT_STATE" \
  PAPERCLIP_ENGINE_DRY_RUN=0 \
  PAPERCLIP_ENGINE_ADOPT_EXISTING_PREFIX="$ADOPT_PREFIX" \
  EXPECTED_CURRENT_LINK="$ADOPT_LINK" \
  ENGINE_DIR_FOR_TEST="$ENGINE_DIR" \
  bash -c '. "$ENGINE_DIR_FOR_TEST/lib.sh"; prepare_existing_prefix_adoption'
echo "$out13" | sed 's/^/    /'
assert_eq "real adoption helper exits 0" "0" "$code13"
assert_eq "real adoption seeds legacy current link" "$ADOPT_PREFIX" "$(readlink "$ADOPT_LINK")"
assert_true "managed drop-in sorts after existing overrides" test -f "$ADOPT_HOME/.config/systemd/user/paperclip.service.d/zzzz-paperclip-engine-current.conf"
assert_contains "managed drop-in targets current link" "$(cat "$ADOPT_HOME/.config/systemd/user/paperclip.service.d/zzzz-paperclip-engine-current.conf")" "$ADOPT_LINK/bin/paperclipai"
assert_eq "base unit remains unchanged" $'[Service]\nExecStart=/usr/bin/node /usr/lib/node_modules/paperclipai/dist/index.js run' "$(cat "$ADOPT_HOME/.config/systemd/user/paperclip.service")"
assert_eq "existing drop-in remains unchanged" $'[Service]\nEnvironment=KEEP_ME=1' "$(cat "$ADOPT_HOME/.config/systemd/user/paperclip.service.d/override-opencode.conf")"
assert_contains "effective ExecStart verification reported" "$out13" "Verified effective ExecStart"

echo "== test 14: unusable backups stop install before build, migration, symlink, or service =="
BACKUP_HOME="$SANDBOX/backup-home"
BACKUP_ROOT="$SANDBOX/backup-root"
BACKUP_INSTANCE="$SANDBOX/backup-paperclip/instances/default"
BACKUP_LINK="$BACKUP_ROOT/paperclip-current"
BACKUP_OLD="$BACKUP_ROOT/paperclip-old"
BACKUP_BIN="$SANDBOX/backup-bin"
BACKUP_MARKERS="$SANDBOX/backup-markers"
mkdir -p "$BACKUP_HOME/.config/systemd/user" "$BACKUP_INSTANCE" "$BACKUP_OLD/lib/node_modules/paperclipai" "$BACKUP_OLD/bin" "$BACKUP_BIN" "$BACKUP_MARKERS"
cp "$ENGINE_DIR/systemd/paperclip-831.service" "$BACKUP_HOME/.config/systemd/user/paperclip-831.service"
printf '%s\n' '{"name":"paperclipai","version":"old"}' > "$BACKUP_OLD/lib/node_modules/paperclipai/package.json"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$BACKUP_OLD/bin/paperclipai"
chmod +x "$BACKUP_OLD/bin/paperclipai"
ln -s "$BACKUP_OLD" "$BACKUP_LINK"
cat > "$BACKUP_INSTANCE/config.json" <<EOF
{"server":{"host":"127.0.0.1","port":$HEALTH_PORT},"database":{"mode":"postgres","connectionString":"postgres://fake:fake@127.0.0.1:5432/paperclip831"}}
EOF
cat > "$BACKUP_BIN/psql" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "$BACKUP_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$BACKUP_MARKERS/systemctl"
exit 0
EOF
cat > "$BACKUP_BIN/npm" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$BACKUP_MARKERS/npm"
exit 99
EOF
cat > "$BACKUP_BIN/pg_restore" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "--list" ]; then
  grep -q VALID_DUMP "${2:-}" 2>/dev/null
  exit $?
fi
exit 0
EOF
chmod +x "$BACKUP_BIN"/*

run_bad_backup_case() {
  local mode="$1" version="$2"
  rm -f "$BACKUP_MARKERS/systemctl" "$BACKUP_MARKERS/npm"
  cat > "$BACKUP_BIN/pg_dump" <<EOF
#!/usr/bin/env bash
out=""
while [ "\$#" -gt 0 ]; do
  if [ "\$1" = "-f" ]; then shift; out="\$1"; fi
  shift
done
case "$mode" in
  exit23) exit 23 ;;
  empty) : > "\$out" ;;
  corrupt) printf '%s\\n' CORRUPT > "\$out" ;;
esac
EOF
  chmod +x "$BACKUP_BIN/pg_dump"
  capture bad_out bad_code env \
    PATH="$BACKUP_BIN:$PATH" \
    HOME="$BACKUP_HOME" \
    PAPERCLIP_ENGINE_DRY_RUN=0 \
    ENGINE_ROOT="$BACKUP_ROOT" \
    PAPERCLIP_HOME="$SANDBOX/backup-paperclip" \
    PAPERCLIP_INSTANCE_ID=default \
    CURRENT_LINK="$BACKUP_LINK" \
    UNIT_NAME=paperclip-831.service \
    EXPECTED_DB=paperclip831 \
    BACKUP_DIR="$BACKUP_ROOT/backups" \
    STATE_DIR="$BACKUP_ROOT/state" \
    MIN_FREE_KB=0 \
    BACKUP_MARKERS="$BACKUP_MARKERS" \
    "$ENGINE_DIR/install.sh" "npm:$version"
  assert_true "$mode backup: install exits non-zero" test "$bad_code" -ne 0
  assert_eq "$mode backup: current link unchanged" "$BACKUP_OLD" "$(readlink "$BACKUP_LINK")"
  assert_true "$mode backup: no replacement prefix" test ! -e "$BACKUP_ROOT/paperclip-$version"
  assert_true "$mode backup: npm build not reached" test ! -e "$BACKUP_MARKERS/npm"
  assert_true "$mode backup: service not touched" test ! -e "$BACKUP_MARKERS/systemctl"
}

run_bad_backup_case exit23 14.0.1
run_bad_backup_case empty 14.0.2
run_bad_backup_case corrupt 14.0.3

echo "== test 15: migration resolver supports nested package and fails closed =="
MIGRATE_PREFIX="$SANDBOX/migrate-prefix"
NESTED_MIGRATE="$MIGRATE_PREFIX/lib/node_modules/paperclipai/node_modules/@paperclipai/db/dist/migrate.js"
mkdir -p "$(dirname "$NESTED_MIGRATE")"
printf '%s\n' 'export {};' > "$NESTED_MIGRATE"
capture out15 code15 env \
  PAPERCLIP_ENGINE_DRY_RUN=0 \
  ENGINE_DIR_FOR_TEST="$ENGINE_DIR" \
  MIGRATE_PREFIX="$MIGRATE_PREFIX" \
  bash -c '. "$ENGINE_DIR_FOR_TEST/lib.sh"; resolve_migration_artifact "$MIGRATE_PREFIX"'
assert_eq "nested migration artifact resolves" "0" "$code15"
assert_eq "nested migration artifact path is exact" "$NESTED_MIGRATE" "$out15"

rm -f "$NESTED_MIGRATE"
capture out15b code15b env \
  PAPERCLIP_ENGINE_DRY_RUN=0 \
  ENGINE_DIR_FOR_TEST="$ENGINE_DIR" \
  MIGRATE_PREFIX="$MIGRATE_PREFIX" \
  bash -c '. "$ENGINE_DIR_FOR_TEST/lib.sh"; resolve_migration_artifact "$MIGRATE_PREFIX"'
assert_eq "missing migration artifact fails closed" "1" "$code15b"
assert_contains "missing migration artifact explains failure" "$out15b" "no installed @paperclipai/db migration artifact"

HOISTED_MIGRATE="$MIGRATE_PREFIX/lib/node_modules/@paperclipai/db/dist/migrate.js"
mkdir -p "$(dirname "$HOISTED_MIGRATE")" "$(dirname "$NESTED_MIGRATE")"
printf '%s\n' 'export {};' > "$HOISTED_MIGRATE"
printf '%s\n' 'export {};' > "$NESTED_MIGRATE"
capture out15c code15c env \
  PAPERCLIP_ENGINE_DRY_RUN=0 \
  ENGINE_DIR_FOR_TEST="$ENGINE_DIR" \
  MIGRATE_PREFIX="$MIGRATE_PREFIX" \
  bash -c '. "$ENGINE_DIR_FOR_TEST/lib.sh"; resolve_migration_artifact "$MIGRATE_PREFIX"'
assert_eq "ambiguous migration artifacts fail closed" "1" "$code15c"
assert_contains "ambiguous migration artifacts explain failure" "$out15c" "ambiguous @paperclipai/db migration artifacts"

echo "== test 16: database tools use temporary libpq credentials without URI argv leaks =="
SECURE_BIN="$SANDBOX/secure-bin"
SECURE_MARKERS="$SANDBOX/secure-markers"
mkdir -p "$SECURE_BIN" "$SECURE_MARKERS"
cat > "$SECURE_BIN/db-tool" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
tool="$(basename "$0")"
if [ "$tool" = pg_restore ] && [ "${1:-}" = --list ]; then
  grep -q VALID_DUMP "${2:-}" 2>/dev/null
  exit $?
fi
case "$*" in
  *super-secret*|*postgresql://*) exit 81 ;;
esac
[ "${PGSERVICE:-}" = paperclip_engine ]
[ -f "${PGSERVICEFILE:-}" ]
[ -f "${PGPASSFILE:-}" ]
node -e '
  const fs = require("fs");
  for (const path of process.argv.slice(1)) {
    if ((fs.statSync(path).mode & 0o777) !== 0o600) process.exit(1);
    if ((fs.statSync(require("path").dirname(path)).mode & 0o777) !== 0o700) process.exit(1);
  }
' "$PGSERVICEFILE" "$PGPASSFILE"
grep -Fxq 'sslmode=require' "$PGSERVICEFILE"
grep -Fxq 'connect_timeout=7' "$PGSERVICEFILE"
grep -Fq 'super-secret' "$PGPASSFILE"
printf '%s\n' "$(dirname "$PGSERVICEFILE")" >> "$SECURE_MARKERS/credential-dirs"
printf '%s\n' "$*" >> "$SECURE_MARKERS/$tool-argv"
case "$tool" in
  psql) printf '%s\n' 7 ;;
  pg_dump)
    out=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = -f ]; then shift; out="$1"; fi
      shift
    done
    printf '%s\n' VALID_DUMP > "$out"
    ;;
  failing-tool) exit 42 ;;
  signal-tool) kill -TERM "$PPID" ;;
esac
EOF
chmod +x "$SECURE_BIN/db-tool"
ln -s db-tool "$SECURE_BIN/psql"
ln -s db-tool "$SECURE_BIN/pg_dump"
ln -s db-tool "$SECURE_BIN/pg_restore"
ln -s db-tool "$SECURE_BIN/failing-tool"
ln -s db-tool "$SECURE_BIN/signal-tool"
SECURE_URI='postgresql://paperclip:super-secret@127.0.0.1:5432/paperclip831?sslmode=require&connect_timeout=7'
capture out16 code16 env \
  PATH="$SECURE_BIN:$PATH" \
  PAPERCLIP_ENGINE_DRY_RUN=0 \
  BACKUP_DIR="$SANDBOX/secure-backups" \
  SECURE_MARKERS="$SECURE_MARKERS" \
  SECURE_URI="$SECURE_URI" \
  ENGINE_DIR_FOR_TEST="$ENGINE_DIR" \
  bash -c '
    set -euo pipefail
    . "$ENGINE_DIR_FOR_TEST/lib.sh"
    database_reachable "$SECURE_URI"
    migration_count "$SECURE_URI" >/dev/null
    agents_paused_count "$SECURE_URI" >/dev/null
    backup_database "$SECURE_URI" secure >/dev/null
    secure_database_command "$SECURE_URI" pg_restore --exit-on-error fixture.dump
  '
assert_eq "secure DB commands exit 0" "0" "$code16"
assert_true "secure DB command logs contain no password or URI" bash -c '[[ "$1" != *super-secret* && "$1" != *postgresql://* ]]' _ "$out16"
assert_true "psql argv contains no URI or password" bash -c '! grep -Eq "super-secret|postgresql://" "$1"' _ "$SECURE_MARKERS/psql-argv"
assert_true "pg_dump argv contains no URI or password" bash -c '! grep -Eq "super-secret|postgresql://" "$1"' _ "$SECURE_MARKERS/pg_dump-argv"
assert_true "pg_restore argv contains no URI or password" bash -c '! grep -Eq "super-secret|postgresql://" "$1"' _ "$SECURE_MARKERS/pg_restore-argv"
while IFS= read -r credential_dir; do
  assert_true "temporary credential directory is removed" test ! -e "$credential_dir"
done < "$SECURE_MARKERS/credential-dirs"

capture out16f code16f env \
  PATH="$SECURE_BIN:$PATH" \
  PAPERCLIP_ENGINE_DRY_RUN=0 \
  SECURE_MARKERS="$SECURE_MARKERS" \
  SECURE_URI="$SECURE_URI" \
  ENGINE_DIR_FOR_TEST="$ENGINE_DIR" \
  bash -c '. "$ENGINE_DIR_FOR_TEST/lib.sh"; secure_database_command "$SECURE_URI" failing-tool'
assert_eq "database command failure is preserved" "42" "$code16f"
failed_credential_dir="$(tail -n 1 "$SECURE_MARKERS/credential-dirs")"
assert_true "credentials removed after command failure" test ! -e "$failed_credential_dir"

capture out16s code16s env \
  PATH="$SECURE_BIN:$PATH" \
  PAPERCLIP_ENGINE_DRY_RUN=0 \
  SECURE_MARKERS="$SECURE_MARKERS" \
  SECURE_URI="$SECURE_URI" \
  ENGINE_DIR_FOR_TEST="$ENGINE_DIR" \
  bash -c '. "$ENGINE_DIR_FOR_TEST/lib.sh"; secure_database_command "$SECURE_URI" signal-tool'
assert_eq "signal terminates secure command" "143" "$code16s"
signal_credential_dir="$(tail -n 1 "$SECURE_MARKERS/credential-dirs")"
assert_true "credentials removed after signal" test ! -e "$signal_credential_dir"

rm -f "$SECURE_MARKERS/psql-argv"
SECURE_TMP="$SANDBOX/secure-tmp"
mkdir -p "$SECURE_TMP"
capture out16b code16b env \
  PATH="$SECURE_BIN:$PATH" \
  TMPDIR="$SECURE_TMP" \
  PAPERCLIP_ENGINE_DRY_RUN=0 \
  SECURE_MARKERS="$SECURE_MARKERS" \
  SECURE_URI='postgresql://paperclip:super-secret@127.0.0.1:5432/paperclip831?unknown_option=bad' \
  ENGINE_DIR_FOR_TEST="$ENGINE_DIR" \
  bash -c '. "$ENGINE_DIR_FOR_TEST/lib.sh"; database_reachable "$SECURE_URI"'
assert_eq "unsupported URI option fails closed" "1" "$code16b"
assert_contains "unsupported option is named without secret" "$out16b" "Unsupported PostgreSQL connection option: unknown_option"
assert_true "unsupported option never invokes psql" test ! -e "$SECURE_MARKERS/psql-argv"
assert_true "failure output contains no password" bash -c '[[ "$1" != *super-secret* ]]' _ "$out16b"
assert_true "credentials removed after URI validation failure" bash -c '[ -z "$(find "$1" -mindepth 1 -print -quit)" ]' _ "$SECURE_TMP"

echo "== test 17: pnpm toolchain creates install directory before corepack =="
COREPACK_BIN="$SANDBOX/corepack-bin"
COREPACK_STAGE="$SANDBOX/corepack-stage"
mkdir -p "$COREPACK_BIN"
cat > "$COREPACK_BIN/corepack" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ "${1:-}" = enable ]
[ "${2:-}" = pnpm ]
[ "${3:-}" = --install-directory ]
[ -d "${4:-}" ]
printf '%s\n' "$4" > "$COREPACK_MARKER"
EOF
chmod +x "$COREPACK_BIN/corepack"
capture out17 code17 env \
  PATH="$COREPACK_BIN:$PATH" \
  PAPERCLIP_ENGINE_DRY_RUN=0 \
  COREPACK_MARKER="$SANDBOX/corepack-marker" \
  COREPACK_STAGE="$COREPACK_STAGE" \
  ENGINE_DIR_FOR_TEST="$ENGINE_DIR" \
  bash -c '. "$ENGINE_DIR_FOR_TEST/lib.sh"; prepare_pnpm_toolchain "$COREPACK_STAGE"'
assert_eq "pnpm toolchain helper exits 0" "0" "$code17"
assert_eq "corepack observes existing pnpm-bin directory" "$COREPACK_STAGE/pnpm-bin" "$(cat "$SANDBOX/corepack-marker" 2>/dev/null || true)"

echo "== test 18: fork Rust preflight runs before topology adoption =="
RUST_BIN="$SANDBOX/rust-bin"
RUST_HOME="$SANDBOX/rust-home"
RUST_ROOT="$SANDBOX/rust-root"
RUST_PREFIX="$SANDBOX/rust-prefix"
RUST_SOURCE="$SANDBOX/rust-source"
mkdir -p "$RUST_BIN" "$RUST_HOME/.config/systemd/user" "$RUST_PREFIX/lib/node_modules/paperclipai" "$RUST_PREFIX/bin" "$RUST_SOURCE/packages/paperclip-runner"
printf '%s\n' '[toolchain]' 'channel = "1.97.1"' > "$RUST_SOURCE/packages/paperclip-runner/rust-toolchain.toml"
cat > "$RUST_BIN/cargo" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' 'cargo 1.96.0 (wrong)'
EOF
cat > "$RUST_BIN/rustc" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' 'rustc 1.96.0 (wrong)'
EOF
chmod +x "$RUST_BIN/cargo" "$RUST_BIN/rustc"
printf '%s\n' '[Service]' 'ExecStart=/usr/bin/false' > "$RUST_HOME/.config/systemd/user/paperclip.service"
printf '%s\n' '{"name":"paperclipai","version":"legacy"}' > "$RUST_PREFIX/lib/node_modules/paperclipai/package.json"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$RUST_PREFIX/bin/paperclipai"
chmod +x "$RUST_PREFIX/bin/paperclipai"
capture out18 code18 env \
  PATH="$RUST_BIN:$PATH" \
  HOME="$RUST_HOME" \
  ENGINE_ROOT="$RUST_ROOT" \
  CURRENT_LINK="$RUST_ROOT/paperclip-current" \
  UNIT_NAME=paperclip.service \
  PAPERCLIP_ENGINE_DRY_RUN=0 \
  PAPERCLIP_ENGINE_ADOPT_EXISTING_PREFIX="$RUST_PREFIX" \
  FORK_SOURCE_REPO="$RUST_SOURCE" \
  "$ENGINE_DIR/install.sh" fork:HEAD
assert_eq "wrong Rust toolchain aborts fork install" "1" "$code18"
assert_contains "wrong Rust toolchain names pinned version" "$out18" "Rust 1.97.1"
assert_true "Rust preflight fails before adoption symlink" test ! -e "$RUST_ROOT/paperclip-current"
assert_true "Rust preflight fails before managed drop-in" test ! -e "$RUST_HOME/.config/systemd/user/paperclip.service.d"

echo "== test 19: fork tarballs install into managed global-prefix layout =="
GLOBAL_BIN="$SANDBOX/global-npm-bin"
GLOBAL_PAYLOAD="$SANDBOX/global-payload"
mkdir -p "$GLOBAL_BIN"
cat > "$GLOBAL_BIN/npm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" > "$NPM_ARGS_MARKER"
prefix=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--prefix" ]; then
    prefix="$2"
    shift 2
    continue
  fi
  shift
done
[ -n "$prefix" ]
mkdir -p "$prefix/lib/node_modules/@paperclipai/server" "$prefix/lib/node_modules/paperclipai" "$prefix/bin"
printf '%s\n' '{"name":"@paperclipai/server","version":"1.0.0"}' > "$prefix/lib/node_modules/@paperclipai/server/package.json"
printf '%s\n' '{"name":"paperclipai","version":"1.0.0"}' > "$prefix/lib/node_modules/paperclipai/package.json"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$prefix/bin/paperclipai"
chmod 0755 "$prefix/bin/paperclipai"
EOF
chmod +x "$GLOBAL_BIN/npm"
capture out19 code19 env \
  PATH="$GLOBAL_BIN:$PATH" \
  NPM_ARGS_MARKER="$SANDBOX/global-npm-args" \
  PAPERCLIP_ENGINE_DRY_RUN=0 \
  ENGINE_DIR_FOR_TEST="$ENGINE_DIR" \
  GLOBAL_PAYLOAD="$GLOBAL_PAYLOAD" \
  bash -c '
    set -euo pipefail
    . "$ENGINE_DIR_FOR_TEST/lib.sh"
    install_fork_payload "$GLOBAL_PAYLOAD" cli.tgz server.tgz
  '
assert_eq "global-prefix helper exits 0" "0" "$code19"
assert_contains "fork install uses npm global mode" "$(cat "$SANDBOX/global-npm-args" 2>/dev/null || true)" "install --global --prefix $GLOBAL_PAYLOAD"
assert_true "global-prefix server layout is discoverable" test -f "$GLOBAL_PAYLOAD/lib/node_modules/@paperclipai/server/package.json"
assert_true "global-prefix CLI shim is executable" test -x "$GLOBAL_PAYLOAD/bin/paperclipai"

echo "== test 20: registry package installs into managed global-prefix layout =="
NPM_PAYLOAD="$SANDBOX/npm-payload"
rm -f "$SANDBOX/global-npm-args"
capture out20 code20 env \
  PATH="$GLOBAL_BIN:$PATH" \
  NPM_ARGS_MARKER="$SANDBOX/global-npm-args" \
  PAPERCLIP_ENGINE_DRY_RUN=0 \
  ENGINE_DIR_FOR_TEST="$ENGINE_DIR" \
  NPM_PAYLOAD="$NPM_PAYLOAD" \
  bash -c '
    set -euo pipefail
    . "$ENGINE_DIR_FOR_TEST/lib.sh"
    install_npm_payload "$NPM_PAYLOAD" "4.5.6"
  '
assert_eq "registry global-prefix helper exits 0" "0" "$code20"
assert_contains "registry install uses npm global mode" "$(cat "$SANDBOX/global-npm-args" 2>/dev/null || true)" "install --global --prefix $NPM_PAYLOAD paperclipai@4.5.6"
assert_true "registry global-prefix package layout exists" test -f "$NPM_PAYLOAD/lib/node_modules/paperclipai/package.json"
assert_true "registry global-prefix CLI shim is executable" test -x "$NPM_PAYLOAD/bin/paperclipai"

echo "== test 21: compiled overlay targets nested runtime roots and receipts provenance =="
OVERLAY_PREFIX="$SANDBOX/overlay-prefix"
OVERLAY_BUILD="$SANDBOX/overlay-build"
CLI_ROOT="$OVERLAY_PREFIX/lib/node_modules/paperclipai"
mkdir -p "$CLI_ROOT" "$CLI_ROOT/node_modules/@paperclipai" \
  "$OVERLAY_BUILD/packages/shared/dist" "$OVERLAY_BUILD/packages/db/dist/migrations" \
  "$OVERLAY_BUILD/server/dist/vendor/paperclip-runner/bin" "$OVERLAY_BUILD/server/ui-dist" "$OVERLAY_BUILD/server/skills"
printf '%s\n' '{"name":"paperclipai","version":"2026.831.1"}' > "$CLI_ROOT/package.json"
mkdir -p "$OVERLAY_PREFIX/bin" "$CLI_ROOT/dist" "$CLI_ROOT/node_modules/.bin" "$CLI_ROOT/node_modules/native/lib"
printf 'cli\n' > "$CLI_ROOT/dist/index.js"; printf 'native\n' > "$CLI_ROOT/node_modules/native/lib/native.so"
ln -s ../lib/node_modules/paperclipai/dist/index.js "$OVERLAY_PREFIX/bin/paperclipai"
ln -s ../@paperclipai/server/dist/index.js "$CLI_ROOT/node_modules/.bin/paperclip-server"
ln -s lib/native.so "$CLI_ROOT/node_modules/native/current.so"
for p in shared db server; do d="$CLI_ROOT/node_modules/@paperclipai/$p"; mkdir -p "$d"; printf '{"name":"@paperclipai/%s","version":"2026.831.1","main":"dist/index.js"}\n' "$p" > "$d/package.json"; mkdir -p "$d/dist"; printf 'old\n' > "$d/dist/index.js"; done
printf 'stale\n' > "$CLI_ROOT/node_modules/@paperclipai/server/dist/stale.js"
printf 'new\n' > "$OVERLAY_BUILD/packages/shared/dist/index.js"
printf 'new\n' > "$OVERLAY_BUILD/packages/db/dist/index.js"
printf 'migration\n' > "$OVERLAY_BUILD/packages/db/dist/migrations/0001.sql"
mkdir -p "$OVERLAY_BUILD/packages/db/dist/migrations/meta"
printf '%s\n' '{"entries":[]}' > "$OVERLAY_BUILD/packages/db/dist/migrations/meta/_journal.json"
printf 'new\n' > "$OVERLAY_BUILD/server/dist/index.js"
printf '%s\n' '{"commit":"0123456789012345678901234567890123456789"}' > "$OVERLAY_BUILD/server/dist/build-info.json"
printf 'runner\n' > "$OVERLAY_BUILD/server/dist/vendor/paperclip-runner/bin/paperclip-runnerd"
printf 'ui\n' > "$OVERLAY_BUILD/server/ui-dist/index.html"
printf 'skill\n' > "$OVERLAY_BUILD/server/skills/catalog.json"
capture out21 code21 node "$ENGINE_DIR/overlay-contract.mjs" "$OVERLAY_PREFIX" "$OVERLAY_BUILD" 0123456789012345678901234567890123456789 "$OVERLAY_PREFIX/.paperclip-engine-overlay.json"
assert_eq "overlay contract exits 0" "0" "$code21"
assert_contains "overlay receipt records source provenance" "$(cat "$OVERLAY_PREFIX/.paperclip-engine-overlay.json" 2>/dev/null || true)" "0123456789012345678901234567890123456789"
assert_contains "official manifest remains unchanged" "$(cat "$CLI_ROOT/node_modules/@paperclipai/server/package.json")" '"version":"2026.831.1"'
assert_eq "nested runtime server received overlay" "new" "$(cat "$CLI_ROOT/node_modules/@paperclipai/server/dist/index.js")"
assert_true "exclusive replacement removes stale compiled files" test ! -e "$CLI_ROOT/node_modules/@paperclipai/server/dist/stale.js"
assert_true "runner mode repaired to 0755" test -x "$CLI_ROOT/node_modules/@paperclipai/server/dist/vendor/paperclip-runner/bin/paperclip-runnerd"
capture out21v code21v node "$ENGINE_DIR/overlay-contract.mjs" --verify "$OVERLAY_PREFIX" 0123456789012345678901234567890123456789 "$OVERLAY_PREFIX/.paperclip-engine-overlay.json"
assert_eq "matching receipt validates reuse" "0" "$code21v"
REPORT_HOME="$SANDBOX/report-home"; REPORT_BIN="$SANDBOX/report-bin"; mkdir -p "$REPORT_HOME" "$REPORT_BIN"
REPORT_PROC="$SANDBOX/report-proc"; mkdir -p "$REPORT_PROC/4242"; ln -s "$(command -v node)" "$REPORT_PROC/4242/exe"
printf '%s\0%s\0%s\0' node "$OVERLAY_PREFIX-link/lib/node_modules/paperclipai/dist/index.js" run > "$REPORT_PROC/4242/cmdline"
cat > "$REPORT_BIN/systemctl" <<EOF
#!/usr/bin/env bash
case "\$*" in *ActiveState*) echo active;; *MainPID*) echo 4242;; *ExecStart*) echo '$OVERLAY_PREFIX-link/bin/paperclipai run';; esac
EOF
chmod +x "$REPORT_BIN/systemctl"
capture report_out report_code env PATH="$REPORT_BIN:$PATH" HOME="$REPORT_HOME" CURRENT_LINK="$OVERLAY_PREFIX-link" UNIT_NAME=paperclip.service PAPERCLIP_ENGINE_SCRIPT_DIR="$ENGINE_DIR" PAPERCLIP_PROC_ROOT="$REPORT_PROC" bash -c 'ln -s "$0" "$CURRENT_LINK"; exec "$1/whats-running.sh"' "$OVERLAY_PREFIX" "$ENGINE_DIR"
echo "$report_out" | sed 's/^/    /'
assert_eq "managed current-link process is recognized" "0" "$report_code"
assert_contains "managed runtime report says running" "$report_out" "Engine running : YES"
assert_contains "report lists changed path and final hash" "$report_out" "CHANGED lib/node_modules/paperclipai/node_modules/@paperclipai/server/dist/index.js sha256:"
assert_contains "report lists deleted stale path" "$report_out" "DELETED lib/node_modules/paperclipai/node_modules/@paperclipai/server/dist/stale.js"
cat > "$SANDBOX/change-receipt.json" <<'EOF'
{"baselineInventory":[{"path":"z","type":"file","sha256":"oldz","size":1,"mode":420},{"path":"b","type":"file","sha256":"oldb","size":1,"mode":420}],"finalInventory":[{"path":"a","type":"symlink","target":"relative/target"},{"path":"b","type":"file","sha256":"newb","size":2,"mode":420}]}
EOF
capture changes_out changes_code node "$ENGINE_DIR/overlay-contract.mjs" --changes "$SANDBOX/change-receipt.json"
assert_eq "deterministic added/changed/deleted/symlink output" $'ADDED a symlink:relative/target\nCHANGED b sha256:newb\nDELETED z sha256:oldz' "$changes_out"
printf '%s\0%s\0%s\0' node /usr/lib/node_modules/paperclipai/dist/index.js "$OVERLAY_PREFIX-link/lib/node_modules/paperclipai/dist/index.js" > "$REPORT_PROC/4242/cmdline"
capture old_report_out old_report_code env PATH="$REPORT_BIN:$PATH" HOME="$REPORT_HOME" CURRENT_LINK="$OVERLAY_PREFIX-link" UNIT_NAME=paperclip.service PAPERCLIP_ENGINE_SCRIPT_DIR="$ENGINE_DIR" PAPERCLIP_PROC_ROOT="$REPORT_PROC" "$ENGINE_DIR/whats-running.sh"
assert_eq "old /usr ExecStart is rejected" "1" "$old_report_code"
assert_contains "old /usr runtime reports not running" "$old_report_out" "Engine running : NO"
mkdir -p "$REPORT_HOME/bin" "$REPORT_HOME/old-bundle"; printf 'old\n' > "$REPORT_HOME/old-bundle/whats-running.sh"; ln -s "$REPORT_HOME/old-bundle/whats-running.sh" "$REPORT_HOME/bin/whats-running"
capture fail_report_out fail_report_code env HOME="$REPORT_HOME" SCRIPT_DIR="$ENGINE_DIR" PAPERCLIP_WHATS_RUNNING_PATH="$REPORT_HOME/bin/whats-running" PAPERCLIP_ENGINE_TEST_FAIL_REPORT_INSTALL=1 bash -c '. "$SCRIPT_DIR/lib.sh"; install_whats_running'
assert_eq "injected bundle failure exits nonzero" "1" "$fail_report_code"
assert_eq "bundle failure preserves prior command" "$REPORT_HOME/old-bundle/whats-running.sh" "$(readlink "$REPORT_HOME/bin/whats-running")"
capture install_report_out install_report_code env HOME="$REPORT_HOME" SCRIPT_DIR="$ENGINE_DIR" PAPERCLIP_WHATS_RUNNING_PATH="$REPORT_HOME/bin/whats-running" bash -c '. "$SCRIPT_DIR/lib.sh"; install_whats_running'
assert_eq "managed report installer succeeds" "0" "$install_report_code"
assert_true "installed report is mode 0755" test -x "$REPORT_HOME/bin/whats-running"
assert_true "installed helper is mode 0755" test -x "$(dirname "$(readlink "$REPORT_HOME/bin/whats-running")")/overlay-contract.mjs"
printf 'tamper\n' >> "$CLI_ROOT/node_modules/@paperclipai/server/dist/index.js"
capture out21t code21t node "$ENGINE_DIR/overlay-contract.mjs" --verify "$OVERLAY_PREFIX" 0123456789012345678901234567890123456789 "$OVERLAY_PREFIX/.paperclip-engine-overlay.json"
assert_eq "tampered final inventory rejects reuse" "1" "$code21t"
rm "$OVERLAY_PREFIX/bin/paperclipai"; ln -s /usr/lib/node_modules/paperclipai/dist/index.js "$OVERLAY_PREFIX/bin/paperclipai"
capture out21l code21l node "$ENGINE_DIR/overlay-contract.mjs" --verify "$OVERLAY_PREFIX" 0123456789012345678901234567890123456789 "$OVERLAY_PREFIX/.paperclip-engine-overlay.json"
assert_eq "absolute symlink target tamper fails closed" "1" "$code21l"

echo "== test 22: zero-pending gate compares full migration manifest and ledger =="
LIVE_MIG="$SANDBOX/live-prefix/lib/node_modules/paperclipai/node_modules/@paperclipai/db/dist/migrations"
CAND_MIG="$SANDBOX/candidate-prefix/lib/node_modules/paperclipai/node_modules/@paperclipai/db/dist/migrations"
mkdir -p "$CAND_MIG/meta"
node -e '
 const fs=require("fs"),path=require("path"); const root=process.argv[1],entries=[];
 for(let i=0;i<231;i++){const tag=String(i).padStart(4,"0")+"_fixture";fs.writeFileSync(path.join(root,tag+".sql"),`migration ${i}\n`);entries.push({idx:i,version:"7",when:1000+i,tag,breakpoints:true})}
 fs.writeFileSync(path.join(root,"meta/_journal.json"),JSON.stringify({version:"7",dialect:"postgresql",entries}));
' "$CAND_MIG"
mkdir -p "$(dirname "$LIVE_MIG")"
cp -a "$CAND_MIG" "$LIVE_MIG"
capture out22 code22 env ENGINE_DIR_FOR_TEST="$ENGINE_DIR" CAND_PREFIX="$SANDBOX/candidate-prefix" LIVE_PREFIX="$SANDBOX/live-prefix" CAND_MIG="$CAND_MIG" bash -c '. "$ENGINE_DIR_FOR_TEST/lib.sh"; live_migration_ledger(){ node -e '\''const fs=require("fs"),path=require("path"),crypto=require("crypto"),r=process.argv[1],j=require(path.join(r,"meta/_journal.json"));for(const e of j.entries){const b=fs.readFileSync(path.join(r,e.tag+".sql"));console.log(`${e.when}|${crypto.createHash("sha256").update(b).digest("hex")}`)}console.log("1|old-a\n2|old-b\n3|old-c")'\'' "$CAND_MIG"; }; assert_overlay_zero_pending "$CAND_PREFIX" "$LIVE_PREFIX" ignored'
assert_eq "exact migration manifest and ledger pass" "0" "$code22"
printf 'changed\n' > "$CAND_MIG/0001.sql"
capture out22b code22b env ENGINE_DIR_FOR_TEST="$ENGINE_DIR" CAND_PREFIX="$SANDBOX/candidate-prefix" LIVE_PREFIX="$SANDBOX/live-prefix" bash -c '. "$ENGINE_DIR_FOR_TEST/lib.sh"; assert_overlay_zero_pending "$CAND_PREFIX" "$LIVE_PREFIX" ignored'
assert_eq "changed migration hash fails closed" "1" "$code22b"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
