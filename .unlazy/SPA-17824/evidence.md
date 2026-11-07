# SPA-17824 incident evidence (Dex run, 2026-11-07 ~22:32-22:51Z)

## Failures (in-run, pre-execution, all `OpenAI Chat stream ended without finish_reason`)
1. reader probe at run start (trivial one-liner brief)
2. reader probe "Marked transport probe" at 2026-11-07T22:44:57Z (session ses_e47d03e0)
3. reader probe "Marked transport probe retry" at ~22:46Z (session ses_e47d3b3c)

Prior: Patti reported same for 3 fresh gate-runner dispatches on SPA-17669 earlier today; SPA-17817 (parent escalation) describes the SPA-17669 g1/g2/g3/n1 rerun stuck at HEAD 82676609d.

## Gateway health (omniroute user unit, bigbox :20128)
- `systemctl --user is-active omniroute` = active, NRestarts=0, up since 2026-11-05. No restart performed.
- Gateway journal shows continuous STREAM complete receipts on all lanes through the failure windows, including machine-subagent POSTs routing to pinned command-code / codex models.
- Gateway-side truncated-stream errors in the last hour are ONLY on COMMAND-CODE/builder lanes (stream content stall 80s, empty content), none on machine-subagent.
- Direct curl replays to 127.0.0.1:20128 for combo machine-subagent ALL return HTTP 200 with finish_reason=stop + [DONE]:
  - 1-msg/11-tool replay of subagent envelope (22:46:48Z, 22:48:02Z)
  - 2-msg/1-tool replay (22:46:54Z)
  - three consecutive 1-msg/11-tool identical replays (22:50:32/33/34Z) each with stop+[DONE]
- Failing subagent dispatches left NO uniquely attributable gateway POST in the journal (e.g. the 22:44:57Z marked probe has no POST within +/-60s beyond routine lanes); the three 22:50:32-34Z probes that DID reach the gateway all completed.

## Client binary evidence (opencode v2.0.26)
- Binary strings contain the exact error site: openai-chat provider `eie` halts with `OpenAI Chat stream ended without finish_reason` (classification incomplete-stream) when `finishReason===void 0 && requireFinishReason`.
- Local fleet config /srv/bulk/paperclip-stock/repos/sparkmojo-internal/platform/pm-team/fleet/xdg/opencode/opencode.json pins machine-subagent → modelID machine-subagent, limit context 1000000/output 65536.
- Gateway emits `chatcmpl-keepalive` chunks (finish_reason:null) before real content; a client-side premature-evaluation / DONE-race mis-parse is the leading hypothesis, NOT proven.

## Advisor verdict (DECISION-139, in-run)
Option (1): do NOT restart omniroute. Restart is fleet-disruptive and unlocalized; planned restarts need James typed confirmation + attended operator; the card's live-incident authority was written for Ty as owner. Correlate failing timestamps against gateway, isolate via direct opencode-client runs, check for a newer opencode release, then route the repair.

## Open items
- Failing-dispatch ↔ gateway correlation is INCONCLUSIVE (no attributable POST for the 22:44:57Z probe).
- opencode release check beyond local v2.0.26 not yet performed (runner network roots restricted).
- No gate-runner dispatch has yet succeeded in this run; SPA-17669 rerun NOT attempted (forbidden until transport restored).
