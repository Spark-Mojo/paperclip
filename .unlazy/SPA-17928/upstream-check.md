# SPA-17928 R3: upstream changelog check

Scope: whether upstream paperclipai/paperclip fixed the SPA-17926 defect
(terminal sweep archives a workspace still inherited by a live separate-root
tree via executionWorkspaceId; automation setup on the closed workspace fails
with bare `setup_failed`).

## Local tree state

- Newest in-tree release note: `releases/v2026.916.1.md` (patch on 2026.916.0).
- Local `releases/` mentions: reaper cooldown (v2026.831.0), "archived work
  reopens in place" + reaper starvation fix (v2026.824.0), workspace setup
  retry recovery (v2026.916.0). No mention of executionWorkspaceId inheritance,
  `setup_failed`, or cross-root inheritors.
- No `executionWorkspaceId` / `setup_failed` / `inheritor` hits in `releases/`.

## Upstream check (2026-11-08, latest stable v2026.1106.0, released 2026-11-06)

- Fetched release body for `paperclipai/paperclip@v2026.1106.0` (515 commits,
  45k chars) plus v2026.916.1 / v2026.916.0 / v2026.831.1 / v2026.831.0 /
  v2026.824.0 bodies via GitHub releases API.
- Regex sweep for sweep|terminal workspace|execution-workspace archiv|inherit|
  reopen|closed|setup_failed|reap across the v2026.1106.0 body: only four hits —
  (1) "one hour after a task tree finishes, the terminal-workspace reaper
  removes regenerable directories" (compaction, PR #16331 context);
  (2) pooled-connection fix touching "workspace readiness, or the reaper"
  (#16857/#16859); (3) "terminal workspace cleanup" moving off DB polling
  (#16282); (4) `PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS` default 7 -> 1
  (#16304).
- None of the hits changes the sweep archive predicate (terminal source tree
  vs live separate-root inheritor sharing one workspace) or the heartbeat
  setup error surface (workspace id + closed state vs bare `setup_failed`).
- Older stable notes (916.x/831.x/824.0) likewise carry no such fix.

## Outcome: ABSENT upstream — proceed with local fix

No upstream version fixes this defect, so the engine-repair tree should fix it
locally rather than align with an upstream change. Regression scaffolding for
that fix is committed on this branch as
`server/src/__tests__/execution-workspace-sweep-inheritor.test.ts`
(commit 4b1d6234896d06ede9c10ae83dcf91d0ee45ec9b): both tests RED as required
(sweep archives shared row despite live inheritor; archived setup surfaces no
id/closed state).
