#!/usr/bin/env bash
# scripts/engine/install.sh — install a new versioned Paperclip prefix and
# cut the running instance over to it.
#
# Usage:
#   scripts/engine/install.sh npm:<version>
#   scripts/engine/install.sh fork:<git-ref>
#
# See scripts/engine/lib.sh for the full path/env-var contract and citations
# into the fork source for every assumption below, and scripts/engine/README.md
# for the operator runbook.
#
# npm:<version>  — `npm install --prefix <new-prefix> paperclipai@<version>`,
#                  mirroring cli/src/commands/install.ts installNpmPayload().
# fork:<git-ref> — clone the fork at <git-ref>, `pnpm install`, build, and
#                  pack+install CLI + every workspace package the server
#                  depends on into a fresh prefix, mirroring
#                  cli/src/commands/install.ts installGitPayload() (the CLI's
#                  own `paperclipai install --repo <owner>/<name> --ref <ref>`
#                  machinery) — including its workspace-dependency packing so
#                  @paperclipai/server resolves to the FORK's build, not the
#                  npm registry (generate-npm-package-json.mjs explicitly
#                  excludes server from the CLI's own bundle: "server is
#                  excluded — it's published separately as a dependency").
#
# Steps: preflight -> pg_dump backup of the *current* instance DB -> install
# into a fresh prefix -> run pending migrations explicitly -> stop unit ->
# switch paperclip-current symlink -> start unit -> wait up to
# HEALTH_TIMEOUT_SECS for GET /api/health -> print read-back. On health
# failure: automatic rollback to the previous symlink target (NOT a DB
# rollback — see README) and exit non-zero.
#
# Idempotent: re-running with the same source reuses an already-installed,
# smoke-tested prefix instead of reinstalling.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
. "$SCRIPT_DIR/lib.sh"

usage() {
  cat <<'EOF'
Usage: install.sh <npm:VERSION|fork:GIT_REF>

Examples:
  install.sh npm:2026.831.1
  install.sh fork:a1b2c3d
  install.sh fork:main
EOF
}

if [ "$#" -ne 1 ]; then
  usage >&2
  exit 2
fi

SOURCE_ARG="$1"
SOURCE_KIND="${SOURCE_ARG%%:*}"
SOURCE_VALUE="${SOURCE_ARG#*:}"

case "$SOURCE_KIND" in
  npm)
    if [ -z "$SOURCE_VALUE" ]; then die "npm: source requires a version, e.g. npm:2026.831.1"; fi
    VERSION_LABEL="$SOURCE_VALUE"
    NEW_PREFIX="$ENGINE_ROOT/paperclip-$VERSION_LABEL"
    ;;
  fork)
    if [ -z "$SOURCE_VALUE" ]; then die "fork: source requires a git ref, e.g. fork:main or fork:a1b2c3d"; fi
    GIT_REF="$SOURCE_VALUE"
    ;;
  *)
    usage >&2
    die "Unknown source kind '$SOURCE_KIND'. Expected npm: or fork:."
    ;;
esac

guard_host

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

preflight() {
  log "Preflight: node version"
  local node_major
  node_major="$(node -e 'console.log(process.versions.node.split(".")[0])')"
  # package.json "engines": { "node": ">=20" }
  if [ "$node_major" -lt 20 ]; then
    die "Node $node_major found; Paperclip requires Node >= 20 (package.json engines.node)."
  fi

  if [ "$SOURCE_KIND" = "fork" ] && [ "$DRY_RUN" != "1" ]; then
    log "Preflight: fork Rust toolchain"
    assert_fork_rust_toolchain "$(fork_source_repo)"
  fi

  log "Preflight: systemd unit compatibility"
  if [ -n "$PAPERCLIP_ENGINE_ADOPT_EXISTING_PREFIX" ]; then
    prepare_existing_prefix_adoption
  else
    unit_assert_compatible "$SCRIPT_DIR/systemd/$UNIT_NAME"
  fi

  log "Preflight: disk space at $ENGINE_ROOT"
  mkdir -p "$ENGINE_ROOT"
  local free_kb
  free_kb="$(df -Pk "$ENGINE_ROOT" | awk 'NR==2 {print $4}')"
  if [ -z "$free_kb" ] || [ "$free_kb" -lt "$MIN_FREE_KB" ]; then
    die "Only ${free_kb:-0}KiB free at $ENGINE_ROOT; require >= ${MIN_FREE_KB}KiB (MIN_FREE_KB)."
  fi

  log "Preflight: database identity guard"
  assert_expected_database "$INSTANCE_CONFIG"

  if [ -f "$INSTANCE_CONFIG" ]; then
    local connection_string
    if connection_string="$(connection_string_from_config "$INSTANCE_CONFIG" 2>/dev/null)"; then
      log "Preflight: postgres reachability"
      if [ "$DRY_RUN" != "1" ]; then
        if ! database_reachable "$connection_string" >/dev/null 2>&1; then
          die "Cannot reach postgres at the configured connectionString. Aborting before touching the running instance."
        fi
      fi
    fi
  else
    log "No existing instance config at $INSTANCE_CONFIG — treating this as a first install (no DB reachability check, no backup, no migration run)."
  fi
}

# ---------------------------------------------------------------------------
# Install: npm source
# ---------------------------------------------------------------------------

install_from_npm() {
  local version="$1"
  local prefix="$2"

  if [ -f "$prefix/lib/node_modules/paperclipai/package.json" ]; then
    log "Reusing already-installed prefix $prefix (idempotent)."
    return 0
  fi

  local staging="${prefix}.staging.$$"
  rm -rf "$staging"

  if [ "$DRY_RUN" = "1" ]; then
    stage_fake_payload "$staging" "$version"
  else
    # Mirrors installNpmPayload() in cli/src/commands/install.ts.
    install_npm_payload "$staging" "$version"
  fi

  mv "$staging" "$prefix"
}

# ---------------------------------------------------------------------------
# Install: fork source
# ---------------------------------------------------------------------------

# Resolves a git ref to a commit sha in the fork repo (Spark-Mojo/paperclip,
# same object graph as this worktree's `spark` / `origin` remotes — see
# scripts/engine/README.md). Uses the local git checkout that this script
# ships alongside, so it works without network access to GitHub's API.
fork_source_repo() {
  echo "${FORK_SOURCE_REPO:-$SCRIPT_DIR/../..}"
}

resolve_fork_sha() {
  local ref="$1"
  local src
  src="$(fork_source_repo)"
  git -C "$src" rev-parse --verify "$ref^{commit}" 2>/dev/null \
    || git -C "$src" rev-parse --verify "origin/$ref^{commit}" 2>/dev/null \
    || echo "$ref"
}

install_from_fork() {
  local ref="$1"
  local sha short_sha prefix
  sha="$(resolve_fork_sha "$ref")"
  short_sha="$(echo "$sha" | cut -c1-12)"
  local release_version="2026.831.1"
  VERSION_LABEL="overlay-$release_version-$short_sha"
  prefix="$ENGINE_ROOT/paperclip-$VERSION_LABEL"
  NEW_PREFIX="$prefix"

  if [ -f "$prefix/lib/node_modules/paperclipai/package.json" ]; then
    local receipt="$prefix/.paperclip-engine-overlay.json"
    [ -f "$receipt" ] || die "Refusing to reuse overlay prefix without receipt: $prefix"
    if [ "$DRY_RUN" = "1" ]; then
      node -e 'const r=require(process.argv[1]);if(r.sourceSha!==process.argv[2])process.exit(1)' "$receipt" "$sha" || die "Overlay receipt does not match source $sha"
    else
      node "$SCRIPT_DIR/overlay-contract.mjs" --verify "$prefix" "$sha" "$receipt"
    fi
    log "Reusing verified overlay prefix $prefix (idempotent)."
    return 0
  fi

  local staging_root="${prefix}.staging.$$"
  rm -rf "$staging_root"
  mkdir -p "$staging_root"
  local checkout="$staging_root/source"
  local payload="$staging_root/payload"

  if [ "$DRY_RUN" = "1" ]; then
    stage_fake_payload "$payload" "0.0.0-$short_sha"
    printf '{"schema":2,"sourceSha":"%s"}\n' "$sha" > "$payload/.paperclip-engine-overlay.json"
    mv "$payload" "$prefix"
    rm -rf "$staging_root"
    return 0
  fi

  install_npm_payload "$payload" "$release_version"

  # ---- Faithfully mirrors installGitPayload() in cli/src/commands/install.ts ----
  log "Cloning fork ref '$ref' ($sha) into $checkout"
  run git clone --quiet "$(fork_source_repo)" "$checkout"
  run git -C "$checkout" checkout --quiet "$sha"

  local build_env_path="$PATH"
  # Workspace build scripts invoke bare `pnpm`; corepack provisions it.
  prepare_pnpm_toolchain "$staging_root"
  export PATH="$staging_root/pnpm-bin:$build_env_path"

  (cd "$checkout" && run corepack pnpm install --frozen-lockfile)
  # scripts/build-npm.sh bundles the CLI (esbuild) and generates the
  # publishable cli/package.json (excludes @paperclipai/server on purpose).
  (cd "$checkout" && run bash scripts/build-npm.sh --skip-checks --skip-typecheck)
  # Build @paperclipai/server (and its workspace deps) so the fork's server
  # changes (e.g. SPA-6057's recovery service) are what gets packed, not
  # whatever is on the npm registry.
  (cd "$checkout" && run corepack pnpm -r --filter '@paperclipai/server...' --if-present run build)

  node "$SCRIPT_DIR/overlay-contract.mjs" "$payload" "$checkout" "$sha" "$payload/.paperclip-engine-overlay.json"

  mv "$payload" "$prefix"
  rm -rf "$staging_root"
}

# Dry-run only: synthesize a minimal, structurally valid prefix so the
# surrounding orchestration (symlink flip, health wait, rollback) can be
# exercised without a real network build.
stage_fake_payload() {
  local target="$1"
  local version="$2"
  mkdir -p "$target/lib/node_modules/paperclipai"
  mkdir -p "$target/bin"
  cat > "$target/lib/node_modules/paperclipai/package.json" <<EOF
{"name":"paperclipai","version":"$version"}
EOF
  mkdir -p "$target/lib/node_modules/paperclipai/node_modules/@paperclipai/server"
  cat > "$target/lib/node_modules/paperclipai/node_modules/@paperclipai/server/package.json" <<EOF
{"name":"@paperclipai/server","version":"$version"}
EOF
  cat > "$target/bin/paperclipai" <<'EOF'
#!/usr/bin/env bash
echo "fake paperclipai (dry-run stage)"
EOF
  chmod +x "$target/bin/paperclipai"
  log "Staged fake dry-run payload at $target (version $version)"
}

# ---------------------------------------------------------------------------
# Migrations
# ---------------------------------------------------------------------------

# Runs @paperclipai/db's migrate.ts (compiled to dist/migrate.js by the
# package's own `build` script) explicitly, ahead of starting the server, so
# we control exactly when the schema moves and can print a before/after
# migration count. The server itself refuses to boot against a stale schema
# unless PAPERCLIP_MIGRATION_AUTO_APPLY=true (server/src/index.ts) — we do
# NOT set that on the unit; migrations here are the only place they run.
run_migrations() {
  local prefix="$1"
  if [ ! -f "$INSTANCE_CONFIG" ]; then
    log "No instance config at $INSTANCE_CONFIG; no existing database to migrate."
    return 0
  fi
  if [ "$DRY_RUN" = "1" ]; then
    log "+DRYRUN would run @paperclipai/db migrations from $prefix"
    return 0
  fi
  local migrate_js
  migrate_js="$(resolve_migration_artifact "$prefix")"
  log "Running migrations via $migrate_js"
  PAPERCLIP_HOME="$PAPERCLIP_HOME" PAPERCLIP_INSTANCE_ID="$PAPERCLIP_INSTANCE_ID" PAPERCLIP_CONFIG="$INSTANCE_CONFIG" \
    run node "$migrate_js"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  preflight

  local previous_connection_string=""
  local before_migrations="unknown"
  if [ -f "$INSTANCE_CONFIG" ]; then
    if previous_connection_string="$(connection_string_from_config "$INSTANCE_CONFIG" 2>/dev/null)"; then
      local dump_path
      dump_path="$(backup_database "$previous_connection_string" "pre-${SOURCE_KIND}-$(basename "${VERSION_LABEL:-$SOURCE_VALUE}")")"
      log "Backup written to $dump_path"
      before_migrations="$(migration_count "$previous_connection_string" || echo unknown)"
    fi
  fi

  if [ "$SOURCE_KIND" = "npm" ]; then
    install_from_npm "$SOURCE_VALUE" "$NEW_PREFIX"
  else
    install_from_fork "$GIT_REF"
  fi

  if [ "$SOURCE_KIND" = "fork" ] && [ "$DRY_RUN" != "1" ] && [ -n "$previous_connection_string" ]; then
    assert_overlay_zero_pending "$NEW_PREFIX" "$(current_target)" "$previous_connection_string"
  fi
  run_migrations "$NEW_PREFIX"

  local previous
  previous="$(current_target)"
  record_previous_target "$previous"

  if [ -z "$PAPERCLIP_ENGINE_ADOPT_EXISTING_PREFIX" ]; then
    unit_ensure_installed "$SCRIPT_DIR/systemd/$UNIT_NAME"
  fi
  unit_stop
  flip_symlink "$NEW_PREFIX"

  # unit_start can legitimately fail (Type=notify blocks for sd_notify
  # READY=1; a broken new version times out non-zero). It must NOT be called
  # bare here: under `set -e` a non-zero exit at this point would abort the
  # whole script before any of the rollback logic below runs, leaving the
  # symlink on a broken prefix with the unit down and no rollback attempted.
  local url body started=1
  unit_start || started=0

  url="$(health_url "$INSTANCE_CONFIG")"
  if [ "$started" = "1" ] && body="$(wait_for_health "$url")"; then
    local after_migrations="unknown"
    if [ -n "$previous_connection_string" ]; then
      after_migrations="$(migration_count "$previous_connection_string" || echo unknown)"
    fi
    log "=== INSTALL OK ==="
    log "prefix:            $NEW_PREFIX"
    log "version:           $(prefix_version "$NEW_PREFIX")"
    log "migrations before: $before_migrations"
    log "migrations after:  $after_migrations"
    log "health:            $body"
    if [ "$DRY_RUN" != "1" ]; then
      install_whats_running
    fi
    exit 0
  fi

  if [ "$started" = "1" ]; then
    log "=== HEALTH CHECK FAILED after ${HEALTH_TIMEOUT_SECS}s — rolling back symlink to previous prefix ==="
  else
    log "=== systemctl start FAILED — rolling back symlink to previous prefix ==="
  fi
  if [ -n "$previous_connection_string" ]; then
    log "migrations before rollback attempt: $(migration_count "$previous_connection_string" 2>/dev/null || echo unknown)"
  fi
  if [ -n "$previous" ]; then
    unit_stop
    flip_symlink "$previous"
    local rollback_started=1
    unit_start || rollback_started=0
    if [ "$rollback_started" = "1" ] && body="$(wait_for_health "$url")"; then
      log "Rollback to $previous succeeded. New prefix $NEW_PREFIX left on disk for investigation (not deleted)."
    else
      log "ERROR: rollback to $previous ALSO failed to start/pass health. Manual intervention required."
    fi
  else
    log "No previous prefix recorded — nothing to roll back to. This was a first install."
  fi
  log "NOTE: this rollback only reverted the code symlink. If migrations ran above, the DATABASE SCHEMA WAS NOT ROLLED BACK. Use rollback.sh --restore <dump> if the new schema is incompatible with the previous code."
  exit 1
}

main
