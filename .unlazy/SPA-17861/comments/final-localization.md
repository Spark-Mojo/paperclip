# SPA-17861 final localization verdict (round 2 — qualified; specific-child bridge OPEN)

Level: SPEC'D — diagnosis completed; no fix or rollout applied.

## Final verdict (two-part, explicitly qualified)

**Part 1 — PROVEN (non-provisional): marked parent-context traffic REACHED the gateway.**
19 call logs in the 22:45:00–22:46:59Z window carry `MARKER_DISPATCH_START` in the
request message content together with `requestBody.prompt_cache_key =
ses_e47db8a17ffe8ZLsngMZN2N8Rm`; 11 of them are the `agent-dex` / combo `cheap` /
`antigravity/gpt-oss-120b-medium` retries (22:45:00.917Z–22:46:32.473Z, all HTTP 200,
69 tokens out, same unsupported-version text). First gateway POST for `machine-small`
at 22:45:00.110Z on `bigbox`, served by the local `:20128` listener (OmniRoute v16.3.5).

**Part 2 — OPEN (unproven from this host): whether the specific child
`ses_e47d03e00ffeo7lxOfzFSKEkm6` dispatched the marked request.**
Exhaustive read-only search on `bigbox` this run (see Round-2 evidence) finds the full
27-char child ID in NO pre-existing artifact: 0 rows in all 42 local/agent SQLite stores,
0 hits in the gateway journal 22:44–22:47Z, 0 files among 2026-11-07 call logs, 0 hits in
client logs and tool-output. Marker-plus-parent-key proves marked conversation content
reached the gateway under that parent, not that this specific child dispatched it
(the marker also appears in the 22:44:57Z parent-standard call `7ac68fa3` and the
22:45:00.017Z tool-echo call `32aa1a45`, so it propagates in inherited content).

**Consequence for DoD-2:** the full-session-key evidence bridge for the SPECIFIC child
is NOT closed and cannot be closed from this host read-only. Closing it needs either
(a) read access to the off-host store holding Dex's SPA-17824 live session rows, or
(b) an explicit scope/acceptance change by LaQuesha/Ty. This leaf's non-provisional
REACHED claim is therefore scoped to marked parent-context traffic only; the
specific-child dispatch verdict stays provisional/OPEN. No prior REACHED-for-the-child
wording stands — all of it is withdrawn (see provenance note).

The one-side localization is **OmniRoute routing/configuration for the `machine-small`
alias**, specifically the live database rows (read 2026-11-08, `storage.sqlite`, read-only):

- `model_combo_mappings.pattern = "machine-small"` → combo id `7b7295a0-7880-41ad-8cec-953bbed211ac` (`cheap`);
- `combos.name = "cheap"`, whose first model entry is `antigravity/gpt-oss-120b-medium` with `strategy: round-robin`;
- the 11 retry call logs all select that Antigravity model and return the same deprecation response.

This is a live runtime configuration surface under
`/home/jamesilsley/.machine-omniroute/data/storage.sqlite`, not Engine Fork source.
The client parser's strict `finish_reason` halt remains secondary evidence, not the fix:
relaxing `requireFinishReason` or upgrading only to accept the deprecation response would
mask the dead route.

**Single minimal fix direction:** upstream routing fix — remove/repoint the unsupported
Antigravity target in OmniRoute's `cheap` combo so `machine-small` selects a supported
provider. **Rollout class:** provider/model routing change; James approval is required
and Rev applies it. Ty sign-off is also required because this changes shared gateway
routing. No rollout occurred on this leaf.

## Round-2 evidence (this run, read-only, host `bigbox`)

- **42-DB column-wise scan, 0 hits.** `opencode.db` plus all 41 agent stores
  (`~/.local/share/opencode/agents/*.db`): every column of every table queried with
  `CAST(col AS TEXT) LIKE` for `%ses_e47d03e%` (truncated), `%MARKER_DISPATCH_START%`,
  and `%ses_e47db8a17ffe8ZLsngMZN2N8Rm%` (parent) — zero hits for all three patterns
  in every store. (Python `sqlite3`, `file:...?mode=ro`.)
- **Gateway journal 22:44–22:47Z, 0 hits.** `journalctl --user -u omniroute`:
  full child ID 0 lines; truncated `ses_e47d03e0` 0 lines. (AUTH truncates to the
  parent key by design, so journal text cannot carry the child key either way.)
- **2026-11-07 call logs: full child in 0 files.** 60 files in the 22:44–22:54Z window
  carry `MARKER_DISPATCH_START`; all carry parent `prompt_cache_key`, none carries the
  full child ID anywhere in the logged request/response body.
- **Client logs / tool-output, 0 hits.** `opencode.log.1` (12 MB, covers 11-07):
  0 hits for truncated, full, and marker strings; `tool-output/` 0 hits for `ses_e47d03e0`.
- **Provenance: the full child string has no pre-existing source on this host.**
  `git log -S ses_e47d03e00ffeo7lxOfzFSKEkm6` first fires on this leaf's own commits
  (`12384a85e`, `8b57f45dc`); SPA-17824 evidence and all SPA-17841 verdicts carry only
  the truncated `ses_e47d03e0`. The `reader / omniroute/machine-small / created
  22:45:00.050Z` attribution from the 00:20Z verdict was never sourced and stays
  WITHDRAWN. (2026-11-08 call-log hits for the full ID are this session's own gateway
  request bodies quoting the card — self-reference, not 11-07 evidence.)
- **Dex agent store is stale:** `dex-88818f10.db` `session` table holds 422 rows, newest
  `time_created` 1791579219313 (= 2026-10-09), zero sessions in the 22:44–22:47Z window —
  it could never have held the child row.
- **Oracle (fresh):** `NRestarts=0`; fleet config SHA-256 stays
  `369a1606755fe455114bc0eb6cfb4dccd2e33aff60dd1d3c772d11c023a4ddfc`;
  `node .unlazy/SPA-17841/repro-keepalive.mjs` exits 0 with all 3 verbatim lines;
  `git diff --check` clean; `pnpm-lock.yaml` clean (restored to HEAD); committed
  deliverables remain only `60170f2a` (repro) and this localization record.

## Five questions, answered in order (round-2 qualified)

1. **Who served the stream?** OmniRoute served the marked-conversation traffic (Part 1
   above). Matching call log `2026-11-07T22-45-00.917Z_cef5e321-….json`: HTTP 200,
   provider `antigravity`, model `gpt-oss-120b-medium`, `prompt_cache_key =
   ses_e47db8a17ffe8ZLsngMZN2N8Rm`, `MARKER_DISPATCH_START` in the user message, content
   `This version of Antigravity is no longer supported...`, normalized
   `finish_reason:"stop"`. Raw SSE bytes are not retained; parser-vs-translation
   mechanism unresolved but immaterial to the routing fix.
2. **Which host ran Dex's probe?** `bigbox` (correlated gateway journal entries).
   Off-host caveat withdrawn for the gateway side; Dex's live session rows themselves
   live off-host and are not readable here.
3. **What listened on `:20128` there?** OmniRoute (v16.3.5, PID 893956 at observation
   2026-11-08T00:13:31Z; `NRestarts=0`).
4. **Does the XDG overlay alter machine-subagent beyond baseURL?** No functional
   difference found (same baseURL `http://127.0.0.1:20128/v1`); and the probe lane was
   `machine-small`, not `machine-subagent`, so the overlay question cannot explain it.
5. **Full-key request reach?** Parent-context: REACHED (non-provisional, Part 1).
   Specific child `ses_e47d03e00ffeo7lxOfzFSKEkm6`: UNPROVEN/OPEN (Part 2) — no
   checkable artifact on this host links the full child ID to the parent and the marked
   request while excluding sibling/parent requests.

## RECEIPT (a)–(e)

(a) **Baseline:** SPA-17841 recorded `NRestarts=0` at `2026-11-07T23:19:34Z`; fleet config
SHA-256 `369a1606755fe455114bc0eb6cfb4dccd2e33aff60dd1d3c772d11c023a4ddfc`.

(b) **Request identity and final reach:** parent `ses_e47db8a17ffe8ZLsngMZN2N8Rm`
(call-log `prompt_cache_key` + `MARKER_DISPATCH_START` in 19 logs of the 22:45–22:46
window); first gateway POST `machine-small` at `22:45:00.110Z`; 11 matching `agent-dex`
call logs, all Antigravity HTTP 200. Verdict **REACHED — scoped to marked
parent-context traffic**. Full child row `ses_e47d03e00ffeo7lxOfzFSKEkm6`: 0 rows /
0 hits in every store, log, and journal checked — OPEN, not cited as evidence.

(c) **Parser fixture:** commit `60170f2a517299bad1397bb0bfea33276242d30e`, runnable via
`node .unlazy/SPA-17841/repro-keepalive.mjs`. Receipt: `REPRODUCTION: CONFIRMED ...`;
`CONTROL: normal stop stream does not halt ...`; `MASK-CHECK: requireFinishReason:false
... (tolerance is a mask, not a transport fix)`. Gateway keepalive is not the cause.

(d) **Final localization + fix direction:** OmniRoute live routing DB
`model_combo_mappings(machine-small→cheap 7b7295a0)` and `combos(cheap first target
antigravity/gpt-oss-120b-medium, round-robin)`. Minimal fix is upstream routing
correction, with James+Rev and Ty approval; not client tolerance, not baseURL change,
not keepalive suppression.

(e) **R3 oracle:** end observation (this run) is `NRestarts=0`; fleet opencode config
SHA-256 remains exactly `369a1606755fe455114bc0eb6cfb4dccd2e33aff60dd1d3c772d11c023a4ddfc`.
Repro re-run exits 0 with all 3 verbatim lines. Settings diff: empty; no restart,
settings edit, binary upgrade, gateway option, or rollout performed.

Still missing: specific-child session-row bridge (no store on this host holds
`ses_e47d03e00ffeo7lxOfzFSKEkm6` — needs off-host access or a scope/acceptance ruling
from LaQuesha/Ty); fix implementation and approved rollout on SPA-17842; post-fix R1
five-dispatch oracle; Guild verification of this diagnosis.
