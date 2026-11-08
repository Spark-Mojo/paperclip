# SPA-17861 final localization verdict (corrected after verify findings 1–2)

Level: SPEC'D — diagnosis completed; no fix or rollout applied.

## Final verdict

SPA-17841's provisional `DID-NOT-REACH` verdict is **REFUTED**. The marked probe's requests reached OmniRoute on `bigbox` and were served by the local `:20128` listener. The failed lane was not `machine-subagent`: the requests that carried the probe marker went to combo `cheap` (first model `antigravity/gpt-oss-120b-medium`).

The one-side localization is **OmniRoute routing/configuration for the `machine-small` alias**, specifically the live database rows (read 2026-11-08, `storage.sqlite`, read-only):

- `model_combo_mappings.pattern = "machine-small"` → combo id `7b7295a0-7880-41ad-8cec-953bbed211ac` (`cheap`);
- `combos.name = "cheap"`, whose first model entry is `antigravity/gpt-oss-120b-medium` with `strategy: round-robin`;
- the 11 retry call logs (22:45:00.917Z–22:46:32.473Z) all select that Antigravity model and return the same deprecation response.

This is a live runtime configuration surface under `/home/jamesilsley/.machine-omniroute/data/storage.sqlite`, not Engine Fork source. The client parser's strict `finish_reason` halt remains secondary evidence, not the fix: relaxing `requireFinishReason` or upgrading only to accept the deprecation response would mask the dead route.

**Single minimal fix direction:** upstream routing fix — remove/repoint the unsupported Antigravity target in OmniRoute's `cheap` combo so `machine-small` selects a supported provider. **Rollout class:** provider/model routing change; James approval is required and Rev applies it. Ty sign-off is also required because this changes shared gateway routing. No rollout occurred on this leaf.

## Corrections to the prior (00:20Z) verdict — verify findings addressed

**Finding 1 (was blocking): WITHDRAWN claim, verdict re-grounded.** The prior verdict stated Dex's read-only DB contains the full child row `ses_e47d03e00ffeo7lxOfzFSKEkm6` (reader / omniroute/machine-small / created 22:45:00.050Z). Independent re-check on this host finds that full child ID **nowhere**: 0 rows in local `opencode.db` (session, session_v2, session_message, message, part, data LIKE), and 0 rows in Dex's agent store `/home/jamesilsley/.local/share/opencode/agents/dex-88818f10.db` — whose `session` table holds only 422 rows with newest `time_created` 2026-10-09, i.e. a stale/forked store with zero sessions in the 22:44–22:47Z window. The `created 22:45:00.050Z / reader / machine-small` details are therefore **unattributed and withdrawn**; no exact database file plus reproducible read-only query returning that child row is offered, because none was found. The REACHED verdict below no longer depends on any child DB row.

**Finding 2 (was blocking): reconciled.** SPA-17824's `22:44:57Z` is the parent-side dispatch time (truncated probe key `ses_e47d03e0`); the first gateway POST for `machine-small` at `22:45:00.110Z` is ~3s later, consistent with dispatch overhead. The earlier ±60s journal search missed it because it grepped the journal for the truncated session text key, while gateway AUTH truncates to the parent key `ses_e47db8a…` by design — the attributable link is the call-log `requestBody.prompt_cache_key = ses_e47db8a17ffe8ZLsngMZN2N8Rm` **plus** the `MARKER_DISPATCH_START` marker inside the request message content (19 call logs in the 22:45–22:46 window carry the marker; 11 of them are the `agent-dex`/`cheap`/Antigravity retries).

## Five questions, answered in order (corrected)

1. **Who served the stream?** OmniRoute served it. The gateway journal records `POST /v1/chat/completions | machine-small` at `22:45:00.110Z` on `bigbox`. OmniRoute's matching call log `2026-11-07T22-45-00.917Z_cef5e321-a43f-41ed-9ec3-de2b954240c5.json` records HTTP 200, provider `antigravity`, model `gpt-oss-120b-medium`, `prompt_cache_key = ses_e47db8a17ffe8ZLsngMZN2N8Rm` (the marked parent's key), `MARKER_DISPATCH_START` in the user message, content `This version of Antigravity is no longer supported...`, and normalized `finish_reason:"stop"`. Raw SSE bytes are not retained; therefore the exact parser-vs-translation mechanism is unresolved, but it does not change the routing fix because the payload itself is an unsupported-provider failure.

2. **Which host ran Dex's probe?** `bigbox`. The correlated gateway journal entries identify host `bigbox`. The earlier off-host caveat is withdrawn.

3. **What listened on `:20128` there?** OmniRoute. Fresh read-only observation at `2026-11-08T00:13:31Z`: `ss` shows `0.0.0.0:20128` owned by `omniroute (v16.3.5)` PID 893956; `omniroute.service` is active with parent PID 887177 and `NRestarts=0`.

4. **Does the XDG overlay alter machine-subagent beyond baseURL?** The resolved provider block and fleet provider block agree on `providers.omniroute.settings.baseURL = http://127.0.0.1:20128/v1` and model compatibility. But this probe was the `machine-small` lane, not `machine-subagent`. Thus the prior overlay question targeted the wrong lane and cannot explain this failure.

5. **Full-key request reach?** Parent→gateway mapping is proven from checkable artifacts; the child DB row is not. Gateway AUTH truncates to parent `ses_e47db8a...` by design; the child request inherits the parent's prompt-cache/session key. All 11 assistant attempts map to 11 `agent-dex` OmniRoute call logs from `22:45:00.917Z` through `22:46:32.473Z` (each carrying `MARKER_DISPATCH_START` + `prompt_cache_key ses_e47db8a17ffe8ZLsngMZN2N8Rm`). Every one is HTTP 200 via `antigravity/gpt-oss-120b-medium`, output 69 tokens, normalized `finish_reason:"stop"`, and the same unsupported-version text. Final request-reach verdict: **REACHED** (gateway-side evidence; child session-row attribution remains unproven — see still-missing).

## RECEIPT (a)–(e)

(a) **Baseline:** SPA-17841 recorded `NRestarts=0` at `2026-11-07T23:19:34Z`; fleet config SHA-256 `369a1606755fe455114bc0eb6cfb4dccd2e33aff60dd1d3c772d11c023a4ddfc`.

(b) **Request identity and final reach:** parent `ses_e47db8a17ffe8ZLsngMZN2N8Rm` (call-log `prompt_cache_key` + `MARKER_DISPATCH_START` in 19 logs); first gateway POST `machine-small` at `22:45:00.110Z`; 11 matching `agent-dex` call logs, all Antigravity HTTP 200. Verdict **REACHED** on gateway evidence. Full child row `ses_e47d03e00ffeo7lxOfzFSKEkm6`: 0 rows in every local and agent store checked — withdrawn, not cited as evidence.

(c) **Parser fixture:** commit `60170f2a517299bad1397bb0bfea33276242d30e`, runnable via `node .unlazy/SPA-17841/repro-keepalive.mjs`. Prior receipt: `REPRODUCTION: CONFIRMED ...`; `CONTROL: normal stop stream does not halt ...`; `MASK-CHECK: requireFinishReason:false ... (tolerance is a mask, not a transport fix)`. Gateway keepalive is not the cause.

(d) **Final localization + fix direction:** OmniRoute live routing DB `model_combo_mappings(machine-small→cheap 7b7295a0)` and `combos(cheap first target antigravity/gpt-oss-120b-medium, round-robin)`. Minimal fix is upstream routing correction, with James+Rev and Ty approval; not client tolerance, not baseURL change, not keepalive suppression.

(e) **R3 oracle:** end observation (this run) is `NRestarts=0`; fleet opencode config SHA-256 remains exactly `369a1606755fe455114bc0eb6cfb4dccd2e33aff60dd1d3c772d11c023a4ddfc`. Repro re-run exits 0 with all 3 verbatim lines. Settings diff: empty; no restart, settings edit, binary upgrade, gateway option, or rollout performed.

Still missing: full child session-row attribution (no store on this host holds `ses_e47d03e00ffeo7lxOfzFSKEkm6`); fix implementation and approved rollout on SPA-17842; post-fix R1 five-dispatch oracle; Guild verification of this diagnosis.
