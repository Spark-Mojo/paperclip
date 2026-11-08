# SPA-17861 final localization verdict

Level: SPEC'D — diagnosis completed; no fix or rollout applied.

## Final verdict

SPA-17841's provisional `DID-NOT-REACH` verdict is **REFUTED**. The marked reader child did reach OmniRoute on `bigbox`; its requests were served by the local `:20128` listener. The failed lane was not `machine-subagent`: the full child row resolves to `reader` → `omniroute/machine-small` → OmniRoute combo `cheap`.

The one-side localization is **OmniRoute routing/configuration for the `machine-small` alias**, specifically the live database rows:

- `model_combo_mappings.pattern = "machine-small"` → combo `cheap`;
- `combos.name = "cheap"`, whose first model is `antigravity/gpt-oss-120b-medium` and strategy is `round-robin`;
- the 11 retry call logs all select that Antigravity model and return the same deprecation response.

This is a live runtime configuration surface under `/home/jamesilsley/.machine-omniroute/data/storage.sqlite`, not Engine Fork source. The client parser's strict `finish_reason` halt remains secondary evidence, not the fix: relaxing `requireFinishReason` or upgrading only to accept the deprecation response would mask the dead route.

**Single minimal fix direction:** upstream routing fix — remove/repoint the unsupported Antigravity target in OmniRoute's `cheap` combo so `machine-small` selects a supported provider. **Rollout class:** provider/model routing change; James approval is required and Rev applies it. Ty sign-off is also required because this changes shared gateway routing. No rollout occurred on this leaf.

## Five questions, answered in order

1. **Who served the stream?** OmniRoute served it. Dex's read-only DB contains full child `ses_e47d03e00ffeo7lxOfzFSKEkm6`, parent `ses_e47db8a17ffe8ZLsngMZN2N8Rm`, agent `reader`, model `omniroute/machine-small`, created `2026-11-07T22:45:00.050Z`. The gateway journal records `POST /v1/chat/completions | machine-small` at `22:45:00.110Z`. OmniRoute's matching call log `2026-11-07T22-45-00.917Z_cef5e321-a43f-41ed-9ec3-de2b954240c5.json` records HTTP 200, provider `antigravity`, model `gpt-oss-120b-medium`, content `This version of Antigravity is no longer supported...`, and normalized `finish_reason:"stop"`. The child DB stores that exact content plus `provider.invalid-output` / `OpenAI Chat stream ended without finish_reason` / status 200. Raw SSE bytes are not retained; therefore the exact parser-vs-translation mechanism is unresolved, but it does not change the routing fix because the payload itself is an unsupported-provider failure.

2. **Which host ran Dex's probe?** `bigbox`. Dex's live run log records the marked dispatch from cwd `/srv/bulk/worktrees/engine-fork/SPA-17659`; the correlated gateway journal entries identify host `bigbox`. The earlier off-host caveat is withdrawn.

3. **What listened on `:20128` there?** OmniRoute. Fresh read-only observation at `2026-11-08T00:13:31Z`: `ss` shows `0.0.0.0:20128` owned by `omniroute (v16.3.5)` PID 893956; `omniroute.service` is active with parent PID 887177 and `NRestarts=0`.

4. **Does the XDG overlay alter machine-subagent beyond baseURL?** The resolved provider block and fleet provider block agree on `providers.omniroute.settings.baseURL = http://127.0.0.1:20128/v1` and model compatibility. But this probe was `machine-small`, not `machine-subagent`; the agent binding is `agent.reader.model = omniroute/machine-small`. Thus the prior overlay question targeted the wrong lane and cannot explain this failure.

5. **Full-key request reach?** Full parent→child mapping is now proven from Dex's own read-only DB. Gateway AUTH truncates to parent `ses_e47db8a...` by design; the child request inherits the parent's prompt-cache/session key. The first child attempt aligns at 22:45:00.110Z, and all 11 assistant attempts map to 11 `agent-dex` OmniRoute call logs from `22:45:00.917Z` through `22:46:32.473Z`. Every one is HTTP 200 via `antigravity/gpt-oss-120b-medium`, output 69 tokens, normalized `finish_reason:"stop"`, and the same unsupported-version text. Final request-reach verdict: **REACHED**.

## RECEIPT (a)–(e)

(a) **Baseline:** SPA-17841 recorded `NRestarts=0` at `2026-11-07T23:19:34Z`; fleet config SHA-256 `369a1606755fe455114bc0eb6cfb4dccd2e33aff60dd1d3c772d11c023a4ddfc`.

(b) **Request identity and final reach:** parent `ses_e47db8a17ffe8ZLsngMZN2N8Rm`; child `ses_e47d03e00ffeo7lxOfzFSKEkm6`; child created `22:45:00.050Z`; gateway POST `machine-small` at `22:45:00.110Z`; 11 matching `agent-dex` call logs, all Antigravity HTTP 200. Verdict **REACHED**.

(c) **Parser fixture:** commit `60170f2a517299bad1397bb0bfea33276242d30e`, runnable with `node .unlazy/SPA-17841/repro-keepalive.mjs`. Prior receipt: `REPRODUCTION: CONFIRMED ...`; `CONTROL: normal stop stream does not halt ...`; `MASK-CHECK: requireFinishReason:false ... (tolerance is a mask, not a transport fix)`. Gateway keepalive is not the cause.

(d) **Final localization + fix direction:** OmniRoute live routing DB `model_combo_mappings(machine-small→cheap)` and `combos(cheap first target antigravity/gpt-oss-120b-medium)`. Minimal fix is upstream routing correction, with James+Rev and Ty approval; not client tolerance, not baseURL change, not keepalive suppression.

(e) **R3 oracle:** end observation `2026-11-08T00:18:51Z` is `NRestarts=0`; fleet opencode config SHA-256 remains exactly `369a1606755fe455114bc0eb6cfb4dccd2e33aff60dd1d3c772d11c023a4ddfc`. Settings diff: empty; no restart, settings edit, binary upgrade, gateway option, or rollout performed.

Still missing: fix implementation and approved rollout on SPA-17842; post-fix R1 five-dispatch oracle; Guild verification of this diagnosis.