# SPA-17861 round-2 resubmission — verdict QUALIFIED (verifier finding stands)

Round-1 resubmission honestly withdrew the unattributed child row and re-grounded REACHED on
gateway evidence. The verifier's second verdict rules that re-grounding insufficient for DoD-2:
marker-plus-parent-key proves marked conversation content reached the gateway under the parent,
not that the specific child `ses_e47d03e00ffeo7lxOfzFSKEkm6` dispatched it — and that critique
is CORRECT. This round does not re-argue it. The verdict is now two-part and the REACHED claim
is explicitly scoped; nothing the verifier called insufficient is restated as sufficient.

## What verifier finding 1 (round 2, blocking) establishes — CONCEDED

Marker propagation is confirmed in-session: the marker also appears in the 22:44:57Z
parent-standard call `7ac68fa3` and the 22:45:00.017Z tool-echo call `32aa1a45`, so
marker-plus-`prompt_cache_key ses_e47db8a17ffe8ZLsngMZN2N8Rm` cannot exclude sibling or
parent requests. A non-provisional REACHED for the specific child needs the one bridge
the DoD demands — a checkable artifact carrying the full 27-char child ID — and this run
proves by exhaustive read-only search on `bigbox` that no such artifact exists here.

## Exhaustive round-2 search (this run, host `bigbox`, read-only)

- **42 SQLite stores, column-wise, 0 hits**: `opencode.db` + all 41
  `~/.local/share/opencode/agents/*.db` — every column of every table via
  `CAST(col AS TEXT) LIKE` for `%ses_e47d03e%`, `%MARKER_DISPATCH_START%`,
  `%ses_e47db8a17ffe8ZLsngMZN2N8Rm%`: zero hits for all three patterns everywhere.
- **Gateway journal 22:44–22:47Z, 0 hits**: full child 0 lines, truncated `ses_e47d03e0`
  0 lines (`journalctl --user -u omniroute`).
- **2026-11-07 call logs: full child in 0 files** (all 60 marker files carry the parent
  key, none carries the full child ID).
- **Provenance: the full child string has no pre-existing source on this host.**
  `git log -S ses_e47d03e00ffeo7lxOfzFSKEkm6` first fires on this leaf's own commits;
  SPA-17824 evidence and all SPA-17841 verdicts carry only truncated `ses_e47d03e0`. The
  `reader / omniroute/machine-small / created 22:45:00.050Z` attribution was never sourced
  and stays WITHDRAWN. (2026-11-08 call-log hits for the full ID are this session's own
  request bodies quoting the card — self-reference, not 11-07 evidence.)
- **Dex store stale**: 422 sessions, newest `time_created` 1791579219313 (2026-10-09),
  zero sessions in the probe window.

## Qualified verdict (see final-localization.md)

- **Part 1 — PROVEN:** marked parent-context traffic REACHED OmniRoute (19 marker+pck
  logs; 11 `agent-dex`/`cheap`/Antigravity retries; first POST 22:45:00.110Z on `bigbox`,
  `:20128` OmniRoute v16.3.5). Non-provisional.
- **Part 2 — OPEN:** specific-child dispatch of `ses_e47d03e00ffeo7lxOfzFSKEkm6` unproven
  from this host. Closing it needs (a) read access to the off-host store holding Dex's
  SPA-17824 live session rows, or (b) a scope/acceptance ruling from LaQuesha/Ty.
- Routing localization itself is unchanged and was independently reproduced by the
  verifier: `model_combo_mappings(machine-small→cheap 7b7295a0)`,
  `combos(cheap)` first target `antigravity/gpt-oss-120b-medium`, round-robin. DoD-3/4/5
  unaffected.

## Verifier finding 2 (timing) — stays closed

No new timing evidence; 22:44:57Z = parent dispatch, first `machine-small` POST
22:45:00.110Z (~3s overhead), earlier miss explained by AUTH truncation to the parent key.

## Hygiene — lockfile

`pnpm-lock.yaml` restored to HEAD before this run (verified `git status` clean for it);
committed deliverables remain only `60170f2a` (repro) and the localization record.

## Fresh oracle (this run)

`NRestarts=0`; fleet config SHA-256
`369a1606755fe455114bc0eb6cfb4dccd2e33aff60dd1d3c772d11c023a4ddfc`;
`node .unlazy/SPA-17841/repro-keepalive.mjs` exits 0 with all 3 verbatim lines;
`git diff --check` clean.

## Still missing

Specific-child bridge (off-host access or LaQuesha/Ty scope ruling); fix implementation
and approved rollout on SPA-17842; post-fix R1 five-dispatch oracle; Guild verification.

IN-SESSION ONLY observed throughout: no subagent dispatched; gate-runner/critic/verify
remain Guild-reserved per the card's binding constraint.
