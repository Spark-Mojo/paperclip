# Paperclip engine install/rollback/status (SPA-6060, ENGINE-MIGRATE leaf 4)

Ops scripts for running a versioned, side-by-side install of the Paperclip
fork on bigbox: multiple `paperclip-<version>` prefixes under a single host,
one `paperclip-current` symlink selecting the active prefix, one systemd
--user unit whose `ExecStart` goes through that symlink so a version cutover
is "flip the symlink, restart the unit."

This is a deliberate ops-layer wrapper **on top of** the CLI's own install
machinery (`cli/src/commands/install.ts`, `cli/src/services/service-manager.ts`)
— it reuses the CLI's own npm/git install steps and systemd unit shape, but
manages multiple versions side by side under our own naming, which the CLI's
single-active-install self-updater does not do.

## Layout

| Thing | Path | Source of truth |
|---|---|---|
| Versioned install prefix | `$ENGINE_ROOT/paperclip-<version>` (npm source) or `paperclip-fork-<sha12>` (fork source) | this script's own convention |
| Active-version symlink | `$ENGINE_ROOT/paperclip-current` | this script's own convention |
| Paperclip home / instance state | `$PAPERCLIP_HOME` = `$ENGINE_ROOT/.paperclip-831` | `PAPERCLIP_HOME` env var, `packages/shared/src/home-paths.ts` `resolvePaperclipHomeDir()` |
| Instance root (config, db info, logs, secrets) | `$PAPERCLIP_HOME/instances/$PAPERCLIP_INSTANCE_ID/` | `resolvePaperclipInstanceRoot()`, same file |
| Instance config | `.../config.json` | `resolvePaperclipConfigPathForInstance()` |
| Postgres connection | `config.database.connectionString` (mode must be `"postgres"`) | `packages/shared/src/config-schema.ts` `databaseConfigSchema` |
| HTTP port | `config.server.port` (default 3100 in schema; bigbox uses 3101 — set in the instance's config.json, not by these scripts) | same file, `serverConfigSchema` |
| Health endpoint | `GET http://<server.host>:<server.port>/api/health` | `server/src/app.ts` (`api.use("/health", healthRoutes(...))` mounted under `app.use("/api", api)`), `cli/src/utils/health-url.ts` |
| Migration table | `"drizzle"."__drizzle_migrations"` | `packages/db/src/client.ts` |
| systemd unit | `~/.config/systemd/user/paperclip-831.service`, `ExecStart="$CURRENT_LINK/bin/paperclipai" run --instance "$PAPERCLIP_INSTANCE_ID"` | `scripts/engine/systemd/paperclip-831.service`, modeled on `cli/src/services/service-manager.ts` `renderSystemdUnit()` |

**ASSUMPTION, not verified against bigbox:** the handoff described the
instance dir as literally `/home/jamesilsley/.paperclip-831`. The real CLI
resolves instance state at `$PAPERCLIP_HOME/instances/$PAPERCLIP_INSTANCE_ID/`,
never directly at `$PAPERCLIP_HOME`. These scripts set `PAPERCLIP_HOME=
/home/jamesilsley/.paperclip-831` and leave `PAPERCLIP_INSTANCE_ID=default`,
so the *actual* on-disk instance root is
`/home/jamesilsley/.paperclip-831/instances/default/`. If leaf 2 set up
bigbox differently (e.g. a non-default instance id, or used the CLI's own
`paperclipai service install` unit naming — `paperclipai.service` /
`paperclipai-<id>.service` rather than `paperclip-831.service`), run
`status.sh` first: it lists every `paperclip*` unit and prints the resolved
`INSTANCE_CONFIG` path, so a mismatch is visible immediately rather than
silently assumed. Reconcile the env vars in `lib.sh` (or export overrides)
before running `install.sh` for real.

## Usage

```sh
# Install a published npm release and cut over:
scripts/engine/install.sh npm:2026.831.1

# Build and install a specific fork commit/branch and cut over:
scripts/engine/install.sh fork:main
scripts/engine/install.sh fork:a1b2c3d4

# Read-only status:
scripts/engine/status.sh

# Roll back to whatever install.sh last replaced:
scripts/engine/rollback.sh

# Roll back to a named prefix:
scripts/engine/rollback.sh /home/jamesilsley/paperclip-2026.831.0

# Roll back the code AND restore the database from a specific backup
# (destructive — requires --yes):
scripts/engine/rollback.sh /home/jamesilsley/paperclip-2026.831.0 \
  --restore /home/jamesilsley/paperclip-backups/20260904T010203Z-pre-npm-2026.831.1.dump \
  --yes
```

All paths/names are overridable via environment variables documented at the
top of `lib.sh` (`ENGINE_ROOT`, `PAPERCLIP_HOME`, `PAPERCLIP_INSTANCE_ID`,
`CURRENT_LINK`, `UNIT_NAME`, `EXPECTED_DB`, `BACKUP_DIR`, `STATE_DIR`,
`HEALTH_TIMEOUT_SECS`, `HEALTH_POLL_SECS`, `FORK_SOURCE_REPO`).

## What `install.sh` actually does

1. Preflight: Node >= 20, free disk on `$ENGINE_ROOT`, database identity
   guard (refuses to touch anything whose host isn't `127.0.0.1`/`localhost`
   or whose db name isn't `$EXPECTED_DB`), postgres reachability.
2. If an instance config already exists: `pg_dump -Fc` the current database
   to `$BACKUP_DIR/<timestamp>-<label>.dump`, and record the pre-install
   migration row count.
3. Install into a **fresh** prefix (`.staging.$$` dir, renamed into place
   only on success — a half-finished install never lands at the final path):
   - `npm:<version>` — `npm install --prefix <prefix> paperclipai@<version>
     --registry=https://registry.npmjs.org`, mirroring `installNpmPayload()`
     in `cli/src/commands/install.ts`.
   - `fork:<git-ref>` — clones the fork locally (`FORK_SOURCE_REPO`, default:
     the repo this script lives in), `corepack pnpm install --frozen-lockfile`,
     `scripts/build-npm.sh` (bundles the CLI), `pnpm -r --filter
     '@paperclipai/server...' run build` (builds the server and everything it
     depends on — **this is the part that makes fork server changes actually
     ship**; the CLI's own npm-publishable bundle explicitly excludes
     `@paperclipai/server`, see `scripts/generate-npm-package-json.mjs`), then
     resolves the exact workspace-package dependency set via the CLI's own
     `resolveGitInstallWorkspacePackages()` (imported live via `tsx`, not
     re-derived by hand), packs each one (`scripts/prepare-bundled-package.mjs`
     for packages with `bundleDependencies`, e.g. `@paperclipai/db`;
     `pnpm pack` otherwise), and `npm install`s the CLI tarball plus every
     workspace tarball together into the fresh prefix — mirroring
     `installGitPayload()` exactly. This is the mechanism behind the CLI's own
     `paperclipai install --repo <owner>/<name> --ref <ref>`.
4. Runs `@paperclipai/db`'s `dist/migrate.js` explicitly against the instance
   database, from inside the new prefix, before touching the running unit —
   so migrations happen at a controlled point we can measure, not implicitly
   on server boot. (The server itself refuses to start against a stale schema
   unless `PAPERCLIP_MIGRATION_AUTO_APPLY=true` — see `server/src/index.ts`;
   these scripts never set that on the unit.)
5. Installs the systemd unit if it isn't present. **If a unit file with the
   same name already exists and its content differs from
   `scripts/engine/systemd/paperclip-831.service`, install.sh refuses to
   overwrite it** (prints a diff, requires `PAPERCLIP_ENGINE_REPLACE_UNIT=1`
   to proceed) — this matters right now because another worker may be
   installing a unit under this same name independently.
6. Records the current `paperclip-current` target as the rollback target,
   stops the unit, flips the symlink (`ln -sfn`, atomic), starts the unit.
   Starting the unit can itself fail (`Type=notify` blocks for
   `sd_notify(READY=1)`; a broken new version times out non-zero) — that
   failure is caught explicitly and routed into the same rollback path as a
   failed health check, not allowed to abort the script via `set -e` before
   rollback runs.
7. Waits up to `HEALTH_TIMEOUT_SECS` for `GET /api/health` to report
   `status: "ok"`, then prints: prefix path, version (from the new prefix's
   `package.json`), migration count before/after, and the health JSON.
8. **On a failed start or a failed health check:** stops the unit, flips the
   symlink back to the previous prefix, restarts, and waits for health
   again. Exits non-zero either way (success only means the rollback itself
   worked; the install still failed).

## Rollback semantics — read this before running `rollback.sh`

**A symlink flip is a code rollback, not a database rollback.** If
`install.sh` ran migrations for the new version before failing its health
check, those migrations already applied to the shared instance database —
flipping back to the old code does not undo them. The old code may now be
running against a schema it doesn't understand. This is the exact failure
mode behind the live incident in memory ("Paperclip DB journal is AHEAD of
rolled-back code").

- `install.sh`'s automatic rollback and `rollback.sh` with no `--restore`
  only flip the symlink and restart. They print both the before- and
  after-migration counts loudly so the mismatch is visible.
- `rollback.sh --restore <dump> --yes` is the actual schema rollback:
  it stops the unit, `pg_restore --clean --if-exists` from the given dump,
  starts the unit, and waits for health. Requires `--yes`; there is no
  bare-word confirmation prompt, so this cannot be run by accident inside a
  script or copy-pasted command without deliberately including `--yes`.
- Always check `status.sh`'s migration count against the dump you're
  restoring from before running `--restore`.

## What to paste back on the card

`status.sh`'s full output (symlink target, unit state, version, health JSON,
migration count, agents-paused count) plus, after any `install.sh` or
`rollback.sh` run, its final `=== ... OK/FAILED ===` block.

## Never do this

- Never edit anything under `<prefix>/lib/node_modules/` by hand — a version
  is a `pnpm pack`/`npm pack` artifact; if it's wrong, build a new one.
- Never point `PAPERCLIP_HOME` / `EXPECTED_DB` at anything but the bigbox
  `831` instance. The database identity guard in `lib.sh` refuses to run
  against a host that isn't `127.0.0.1`/`localhost` or a db name that isn't
  `$EXPECTED_DB` — do not override those to make a mistake pass silently.
- Never run these scripts against the laptop's live paperclip. `guard_host()`
  refuses to run on a non-Linux host unless `PAPERCLIP_ENGINE_DRY_RUN=1`.
- Never run `rollback.sh --restore` without first confirming, via
  `status.sh`, which migration state the target dump corresponds to.
- Never assume `paperclip-831.service` is the unit leaf 2 actually installed
  — `status.sh` lists every `paperclip*` unit precisely so this is checked,
  not assumed.

## Tests

```sh
scripts/engine/tests/test-install-dry-run.sh
```

Runs `install.sh` / `rollback.sh` under `PAPERCLIP_ENGINE_DRY_RUN=1` in an
isolated sandbox root (`ENGINE_ROOT` pointed at a temp dir, stub
`systemctl`/`pg_dump`/`pg_restore`/`psql` on `PATH` that log invocations
instead of touching real infrastructure, and a real local HTTP server acting
as the fake `/api/health` endpoint). It asserts: the symlink is created and
points at the new prefix; a failed health check triggers an automatic
rollback of the symlink to the previous prefix with a non-zero exit code; and
`rollback.sh` with no argument reads the recorded previous-prefix state file
and flips back to it, restarting and passing health.

No step in the test touches bigbox, npmjs.org, or GitHub, and no step touches
the laptop's real Paperclip install.
