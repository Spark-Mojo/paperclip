# Gates ledger — SPA-17861 final localization leaf

DELIVERABLE: d1 | craft: none | paths: .unlazy/SPA-17861/comments/final-localization.md
EVIDENCE: constraint | IN-SESSION ONLY forbids all subagent dispatch; this diagnosis-only leaf performs read-only observations and leaves verification to the Guild
EVIDENCE: vendor | none: diagnosis-only read-only leaf; no implementation or vendor-touching deliverable
EVIDENCE: repro | commit: 60170f2a517299bad1397bb0bfea33276242d30e | path: .unlazy/SPA-17841/repro-keepalive.mjs | first act complete
EVIDENCE: localization | prior DID-NOT-REACH REFUTED on gateway evidence | parent ses_e47db8a17ffe8ZLsngMZN2N8Rm via prompt_cache_key + MARKER_DISPATCH_START in 19 call logs | 11/11 agent-dex calls reached OmniRoute machine-small→cheap→antigravity/gpt-oss-120b-medium and returned unsupported-version text | full child ses_e47d03e00ffeo7lxOfzFSKEkm6: 0 rows everywhere checked — WITHDRAWN, see d1-correction
EVIDENCE: d1 | commit: 8b57f45dc5e17e774cd473e1ab9f766cdec8ac1e | result: final-localization.md written | checks: git diff --check PASS; repro EXIT 0; NRestarts=0; fleet config sha 369a1606755fe455114bc0eb6cfb4dccd2e33aff60dd1d3c772d11c023a4ddfc | gate-runner/critic/verify: prohibited by IN-SESSION ONLY/no subagents; Guild verification reserved | at: 2026-11-08T00:18:51Z
EVIDENCE: d1-correction | at: 2026-11-08T00:42:51Z | finding1: full child ses_e47d03e00ffeo7lxOfzFSKEkm6 has 0 rows in local opencode.db AND in dex agent store (422 rows, newest 2026-10-09, zero sessions in 22:44-22:47Z window) — prior child-row claim WITHDRAWN; finding2: 22:44:57Z is parent dispatch time, first gateway POST machine-small 22:45:00.110Z (~3s dispatch overhead), earlier miss explained by AUTH truncation to parent key; verdict re-grounded on 19 MARKER_DISPATCH_START call logs (11 agent-dex/cheap/antigravity retries) + prompt_cache_key | pnpm-lock.yaml reverted (unrelated, outside scope)
EVIDENCE: END | append above this sentinel
