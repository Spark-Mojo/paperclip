#!/usr/bin/env bash
# scripts/engine/rollback.sh — switch paperclip-current back to a prior
# prefix (a *code* rollback), and optionally restore the database from a
# pg_dump backup (a *schema* rollback — a separate, explicit, --yes-gated
# operation; see README "never do this by accident").
#
# Usage:
#   rollback.sh                       # roll back to the prefix recorded by
#                                      # the last install.sh run
#   rollback.sh /home/jamesilsley/paperclip-2026.831.0   # roll back to a
#                                      # named prefix
#   rollback.sh [prefix] --restore <dump-file> --yes
#                                      # also pg_restore the given dump
#                                      # (stops the unit, restores, restarts)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
. "$SCRIPT_DIR/lib.sh"

usage() {
  cat <<'EOF'
Usage: rollback.sh [prefix] [--restore <dump-file> --yes]

With no [prefix], rolls back to the prefix recorded by the last install.sh
run (scripts/engine/.paperclip-engine/previous-prefix under ENGINE_ROOT).

--restore <dump-file>   pg_restore the given dump into the instance database
                         AFTER the symlink flip. Destructive; requires --yes.
EOF
}

TARGET_PREFIX=""
RESTORE_DUMP=""
CONFIRMED=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --restore)
      RESTORE_DUMP="${2:-}"
      shift 2
      ;;
    --yes)
      CONFIRMED=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [ -n "$TARGET_PREFIX" ]; then
        usage >&2
        die "Unexpected extra argument '$1'."
      fi
      TARGET_PREFIX="$1"
      shift
      ;;
  esac
done

guard_host

if [ -n "$RESTORE_DUMP" ] && [ "$CONFIRMED" -ne 1 ]; then
  die "--restore requires --yes (this overwrites the live instance database with $RESTORE_DUMP)."
fi

if [ -z "$TARGET_PREFIX" ]; then
  TARGET_PREFIX="$(read_previous_target)"
  if [ -z "$TARGET_PREFIX" ]; then
    die "No prefix given and no previous-prefix state file found at $PREVIOUS_STATE_FILE. Pass a prefix explicitly."
  fi
  log "No prefix given — rolling back to recorded previous prefix: $TARGET_PREFIX"
fi

if [ ! -f "$TARGET_PREFIX/lib/node_modules/paperclipai/package.json" ] && [ "$DRY_RUN" != "1" ]; then
  die "Target prefix $TARGET_PREFIX does not look like an installed Paperclip prefix (no lib/node_modules/paperclipai/package.json)."
fi

assert_expected_database "$INSTANCE_CONFIG"

before="$(current_target)"
log "Rolling back paperclip-current: $before -> $TARGET_PREFIX"

unit_stop
flip_symlink "$TARGET_PREFIX"

if [ -n "$RESTORE_DUMP" ]; then
  if [ ! -f "$INSTANCE_CONFIG" ]; then
    die "No instance config at $INSTANCE_CONFIG — cannot resolve a connection string to restore into."
  fi
  connection_string="$(connection_string_from_config "$INSTANCE_CONFIG")"
  log "Restoring database from $RESTORE_DUMP (--yes confirmed)"
  run pg_restore --clean --if-exists -d "$connection_string" "$RESTORE_DUMP"
fi

# See install.sh for why this can't be a bare `unit_start` under `set -e`.
started=1
unit_start || started=0

url="$(health_url "$INSTANCE_CONFIG")"
if [ "$started" = "1" ] && body="$(wait_for_health "$url")"; then
  log "=== ROLLBACK OK ==="
  log "prefix:  $TARGET_PREFIX"
  log "version: $(prefix_version "$TARGET_PREFIX")"
  log "health:  $body"
  # Record the prefix we rolled back FROM, so a rollback of a rollback is
  # possible.
  record_previous_target "$before"
  exit 0
fi

log "ERROR: rollback to $TARGET_PREFIX failed health check after ${HEALTH_TIMEOUT_SECS}s. Manual intervention required."
exit 1
