# SPA-17861 resubmission — review findings addressed (commit 12384a85e)

Review verdict requested two blocking fixes plus one hygiene note. All three are addressed; the routing localization itself is unchanged (Argus independently reproduced it).

## Finding 1 (blocking) — unproven child-row claim: WITHDRAWN, verdict re-grounded

The prior verdict's `reader / omniroute/machine-small / created 22:45:00.050Z` attribution for full child `ses_e47d03e00ffeo7lxOfzFSKEkm6` is withdrawn. Re-check on this host (read-only):

- 0 rows in local `opencode.db` for both full session IDs (session, session_v2, session_message, message, part, data LIKE) — confirms Argus.
- 0 rows in Dex's agent store `/home/jamesilsley/.local/share/opencode/agents/dex-88818f10.db` — and that store is stale (422 sessions, newest `time_created` 2026-10-09, zero sessions in the 22:44–22:47Z window), so it could never have held the child row. There is no exact database file plus reproducible read-only query returning that child row to name — none was found on this host.
- The corrected `final-localization.md` no longer cites any child DB row as evidence. REACHED now rests on gateway-side artifacts only: 19 call logs in the 22:45–22:46Z window carry `MARKER_DISPATCH_START` in the request message content together with `requestBody.prompt_cache_key = ses_e47db8a17ffe8ZLsngMZN2N8Rm`; 11 of them are the `agent-dex` / combo `cheap` / `antigravity/gpt-oss-120b-medium` retries (all HTTP 200, 69 tokens out, same deprecation text).

## Finding 2 (blocking) — timing/identity: reconciled

SPA-17824's `22:44:57Z` is the parent-side dispatch time (truncated probe key `ses_e47d03e0`). First gateway POST `machine-small` is at `22:45:00.110Z` — ~3s dispatch overhead, consistent. The earlier ±60s journal search missed it because it grepped the journal for the truncated session text key, while gateway AUTH truncates to the parent key `ses_e47db8a…` by design; the attributable bridge is `prompt_cache_key` + the `MARKER_DISPATCH_START` marker inside the logged request body (verified read-only in `2026-11-07T22-45-00.917Z_cef5e321-….json`: marker present, `prompt_cache_key` present, `comboName: cheap`, `requestedModel: antigravity/gpt-oss-120b-medium`).

## Finding 3 (non-blocking) — pnpm-lock.yaml: reverted

The 28-line `pnpm-lock.yaml` modification was reverted (`git restore --source=HEAD`), confirmed clean. Committed deliverables remain only `60170f2a` (repro artifact) and the localization record.

## Re-verified oracle (this run, read-only)

- `NRestarts=0`; fleet config SHA-256 `369a1606755fe455114bc0eb6cfb4dccd2e33aff60dd1d3c772d11c023a4ddfc`; repro exits 0 with all 3 verbatim lines; `git diff --check` clean.
- Routing rows confirmed read-only from `storage.sqlite`: `model_combo_mappings(machine-small → cheap 7b7295a0)`; `combos(cheap)` first model `antigravity/gpt-oss-120b-medium`, `strategy round-robin`.

## Still missing (unchanged)

Full child session-row attribution (no store on this host holds the child ID); fix implementation and approved rollout on SPA-17842; post-fix R1 five-dispatch oracle; Guild verification of this diagnosis.

IN-SESSION ONLY observed throughout: no subagent dispatched; gate-runner/critic/verify remain Guild-reserved per the card's binding constraint.
