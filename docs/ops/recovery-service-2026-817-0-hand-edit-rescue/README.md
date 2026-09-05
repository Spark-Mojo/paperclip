# docs/ops/recovery-service-2026-817-0-hand-edit-rescue

Record for SPA-6057: rescue of the hand-edited `recovery/service.js` live on the
Homebrew npm install (`/opt/homebrew/lib/node_modules/paperclipai/...`) into the fork as
tracked TypeScript.

## Pristine tarball

- Package: `@paperclipai/server` `2026.817.0`
- Tarball: `https://registry.npmjs.org/@paperclipai/server/-/server-2026.817.0.tgz`
- sha256(pristine `dist/services/recovery/service.js`): `00d98359138477fe89618913a06dcceb35880de288dca9568dd8e54e4972f2c6`

## Installed file (hand-edited, as captured on 2026-09-04)

- Path: `/opt/homebrew/lib/node_modules/paperclipai/node_modules/@paperclipai/server/dist/services/recovery/service.js`
- `ls -l` mtime: Sep  3 01:15
- sha256(installed file): `158f7ac3d0daee10c6bed70b8986515e65b615846f3eda9cde0b4cffd85fe78c`
- Never to be edited directly; the edited `service.js` dies on the next npm install.

## Diff evidence

- `pristine-vs-installed.diff`: 927-line unified diff of the compiled file, curated on 2026-09-04 from
  the scratch tarball vs the live install. Same by `diff -u pristine installed`.

## What the diff contains (hand-edit intents, not just lines)

Two functional changes sit inside the 854-line reindent churn:

1. **Cycle guard in `resolveContinuationWaitingOnReview`** (~10 lines): when a parent is being parked on
   its open children (continuation-waiting-on-review), children that already have a `blocks` edge
   *into* that parent must be excluded from `blockedBy`, otherwise the parent<->child cycle makes the
   recovery pass abort fleet-wide (SPA-5458 cycle-abort template).

2. **Per-issue try/catch isolation in `reconcileStrandedAssignedIssues`** (wrap every candidate body;
   catch → log `"per-issue failure; skipping and continuing"` + `skipped++`; plus a similar wrapper
   around `reconcileUnassignedBlockingIssues` with empty-fallback).

## Disclosed deviation: installed column slip (no-op as installed — FIXED here)

The installed cycle guard collected `relatedIssueId` (the *parent* id) into `excludeIds` and then
filtered children by `c.id`, so the filter never matched — the guard was a no-op (excluded nothing).

The fork fixes this by collecting `issueId` (the *child* id) and delegating the filter to
`partitionChildrenSafeForBlocking` (which is why this helper has the slip-regression test). So the
fork build's behaviour for the cycle case is intentionally **different** from the still-live install:
wherever the installed guard silently allowed the cycle, the fork guard correctly blocks it.

## How the fork reconstructs it

- `server/src/services/recovery/service.ts` — guard extracted via `partitionChildrenSafeForBlocking`
  (from `continuation-wait-cycle-guard.ts`), isolate body wrapped in the loop as `try/catch`.
- `server/dist/services/recovery/service.js` — guard's compiled line count is essentially the same;
  runtime shape matches the installed file up to naming of the one alias.

Do not edit the installed file. Every engine change lands as a fork commit and is installed by the
parallel-install script (card 4).
