# Commit-time enforcement contract for the pure-install close (done-transition PATCH)

Card SPA-19094, deliverable d1. Tree: SPA-19092 (worktree `engine-fork/SPA-19092`). Repo: Spark-Mojo/paperclip. Base SHA: be5a4e66d812ef5bec6fd6d152aa80f82b08fab1 (= origin/rebuild/v2026.1012.0). Live board runs 35f781ca4ec94bfc196ed32601d5e58e56d3e0e8.

Level statement: this contract is SPEC'D by this leaf; the document artifact itself is BUILT by this leaf. No code, no engine change, no bridge change lands here. The concrete schema in section 2 is the object the review stage checks against PRECHECK S1-S6; a departure stops this leaf and escalates.

## 1. MECHANISM

The chosen mechanism is compare-and-set on the caller-declared state, enforced inside the existing db.transaction. A rule-based done-transition guard reduces to compare-and-set once the declared-state input exists, so compare-and-set is the only mechanism left to choose and the one chosen.

The done path at base, in full:

- The done status update runs in db.transaction (server/src/services/issues.ts about 13713-13722; actual at be5a4e66d812ef5bec6fd6d152aa80f82b08fab1: about 11328-11330). Hunk identified by content (the done-transition runUpdate executed via `db.transaction`: `const result = await (dbOrTx === db ? db.transaction(runUpdate) : runUpdate(dbOrTx))`), re-verified live at implementation time (section 5).
- A plain `{status, comment}` body writes the comment AFTER that commit (issues.ts about 14337-14358; actual at be5a4e66d812ef5bec6fd6d152aa80f82b08fab1: the post-commit `comment ??= await svc.addComment(...)` in server/src/routes/issues.ts about 14780-14788). At base, status and comment therefore land in two separate transactions: a comment failure after a status commit leaves the card done with no receipt. This is exactly the S4 window.
- The comment is inside the transaction only when attachmentIds or assigneeAdapterOverrides is present (issues.ts about 13730; actual at be5a4e66d812ef5bec6fd6d152aa80f82b08fab1: the `shouldUseTransactionalIssueUpdate` branch keyed on attachmentIds || assigneeAdapterOverrides in server/src/routes/issues.ts about 14151-14174, the `db.transaction` opening at about 14166); in that shape a failed comment already rolls the issue update back.
- Unresolved-blocker validation exists on the in_progress transition (issues.ts about 10799; actual at be5a4e66d812ef5bec6fd6d152aa80f82b08fab1: the `patch.status === "in_progress"` branch about 10800-10826) and on checkout (about 11483; actual at be5a4e66d812ef5bec6fd6d152aa80f82b08fab1: the checkout blocker validation about 11482-11491, the `checkout` service fn from about 11431) but NOT on done. The done transition at base accepts any declared status without consulting the live blocker state.
- The parent-finalize 409 (server/src/routes/issues.ts about 13056-13068) fires only when resumeRequested && blocked && unresolved first-class blockers; it does not constrain a plain done write. Actual at be5a4e66d812ef5bec6fd6d152aa80f82b08fab1: the 409 sits in `router.patch("/issues/:id")` (opened at about 13247) at about 13505-13513 (`.status(409)` at about 13511); the PRECHECK range 13056-13068 is the retryScheduledRetryNow route in this tree.
- Engine idempotency is only commentClientRequestId (user actors only; actual at be5a4e66d812ef5bec6fd6d152aa80f82b08fab1: server/src/routes/issues.ts about 14189 and 14799, `actor.actorType === "user" ? commentClientRequestId : undefined`); agent/bridge actors have no write idempotency at base.

Line-number disclosure: every PRECHECK-recorded "about" number quoted above (issues.ts about 13713-13722, about 13730, about 14337-14358, about 10799, about 11483; routes/issues.ts about 13056-13068) and the section 2 validator range come from the PRECHECK record's snapshot of the tree, not from this worktree. The services/issues.ts numbers (13713-13722, 13730, 14337-14358) exceed this tree's file length at BOTH pinned SHAs (13472 lines at 35f781ca4ec94bfc196ed32601d5e58e56d3e0e8, 13473 lines at be5a4e66d812ef5bec6fd6d152aa80f82b08fab1), and 13056-13068 lands on the retryScheduledRetryNow route rather than the parent-finalize 409. Those numbers are carried verbatim because the card requires it; grounding is by content, not by them: EVERY hunk is grounded by the quoted content in this worktree at be5a4e66d812ef5bec6fd6d152aa80f82b08fab1, with the actual verified line numbers given beside each bullet above.

Where the declared state is checked: inside the existing db.transaction, before the status UPDATE. The re-read is not a pre-transaction read; the intended placement is a row lock on the card row (SELECT ... FOR UPDATE, or the repo's transaction-helper equivalent) extended to the first-class blocker rows, so the check and the write are one atomic unit in the same transaction. Sema's checkpoint owns verifying this placement.

Refused-write path, proving zero partial state ("zero writes" = nothing written yet when the refusal fires: no status change, no completedAt, no comment, no receipt):

1. BEGIN.
2. SELECT ... FOR UPDATE on the card row and the first-class blocker rows.
3. Compare the live state against expectedState.
4. On mismatch: throw before any write; the transaction rolls back; nothing was written.
5. On match: UPDATE status done + completedAt + the single receipt comment in the same transaction, then COMMIT.
6. A comment-write failure inside the matched path throws and rolls the status back; the caller gets a non-2xx response with the card untouched.

Match predicate (one code path for all refusal shapes): the live status is not already done AND the live blocker set (ids + each blocker's own status) exactly equals the declared set. Repeat-close, added-blocker, removed-blocker, and changed-status are all detected by this single comparison, and every arm has a named fixture in section 3 (S1a added, S1c removed, S1b changed-status, S4c repeat-close); refusal reasons are `alreadyClosed` (target already done) and `blockerMismatch` (any declared-vs-live difference), defined in section 2.

Branch rule: the comment-write branch point is expectedState presence, never status value alone. Existing `{status:'done', comment}` callers keep the base post-commit ordering byte-identically (S3). When the input is present, the in-transaction write is the sole comment write and the post-commit path is skipped, so there is no double receipt (S4).

P2 note: for input-carrying writes, a P2 rejection (reused commentClientRequestId + different content) now rolls the status back instead of committing status first and 409ing after. This is an intentional change for input-carrying writes ONLY; S3 protects non-input callers only, whose base "409 with status already committed" behavior stays byte-identical.

Justification against PRECHECK:

- S1 (any declared-vs-live difference refuses the write in the same transaction, zero partial state): satisfied because the compare happens after the FOR UPDATE lock and before the status UPDATE, in the same transaction as the write; a mismatch throws with zero writes.
- S2 (exact declared==live commits even with an open blocker present-and-declared; no refuse-done-while-any-blocker-open rule): satisfied because the predicate is set equality, not openness; an open blocker that is declared and present with matching status commits.
- S3 (input optional, every existing caller and transition byte-identical): satisfied by the additive optional field and the presence-keyed branch; non-input callers never reach the new comparison.
- S4 (one transaction for status done + completedAt + exactly one receipt comment; comment failure rolls the status back; refuse when already done): satisfied by the matched-path sequence above and by the already-done arm of the predicate; a repeat close commits no second receipt and does not re-stamp completedAt.

Three forbidden shapes, named so review and Sema's checkpoint can grep for them:

1. A pre-transaction check-read of live state (TOCTOU forbidden shape): the read must be inside the existing db.transaction under the row lock, never before BEGIN.
2. A branch keyed on status value instead of expectedState presence: that would re-route existing `{status:'done'}` callers and break S3.
3. A double comment write: the post-commit comment path must be skipped whenever the input is present; the in-transaction write is the sole comment write.

## 2. CONCRETE SCHEMA

`expectedState` is an optional request field on the done-transition PATCH: an object carrying the declared state - the target status plus first-class blocker ids each paired with that blocker's own status. It is additive into updateIssueSchema (packages/shared/src/validators/issue.ts about 874-898), absent by default, and every existing caller omits it. The reference range matches this tree at be5a4e66d812ef5bec6fd6d152aa80f82b08fab1: the updateIssueSchema statement spans actual lines 874-898, with `.partial()` on line 881 applied BEFORE `.extend()` on line 882. Because `.partial()` runs before `.extend()`, extended keys are not optionalized, so expectedState must carry its own explicit `.optional()` to stay an optional request field (S3) - omitting it would make the field REQUIRED and every existing no-input caller would 400.

```ts
expectedState: z
  .object({
    status: z.literal('done'),
    blockers: z.array(
      z.object({
        issueId: z.string(),
        status: z.string(),
      }),
    ),
  })
  .optional(),
```

Semantics:

- `expectedState.status` is `z.literal('done')`: the field only marks close writes (section 4).
- `expectedState.blockers[]` is the declared first-class blocker set: each entry is the blocker issue `issueId` paired with that blocker's own status. Declaration is exact: the live set must equal this set element-for-element, ids and statuses (S1, S2).

Refusal shape: a refused write returns HTTP 409 with an additive machine-readable error body that names which precondition failed - reason `alreadyClosed` when the target is already done, or `blockerMismatch` when any declared-vs-live difference exists. Existing status codes and existing error bodies are byte-untouched; existing callers never send the field, so they never see the new body.

Write path: when expectedState is present, ONE transaction carries status done, completedAt and the single receipt comment; a comment-write failure (the P2 shape) rolls the status back and returns non-2xx. Absent expectedState, the base path is used unchanged (section 1 branch rule).

## 3. ORACLE TEST PLAN

All oracles live in one new file: server/src/__tests__/issues-done-transition-enforcement.test.ts. Single-file choice: every oracle exercises the same done-transition code path (the PATCH that carries or omits expectedState); there is no isolation benefit from a split, and one file keeps the red/green run trivial.

Fixtures and assertions:

Fixture: S1a - the actor reads the card, a concurrent writer adds a blocker (adds a blocker between the actor's read and the write), the actor then PATCHes done with the stale declared set. Expect non-2xx refusal with 409 reason `blockerMismatch`, and unchanged readback of status, completedAt, comment count, and blockedBy.

Fixture: S1b - same shape, but the concurrent writer changes only the status of an existing blocker (id set identical, one blocker's own status differs). Expect non-2xx 409 `blockerMismatch` and the same four unchanged readbacks.

Fixture: S1c - the removed arm: a blocker is present in the declared set but absent from the live set (the concurrent writer removes a blocker between the actor's read and the write). Expect non-2xx 409 reason `blockerMismatch`, and unchanged readback of status, completedAt, comment count, and blockedBy.

S1 is these three cases - S1a added, S1c removed, S1b changed-status - and the fourth arm of the same single predicate, repeat-close, is S4c below; no other oracle is needed because the match predicate is one comparison.

Fixture: S2 - the card's open vehicle edge (the blocker that marks the pure-install close) is declared and present with matching status. Expect the close to commit, with blockedBy byte-identical before and after: an open-but-declared blocker does not refuse done.

Fixture: S3 - a no-input fixture byte-identical to base: a plain `{status:'done', comment}` write behaves exactly as at base, including the P2 shape (reused commentClientRequestId + different content + status done) still returning 409 with status already committed. Additionally, the existing server test suites pass unchanged at the new head.

Fixture: S4b - a close carrying expectedState with a forced comment-write rejection. Expect non-2xx and status, completedAt, and comment count all unchanged (the comment failure rolls the status back). This oracle is red on 35f781ca - at base it reproduces the proof's I2/I6 and the S4 window, status committing with no receipt - and green after the change.

Fixture: S4c - a successful close, then an identical repeat close. Expect the repeat refused non-2xx (`alreadyClosed`) with no second receipt and completedAt does not re-stamp (the original stamp survives byte-identically).

Red/green discipline: run the suite at base 35f781ca (red: the S4b oracle and the S1/S4c refusal semantics do not exist at base) and at the implementation head (green: all fixtures pass), mirroring Sema's oracle definitions. The S3 fixture is expected green at both SHAs and guards against regression of the base behavior.

## 4. SEAM STATEMENT

Carrying expectedState in the PATCH body is what marks a write as the pure-install close path, and that path is the only close write sanctioned for pure-install PR cards; merged_close_with_comment and live stay as base.

Consumer: the generalized pure-install close path scripts/ci/card-bridge.sh (sibling tree SPA-19093), with its receipt fixture per scope document SPA-18883 comment dc6cddca sections 2-3. Bridge invariants: single attempt, no retry; the bridge obeys the engine's answer and reconciles only by fresh GET; it never edits blockedBy (S5). S6 note: no new credential, no new route - the existing bridge identity through the existing PATCH route.

## 5. BRANCH BASE, LIVE DELTA

Branch tip: be5a4e66d812ef5bec6fd6d152aa80f82b08fab1 (= origin/rebuild/v2026.1012.0, re-read live 2026-11-11 in the SPA-19092 worktree). The live board runs 35f781ca4ec94bfc196ed32601d5e58e56d3e0e8 (GET /api/health re-checked 2026-11-11), which IS an ancestor of the tip (verified with `git merge-base --is-ancestor`).

The live delta (35f781ca..be5a4e66d) is: cdb8373f2 (pnpm-lock refresh for e34abee67 server deps), 33f5c182c and f34793480 (SPA-16691 R1+R2 fail-closed evidence gates on the recovery-resolve route), 0cea9b2f8 (SPA-16692 R3 regression tests pinning those gates), and merge be5a4e66d (PR #232). None of the delta touches the done path, the grounded hunks, or the validator range. The delta edits exactly four things: server/src/services/issues.ts (+1 line - the `issue.recovery_evidence_refused` participation-activity string, now at line 2807), the recovery-resolve route (server/src/routes/issues.ts), its tests (issue-agent-mutation-ownership-routes.test.ts, issue-recovery-actions.test.ts, r3-base-red.sh), and the lock file (pnpm-lock.yaml). Line 2807 is far from every cited hunk, so all grounded areas are untouched; the "about" line references in sections 1 and 2 are re-verified live at implementation time (see the line-number disclosure in section 1).

## 6. DELIVERY TREE ASSIGNMENTS AND CLOSE VEHICLES

R1: the tree names the mechanism chosen here (compare-and-set on the caller-declared state), the script path scripts/ci/card-bridge.sh, and the test artifact (the new regression suite file server/src/__tests__/issues-done-transition-enforcement.test.ts from section 3).

R2: builder Patti per the standing LaQuesha/Patti pattern; Dex retained operational owner of the bridge close path (ab4f40c5, SPA-18221 R4: "Dex remains operational owner"); verification gates Argus/Vex.

R3: the already-merged tuples close via named validate-and-close runs with done+receipt read-back - SPA-18497 (PR #2755, merge 99f55ec5) and SPA-17662 (PR #2593, merge 1075289e) - each gated on the capability being LIVE (the attended activation window card is the go/no-go). Future pure-install merges close via the bridge receipt once the generalized path is live.

R4: the successor intake exists (SPA-19060; SPA-18888's closing comment lists it, so the trigger is explicit): when the successor intake exists, Steve files the SPA-18221 R9 dependency-transfer routing ruling, transferring SPA-18211's SPA-17662 edge to the named successor, verified readback.

R5: no implementation is executed under this intake - only decomposition/design artifacts; no bridge, workflow, engine or credential change; no evidence replay; this leaf lands only this document.
