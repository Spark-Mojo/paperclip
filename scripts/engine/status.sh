#!/usr/bin/env bash
# scripts/engine/status.sh — read-only report of the versioned Paperclip
# install: current symlink target, systemd unit state, version, health,
# migration count, agents-paused count.
#
# Also lists every `paperclip*` systemd --user unit (not just $UNIT_NAME), so
# a naming mismatch against whatever leaf 2 actually installed (e.g. the
# CLI's own `paperclipai service install`, which names units
# `paperclipai.service` / `paperclipai-<instance>.service` — see
# cli/src/services/service-manager.ts systemdServiceName()) is visible
# instead of silently assumed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
. "$SCRIPT_DIR/lib.sh"

echo "== paperclip-current =="
target="$(current_target)"
if [ -n "$target" ]; then
  echo "  $CURRENT_LINK -> $target"
else
  echo "  $CURRENT_LINK: not set"
fi

echo "== previous prefix (rollback target) =="
previous="$(read_previous_target)"
echo "  ${previous:-<none recorded>}"

echo "== systemd --user units matching 'paperclip*' =="
if [ "$DRY_RUN" = "1" ]; then
  echo "  (dry-run: would run: systemctl --user list-units --all 'paperclip*')"
else
  systemctl --user list-units --all 'paperclip*' --no-legend 2>/dev/null || echo "  (systemctl --user unavailable or no matching units)"
  echo "  -- $UNIT_NAME detail --"
  systemctl --user show "$UNIT_NAME" --property=LoadState,ActiveState,UnitFileState,MainPID 2>/dev/null || echo "  (not found)"
fi

echo "== version =="
if [ -n "$target" ]; then
  prefix_version "$target" 2>/dev/null || echo "  (could not read version from $target)"
else
  echo "  (no current prefix)"
fi

echo "== instance config =="
echo "  $INSTANCE_CONFIG"
if [ ! -f "$INSTANCE_CONFIG" ]; then
  echo "  (not found — instance not yet onboarded, or PAPERCLIP_HOME/PAPERCLIP_INSTANCE_ID misconfigured)"
  exit 0
fi

echo "== health (GET /api/health) =="
url="$(health_url "$INSTANCE_CONFIG")"
echo "  $url"
if [ "$DRY_RUN" = "1" ]; then
  echo "  (dry-run: would curl $url)"
elif body="$(curl -fsS -m 5 "$url" 2>/dev/null)"; then
  echo "  $body"
else
  echo "  UNREACHABLE"
fi

connection_string=""
if connection_string="$(connection_string_from_config "$INSTANCE_CONFIG" 2>/dev/null)"; then
  echo "== migrations (drizzle.__drizzle_migrations row count) =="
  echo "  $(migration_count "$connection_string" 2>/dev/null || echo unknown)"

  echo "== agents paused (status = 'paused') =="
  echo "  $(agents_paused_count "$connection_string" 2>/dev/null || echo unknown)"
else
  echo "== database =="
  echo "  (not in postgres mode, or no connectionString configured — skipping migration/agent queries)"
fi
