# Fork patch list — Spark-Mojo/paperclip, rebuild/v2026.831.1-survivors

This branch is a fresh fork of upstream `v2026.831.1`, carrying forward only
the patches from the pre-831.1 fork (`spark/master`) that survived the
2026-09-05 adversarial review
(`vault/sparkmojo-platform/logs/2026-09-05-ENGINE-CHANGES-ADVERSARIAL-REVIEW.md`,
including its Decisions-v1 addendum, which changed none of the per-change
verdicts). It is not a merge of `spark/master` into `v2026.831.1` — the
review's own migration-risk finding is that `spark/master` already carries a
dropped patch (PR #34's code) that would contaminate the merge base for
every other branch, so the clean route is to rebuild from the tag and
cherry-pick forward only what survives.

Each carried patch is its own commit on this branch, named by source PR and
card, so any one of them can be dropped by reverting a single commit. This
file is the durable index: what shipped, what didn't, and why.

## Carried patches (each is one commit on this branch)

| # | Source PR | Card | Change | Verdict | Retirement condition |
|---|-----------|------|--------|---------|----------------------|
| 1 | #35 | SPA-6060 | `scripts/engine/install.sh`/`rollback.sh`/`status.sh`/`lib.sh` + systemd unit + tests — versioned side-by-side installs on bigbox, one symlink flip to cut over, one command to roll back. Extended in this rebuild with an `ENGINE_LABEL` env knob so the "831" in `PAPERCLIP_HOME`/`UNIT_NAME`/`EXPECTED_DB` defaults is one variable, not three independent literals; the checked-in systemd unit filename stays `paperclip-831.service` by design. | KEEP AS IS — the only carried change that lives outside the vendor tree (rule 15); no rebase cost, no schema cost. | Not a vendor patch. Retire from this fork specifically when the scripts move to `spark-mojo-platform/scripts/engine` or `~/.sparkmojo/` — the review's own scoping objection. |
| 2 | #33 | SPA-6050 | Board Approve/Request-changes control (`StageDecisionActions.tsx`, `pendingStageDecisionFor` in `ui/src/lib/issue-execution-policy.ts`, inserted into `IssueProperties.tsx`) that sends `{status, comment}` in one PATCH, matching the engine's `commentRequired` enforcement. | KEEP AS IS — the strongest change in the review. Confirmed missing at 817, 831.1, and master; the Inbox page's own Approve button binds to a different, governed-approval object entirely. | Open an upstream PR against `paperclipai/paperclip` (general Approve control that sends the comment the server already demands). Retire this local patch when it merges. |
| 3 | #28 | SPA-5916 | Terminal-write guard (`issue_write_terminal_recomplete`, 409) — a routine PATCH that re-asserts a card's existing terminal status (`done`/`cancelled`) is rejected before any side effect; explicit `reopen`/`resume` stays the sanctioned escape hatch. | KEEP, caveat resolved. Tested against `scripts/merge-flow/deploy-gate-closer.py`: both `close_gate()` and the quarantine-notification auto-recover path already read the card's live status back and skip the PATCH when already terminal, so this guard is a steady-state no-op against the closer. The one residual is the read-back-then-PATCH race window; `run_sweep` already catches `PaperclipError` there and treats an already-terminal status as a committed close. | No obvious upstream PR path — the review is honest that reopen-on-comment may be deliberate upstream product design. Retire when upstream adds an equivalent terminal-write guard, or when comment-before-cancel / close-with-no-assignee becomes a platform-side enforced discipline that makes this fork patch redundant. |
| 4 | #22 (R1 only) | SPA-5841 | Allocator refuses to bind an `execution_workspace_id` already held by a different OPEN issue (`executionWorkspaceHeldByAnotherOpenIssue`) — a fresh workspace is provisioned instead of restoring the cross-issue one. | REWRITE FOR NEW MODEL (keep R1, drop R2 — see Dropped below). R1 is cheap, local, and fails with a sensible allocator decision rather than a database constraint. | Open an upstream PR for the R1 exclusivity check alone (not bundled with the dropped R2 index). Retire when it merges. |
| 5 | #22 (R3 only) | SPA-5839 / SPA-5845 | Per-repo mutex (`withWorktreeProvisionLock`, atomic file lock under `${PAPERCLIP_HOME}/locks` or `~/.paperclip/locks`) around every `git worktree add` site the fork commit touched, so concurrent provisioning on the same repo root serializes instead of racing on `.git/config.lock`. | REWRITE FOR NEW MODEL, carried alongside R1. Probed first (see below): no existing per-repo provisioning lock found at 831.1. | Contingent on the #19 probe (below): retire if a live-instance concurrent-allocation test shows 831.1 already serializes provisioning safely without this patch, or when an equivalent upstream PR merges. |
| 6 | #34 (docs only) | SPA-6057 | `docs/ops/recovery-service-2026-817-0-hand-edit-rescue/README.md` + `pristine-vs-installed.diff` — the sha256-diffed record of the hand edit found live on the 817 Homebrew install on 2026-09-03. | KEEP the record, DROP the code (see Dropped below). | Not applicable — historical record, not a patch on a vendor file. |

Pre-existing probe check run before carrying #5 (R3), per the review's own
"leaning KEEP only if the probe shows no upstream lock": grepped
`v2026.831.1`'s `server/src/services/workspace-runtime.ts` and
`execution-workspaces.ts` for `provisionLock`/`advisory`/`lockfile`/`flock`/
`withLock`/`mutex`. Found only two unrelated mechanisms — a Postgres
advisory lock scoped to execution-workspace lifecycle transactions, and an
in-memory owner-keyed mutex around runtime SERVICE startup concurrency
(`withRuntimeStartMutex`) — neither of which serializes git worktree
PROVISIONING by repo. This does not prove absence with certainty; the live
concurrent-allocation probe (#19, below) is still the thing that should run
before R3 is trusted in production.

## Dropped patches (not carried, with the review's own reason)

| Source PR(s) | Card | Reason dropped |
|---|---|---|
| #22 (R2 portion) | SPA-5841 | The fork-only partial unique index `issues_execution_workspace_id_open_uniq` (and its migration/journal entry). Direct, measured cause of a 216M-token/day recovery-tick hot loop (PR #27's entire reason to exist); collides with upstream migrations 0231–0239 at `upstream/master`. Upstream itself ships only a non-unique index on this column. |
| #27 | SPA-6006 | Recovery-tick insert-retry guard. The insert only fails because of the R2 index this fork added; remove R2 and the loop cannot happen. 817 already had an upstream unique-conflict guard (`isUniqueLivenessRecoveryConflict`) whose constraint list excludes this fork's constraint name, so it never could have helped — direct evidence the problem was self-inflicted. |
| #17, #24, #26 | SPA-5930 (rehearsals) | The standalone R2 index, and renumbering/CI-probe rehearsals of the same migration. Dead weight once R2 is dropped; #26 is already titled "do not merge". |
| #34 (code portion) | SPA-6057 | Rescues a hand edit made against the 817 compiled output — the version this migration leaves. Merging it into the fork does not make it correct on 831.1; it would be 1549 lines of delta owned forever against `recovery/service.ts`, one of the two fastest-moving files in the tree. The docs record is kept (see Carried, row 6); the code is not. |
| #30 | SPA-6043 | "Deliberate wait must not escalate to manager/cto" — `f572e0867` (already an ancestor of `v2026.831.1`) removed the manager/cto fallback before our target tag; the exhausted-recovery owner is now the board (`recovery/service.ts:2132`/`:245`). Carrying 613 lines to solve a problem the vendor solved before our target tag is becoming the maintainer for nothing. The narrower residual worth keeping (in_review routing for a card with a review stage) is a fraction of the original patch and is not carried here; the zero-vendor-cost companion (sparkmojo-internal PR #450/#452) is the cheaper route if this is revisited. |
| #31 | SPA-6051 | Board-only confirmations must carry a decision shape. Right rule, wrong layer: this is Spark Mojo's own governance rule (law 16) enforced inside a vendor server with no retirement condition, which rule 15 says must be escalated rather than adopted. The correct implementation is `interaction-ask-guard.py` as a PreToolUse hook (sparkmojo-internal PR #452, still open) — same enforcement, zero vendor-tree cost. The Decisions-v1 addendum's finding sharpens the retirement condition further: retire when the fleet proposes decisions through the engine's own typed `decisions` table instead of filing shapeless confirmations. |
| #29 | SPA-6039 | Auto-reattach a clean detached-HEAD worktree. **Defect finding, not a preference**: the diff deletes the vendor's `ancestryVerdict === "ancestor" && !sameHead` safety guards rather than extending them. Concrete failure scenario: a clean detached HEAD BEHIND the recorded branch tip gets `checkout -B` onto it, silently discarding every commit between the detached HEAD and the previous tip — the PR's own comment concedes "rewind risk... accepted as low-likelihood tech debt". Upstream already has detached-HEAD reattach with the ancestor-only guard intact since before 817 (commit `555391fed`); SPA-5250 bounced because its shape was a genuinely DIVERGED HEAD the ancestor gate correctly refuses, not because the feature was missing. |

## Awaiting a live-instance probe (UNKNOWN, not carried pending the result)

| Source PR / item | Card | Probe |
|---|---|---|
| #32 | SPA-6055 | Every observation of the underlying defect (a recorded stage decision not transitioning the card) was made on 817 with a hand-edited `recovery/service.ts` touching this exact code path — the review's strongest "this may be an artefact of our own hand edit" case. Probe: on stock 831.1, create a card with a review stage, have the reviewer record `REQUEST_CHANGES`, let the reconciler tick, and read whether the card transitions to the executor or is blocked with `recovery.reconcile_execution_review_participant`. |
| #25 | SPA-5973 | Observed once, during a run James ruled tainted by hand intervention (humans and recovery both writing `executionPolicy` on the same cards that day). Probe: on stock 831.1, create a card with two review stages, have the first reviewer record an approve via PATCH with a comment, then GET the card and read whether `executionPolicy.stages` survives. Cheapest branch to rebase if confirmed — lowest migration risk of the whole set, no server conflicts reported. |
| #19 | SPA-5845 R3 | Same mechanism as the carried R3 patch (row 5, above) — a per-repo worktree-provisioning mutex. This rebuild's own grep found no existing lock at 831.1 (see the probe note under Carried), but did not prove absence with certainty, and the underlying race was never directly measured (SPA-5250's cause was a rebase, not a proven concurrent-allocation collision). Probe: attempt two concurrent allocations against the same repository on a live 831.1 instance and read whether either corrupts the resulting worktree. |
| #23 | SPA-5925 | No measured harm named in the handoff — every other item in this review points at tokens burned, cards stalled, or a human blocked; this one points at a missing audit row. Probe: grep `configRevision` in `v2026.831.1:server/src/routes/agents.ts` and `services/agents.ts`; then PUT an instructions bundle on a live 831.1 instance and read whether a config-revision row appears. Lowest priority in the set. |

## Journal-drift check (run before rebuilding)

The drizzle journal must always match the migration files on disk, or a
stale/mis-ordered migration set gets baked into the build:

```bash
node packages/db/src/check-migration-numbering.ts          # journal ↔ files, ordering, duplicates
TMPDIR=/tmp server/node_modules/.bin/tsx packages/db/src/check-migration-safety.ts   # safety rules vs baseline
```

Both run automatically as part of `pnpm --filter @paperclipai/db build`
(`check:migrations` script). On this branch, `packages/db/src/migrations/`
is byte-identical to `v2026.831.1` — confirmed with
`git diff --quiet v2026.831.1 -- packages/db/src/migrations/` — because
every carried patch above deliberately excludes R2's index and migration.
