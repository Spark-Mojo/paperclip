# SPA-17842 — apply procedure: remove ONE antigravity member from OmniRoute combo `cheap`

Status: PREPARED, NOT APPLIED. Level: SPEC'D/BUILT. Nothing in this file has been run with `--apply`.
Applied by: the APPLY leaf under SPA-17846 (Rev), only after James DR + Ty sign-off.

Artifacts (same directory): `cheap-before.json` (frozen row), `apply_cheap_antigravity_removal.py` (`--check` / `--apply` / `--rollback`).

## The single change
- Combo `cheap`, id `7b7295a0-7880-41ad-8cec-953bbed211ac`, strategy `round-robin`, row `version` 2, `updatedAt` `2026-10-30T04:36:22.452Z`.
- Remove ONLY member id `cheap-model-1-antigravity-gpt-oss-120b-medium-1094d5f9-bca7-4030-8a9f-d6ad89f1458f` (6 members -> 5). Occurs exactly once.
- Remaining, in order: openrouter nemotron-3-ultra (free), openrouter ling-3.0-flash, zai glm-4.7, qoder glm-5.2, nous-research longcat-2.5-preview (free).
- `config.candidatePool` = [openrouter, zai, qoder]. It does not contain antigravity, so it needs NO change (the script asserts this and aborts if it ever does).
- Frozen row: canonical sha256 of `data` (sorted keys, compact JSON) = `b8433c659341ee3a089650a5d2e665a749f56f8cc09217a29aaf28e629be3399`; raw stored string sha256 = `99f9efa7859cf03cb2239988b81b41a226af807c77eefcaf611603b78934b3cd`.

## Sanctioned write path — and why (d)
`PATCH /api/combos/<id>` on the running gateway (`http://127.0.0.1:20128`) with body `{"models":[<5 remaining member objects, byte-identical to stored>]}`.
Why: it is OmniRoute's own route (omniroute 3.8.51, `src/app/api/combos/[id]/route.ts` -> `updateCombo`). It validates (`updateComboSchema`, DAG, invariants), writes the row, calls `invalidateDbCache("combos")` (bumps the combo-cache version, so the 10s handler caches refresh immediately — `readCache.ts` #3147), and takes a `pre-write` DB backup. NO restart is needed or allowed.
A direct sqlite UPDATE is NOT used: the gateway holds the WAL-mode db open and its combo caches would not be invalidated, and this procedure does not prove a re-read without a restart. Note `PUT` and `PATCH` are the same handler; the repo's SPA-11884 reconciler (`james-claude-setup/omniroute/scripts/create-craft-minimax-m3-combo.sh`) is GET+POST only and never PATCHes, so it is not a precedent for the write method, only for the auth style (`Authorization: Bearer $OMNIROUTE_MGMT_TOKEN`). I found no committed script from SPA-12151/SPA-12071 that performs a combo member removal; the precedent is cited by the card but I could not read its method.
### PATCH semantics, read from the installed source (omniroute 3.8.51, `/home/jamesilsley/.machine-omniroute/node_modules/omniroute/`)
- (a) REPLACE, not merge, for `models`. `src/lib/db/repositories/sqliteComboRepository.ts` `updateCombo` (~L220-270): `merged = {...current, ...data, sortOrder, updatedAt: now}`, so a supplied `models` array replaces the stored one wholesale; other fields (`config`, `strategy`, `candidatePool`) are untouched because they are absent from the body. The route (`dist/.build/next/server/chunks/_0whktgp._.js`, module 662984; `PATCH` = same function as `PUT`) first runs `updateComboSchema` (`src/shared/validation/schemas/combo.ts` L424: `models` must have >= 1 entry), refuses `quota-share` combos (409), runs the DAG check, then `normalizeComboModels`, then `updateCombo`. Explicit member ids are kept as-is (`src/lib/combos/steps.ts` `explicitId ||`).
- (b) `version` is NOT bumped: it is the schema constant 2 (`COMBO_SCHEMA_VERSION`, set by `normalizeComboRecord`). `updatedAt` IS stamped to now on write. So the drift guard compares pre-write values only (the guard runs on the GET taken immediately before the PATCH, same process); after a successful apply `updatedAt` will differ from `cheap-before.json` by design, and a re-run is a no-op via the "target absent and remaining ids == expected post-state" rule, not via the guard. The script fails closed: any mismatch is exit 5 with zero writes.
- (c) No restart needed. The chat path reads combos through `getCombosCachedForChat` (`src/sse/handlers/chat.ts` L306-324): a 10s TTL cache that is also invalidated by `getCombosCacheVersion()`; `updateCombo` (`src/lib/db/combos.ts` L47-62) calls `invalidateDbCache("combos")`, which bumps that version (`src/lib/db/readCache.ts` ~L237-262, #3147). The next request after the PATCH re-reads from sqlite. Side effects of `updateCombo` with `models` provided: it clears the session model history for `cheap` (`clearSessionModelHistoryForCombo`) and takes a `pre-write` backup of the db file (`backupDbFile`, throttled, so may be skipped; the script's own row backup does not depend on it).
- Not verifiable without a write: that round-robin behaves well across 5 members (the oracle's real `machine-small` dispatch covers it), and that `comboModelEntry` accepts the stored member objects verbatim (a rejected PATCH writes nothing).
- Precedent: the card names the SPA-12071 reconciler. The only reconciler in the repo is `james-claude-setup/omniroute/scripts/create-craft-minimax-m3-combo.sh` (SPA-11884; PR internal#1602 carries SPA-12071). It is GET+POST only and states "No PUT / PATCH / DELETE on any code path", so it is the precedent for auth and base URL only, NOT for a member removal. Its mock (`tests/mock_omniroute_mgmt.py`) records that the real management API's PUT/PATCH behaviour was never exercised there. I found no SPA-12151 artifact. So the PATCH path for this edit is source-verified, not precedent-verified.

Untested (cannot be dry-run without a write): that `comboModelEntry` validation accepts the stored member objects verbatim. Mitigation: the script sends the members exactly as the gateway itself returned them from `GET`, verifies after, and the rollback path is the same call. If PATCH returns non-200 nothing was written (the handler validates before `updateCombo`).

## Credential (g)
Management auth only: a bearer in `OMNIROUTE_MGMT_TOKEN` (the same variable the SPA-11884 script uses), or a loopback CLI/dashboard session. An unauthenticated GET returned HTTP 401 on 2026-11-11 (checked, no body read). I did not locate which stored secret Rev uses for this and did not look for one; Rev supplies it. Ty holds none (per SPA-12151), so Rev applies. The `--check` mode needs no credential.

## Procedure (a)-(f)
Run from the worktree, as the user that owns the gateway.
0. `systemctl --user show omniroute -p NRestarts` — record (baseline 0 on 2026-11-11).
1. `python3 .unlazy/SPA-17842/apply_cheap_antigravity_removal.py --check` — must print `drift guard: PASS`, `target member id occurrences: 1`, exit 0.
2. (a) Backup + (b) drift guard + (c) the change, in one call:
   `OMNIROUTE_MGMT_TOKEN=... python3 .unlazy/SPA-17842/apply_cheap_antigravity_removal.py --apply --i-have-approval "<DR id> / <Ty sign-off ref>" --backup-dir <dir>`
   - GET live row via the API; refuse (exit 5, ZERO writes) if `id`, `version`, `updatedAt`, member id list, `candidatePool`, or canonical sha256 differ from `cheap-before.json`; refuse if target count != 1.
   - Write `<dir>/cheap-row-backup-<ts>.json` (full row JSON) and print its sha256 BEFORE the PATCH.
   - PATCH `models` only; re-GET and verify target absent, other 5 ids unchanged in order, candidatePool unchanged. Mismatch -> exit 6, run rollback.
3. (e) Rollback: `... --rollback <dir>/cheap-row-backup-<ts>.json --i-have-approval "..."` PATCHes the backed-up `models` array back and verifies. `updatedAt` cannot be restored through the API (it is stamped on write); member list and pool are restored exactly. (The gateway also takes its own `pre-write` file backup under `data/db_backups`.)
4. (f) Idempotent re-run: `--apply` after success finds 0 target occurrences and member list == expected post-state, prints `NO-OP`, exit 0, zero writes. If the target is absent but the list is anything else, it exits 5 (drift), zero writes.
5. `systemctl --user show omniroute -p NRestarts` — must equal step 0.

## Post-apply oracle (for the Guild; Patti does not run it)
(i) Row has no antigravity member, quoted before/after:
`python3 -c "import sqlite3,json;c=sqlite3.connect('file:/home/jamesilsley/.machine-omniroute/data/storage.sqlite?mode=ro',uri=True);d=json.loads(c.execute(\"select data from combos where name='cheap'\").fetchone()[0]);print(len(d['models']),[m['id'] for m in d['models'] if 'antigravity' in json.dumps(m)])"` -> `5 []` (before: `6 ['cheap-model-1-antigravity-...']`).
(ii) `systemctl --user show omniroute -p NRestarts` unchanged.
(iii) A real `reader` dispatch on `machine-small` after the apply completes with a recorded `finish_reason` (Guild; mandatory because the ro row check does not prove the dispatch path).
(iv) Zero antigravity hits for `cheap` after apply time T (UTC ISO):
`python3 -c "import sqlite3;c=sqlite3.connect('file:/home/jamesilsley/.machine-omniroute/data/storage.sqlite?mode=ro',uri=True);print(c.execute(\"select count(*) from call_logs where combo_name='cheap' and provider='antigravity' and timestamp>?\",('<T>',)).fetchone())"` -> `(0,)`. Allow for the gateway's cache refresh: take T as the PATCH completion time plus 15s.

## Audit — antigravity elsewhere (report only, nothing edited)
Read-only, 2026-11-11:
- `cheap` is reached by alias `machine-small` AND `mira-indexer` (`model_combo_mappings`, priority 10, enabled), and by `claude-haiku-combo` via a combo-ref. `machine-subagent`, `machine-builder`, `machine-manager` -> `standard` (no antigravity member).
- `static-best-coding`, `static-best-coding-fast`, `static-fast`: weighted, 298 members each, 11 antigravity members each (`auto-duplicate-auto/<name>-169..179`). No `model_combo_mappings` row and no combo-ref points at them; call_logs show 0 rows with `combo_name like 'static-%'` since 2026-11-08. So no live alias reaches them. They are reachable only if a client names them directly. Not in scope; flagged.
- Other antigravity traffic since 2026-11-10: 1 call via `auto/best-coding` by key `attended-james` (status 200), and 36 `connection-test` rows (provider connection health tests). Neither goes through `cheap`.

## Findings for Steve / LaQuesha (decide; not acted on)
0. Required reportable (Mira): after removal Mira's `cheap` traffic (alias `mira-indexer`, plus `machine-small` if used) moves to the other 5 members. Since 2026-11-10 `cheap` took ~3,350 successful calls on zai (1,752) and openrouter (1,366) plus the antigravity ones, so the remaining pool already carries most of the load, but nobody has sized it for Mira's share. Who owns Mira's alias, and is the remaining pool sized for it? Not expanded here.
1. Live impact: since 2026-11-10, 725 calls through `cheap` landed on `antigravity/gpt-oss-120b-medium`, ALL by API key `mira` (status 200, `tokens_out` 0, `error_type` none, last 2026-11-11T11:24:55Z). The other keys (agent-patti, agent-argus, ...) in the same window were served by zai or openrouter, because round-robin plus failover moved them off it. So the removal also changes what Mira's indexer/review traffic sees, not just `reader`. Worth telling whoever owns Mira's alias.
2. The 200/`tokens_out` 0 pattern means the gateway counts these as successes, so failover never skips the member. This is why the connection looks healthy (`is_active=1`, `test_status active`).
3. The `static-*` combos keep the same dead member. Nothing reaches them today. A later card could remove them, or confirm they stay unused; not part of this leaf.
4. SPA-17861's part 2 (child `ses_e47d03e00ffeo7lxOfzFSKEkm6` not linkable) stays as the card says: treated as covered by DR 22991a25; Steve to confirm.

## Not done / out of scope
No store write, no PATCH, no restart, no settings change. Dry-run was the sqlite `mode=ro` check above only; the HTTP path was not exercised (no credential used).
