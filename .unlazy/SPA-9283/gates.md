# SPA-9283 gates

Scope: the friction card asked for a resolver change — `mode = "agent_default"` should override
`strategyType`, not only the `mode` field — plus a claim that the agent-home fallback cwd "does not
exist on disk". This ledger records evidence that both are already satisfied at HEAD by SPA-9139,
and that the observed failure was served by a stale engine build. **No code change is made on this
card**; the deliverable is the evidence that the fix landed plus the independently-discovered
residual defect filed as its own issue.

## G1 The proposed fix — `agent_default` overrides the strategy default — already exists at HEAD
    CHECK: timeout 30 git grep -n 'mode === "agent_default" ? "adapter_managed"' -- server/src/services/execution-workspace-policy.ts
    EXPECT: two hits, one in resolveEffectiveWorkspaceStrategyType (line 80) and one in resolvePinnedIssueWorkspaceStrategyType (line 98)
Result: exit 0, two hits; EXPECT matched. Both resolvers return `adapter_managed` when the mode is
`agent_default` and no explicit type is set; neither can yield `project_primary` for that mode.

    NEGATIVE: timeout 30 git grep -n 'agent_default" ? "project_primary"' -- server/src/services/execution-workspace-policy.ts
    EXPECT: zero hits; exit 1 (the inverted default the friction asks for does not exist anywhere)
Result: exit 1, empty output; EXPECT matched. Confirmed the same at the pre-fix build
`5e4ef13673e6` (line 74), so this clause was never the defect.

## G1b An explicit `workspaceStrategy.type` cannot reach those resolvers under `agent_default`
    CHECK: timeout 120 node .unlazy/SPA-9283/probe-strategy-precedence.mjs
    EXPECT: the resolvers *do* return project_primary when handed an explicit type, BUT
             buildExecutionWorkspaceAdapterConfig strips workspaceStrategy for mode=agent_default, so
             the config the resolvers actually receive yields adapter_managed
Result: exit 0; EXPECT matched. Observed against the live dist:

    -- resolver called directly with explicit project_primary --
    resolveEffectiveWorkspaceStrategyType: project_primary
    resolvePinnedIssueWorkspaceStrategyType: project_primary
    -- does buildExecutionWorkspaceAdapterConfig strip it? --
    adapterConfig.workspaceStrategy = undefined
    has workspaceStrategy key: false
    agentDefault wins -> adapter_managed
    unrelated keys preserved: true | workspaceRuntime stripped: true

    This addresses a reviewer challenge that the resolvers' short-circuit (`if type is one of the four
    known types, return type`) sits *ahead* of the `agent_default` default — true in isolation, but
    unreachable on the dispatch path. `heartbeat.ts:21511` calls
    `buildExecutionWorkspaceAdapterConfig`, which at :448 `delete`s `workspaceStrategy` for every mode
    except `isolated_workspace`; the resolvers are then handed that stripped config. So the mode wins
    the effective strategy, which is what the card asked for.

## G2 The claimed "cwd does not exist on disk" is false — the engine materialises it
    CHECK: timeout 30 git grep -n 'await fs.mkdir(cwd, { recursive: true })' -- server/src/services/heartbeat.ts
    EXPECT: a hit on the agent-home fallback branch (12800), immediately before the `No project workspace directory is currently available` warning it is reported alongside
Result: exit 0, two hits (2569, 12800); EXPECT matched. heartbeat.ts:12800 mkdirs
`resolveDefaultAgentWorkspaceDir(agent.id)` on the same branch that emits the warning at :12812;
:12734 does the same for the project-workspace fallback. Present in the pre-fix build too
(lines 12403 / 12337).

    Cross-checked against the PR head as GitHub serves it, NOT the local checkout, because a
    reviewer reported these lines absent. Three independent routes agree on the size, and the
    discrepancy against the reviewer's figure has a mechanical cause:

        gh api -H "Accept: application/vnd.github.raw" \
            "repos/Spark-Mojo/paperclip/contents/server/src/services/heartbeat.ts?ref=<HEAD>" | wc -l
            -> 30315
        git cat-file blob <HEAD>:server/src/services/heartbeat.ts | wc -l
            -> 30315
        /home/jamesilsley/.config/opencode-fleet-xdg/fleet/pr-read.sh show <HEAD> \
            server/src/services/heartbeat.ts --repo Spark-Mojo/paperclip | wc -l
            -> 10676

    The head file is 30315 lines. The 10676 figure is the allowlisted reviewer's
    `pr-read.sh show` wrapper, which pipes its output through `cap` — `MAX_OUT=400000`,
    `head -c` — at pr-read.sh:46-48 and again on the `show` branch at :344. The file is
    1 162 041 bytes, so the read stops 34% of the way in, mid-statement. That is why the wrapper
    reports "blob not found" on stderr *and* streams a partial file: `set -o pipefail` sees
    `head -c` exit 0, and the truncation is silent. Measured boundary: wrapper output is exactly
    400000 bytes, and it does not contain the agent-home mkdir (the second hit, line 12800) that
    G2's CHECK greps for — only the unrelated hit at 2569, inside the surviving prefix.

    The wrapper's own header comment at pr-read.sh:40 claims `pr-read.sh show <base_sha> <path>`
    has "no GitHub cap"; that is true of the GitHub API but false of the wrapper, which applies
    its own. The 400000-byte cap is a documented design choice for the synthesized diff, not a bug
    in that path — but reusing it on a per-file read primitive is a defect, because a single file
    over 400 KB cannot be reviewed through the one interface reviewers are told to trust, and the
    failure is silent. Filed as `sparkmojo-internal#1014` rather than fixed here: this is a fleet
    harness owned outside this repo, and a card whose scope is a workspace defect is not the place
    to change the review primitive every verifier depends on.

## G3 The failing run's refusal is reproducible, and its cause is a guard the fix removes
    CHECK: timeout 30 git grep -n 'agentDefaultBypassRequested' -- server/src/services/heartbeat.ts
    EXPECT: a definition (3254) and two uses on the guards it suppresses (3376, 3403)
Result: exit 0, three hits; EXPECT matched. The bypass suppresses `fallback_agent_home_cwd`
(:3373-3383, the guard that produced the observed message) **and** `missing_git_metadata`
(:3400-3410) — two guards, not one. Neither fires when the mode is `agent_default`.

## G4 The engine build that served the failing run predates SPA-9139
    CHECK: timeout 30 git grep -c agentDefaultBypassRequested refs/remotes/origin/rebuild/v2026.916.0-survivors~1 -- server/src/services/heartbeat.ts
    EXPECT: 0 hits in build 5e4ef13673e6
Result: `git show 5e4ef13673e6:server/src/services/heartbeat.ts | grep -c agentDefaultBypassRequested`
exits 0 with output `0`. Per `~/.paperclip/cli/install.json.bak-pre-9f971504`, that SHA was the live
engine from 2026-09-25T16:49:38Z; the failing run is 2026-09-29T00:10:14Z, inside that window.
SPA-9139 merged as 6adedbf27 on 2026-09-28T02:23:37Z — after the live build was taken.

    NEGATIVE: the same grep against every install dir currently on the box returns 3 hits each
    EXPECT: 0 hits — proving the grep discriminates and that no current build lacks the fix
Result: exit 0, five of five installs report 3 (`installs/git/{1751e28631af,694d0fbe002a,24597d524fe5,a4bc04c4284b,6f74b2f05c99}`).
Independently, `git merge-base --is-ancestor 6adedbf27 <sha>` returns 0 for all five.

## G5 Live engine end-to-end: `agent_default` is allowed, every other mode is still refused
    CHECK: timeout 120 node .unlazy/SPA-9283/probe-live-engine.mjs
    EXPECT: ALLOW for mode=agent_default; REFUSE for isolated_workspace, operator_branch, shared_workspace; `GATE PASS`, exit 0
Result: exit 0; EXPECT matched. The probe imports the **live engine's own built dist**
(`~/.paperclip/cli/current/node_modules/@paperclipai/server/dist`, sha 6f74b2f05c99, the build serving
runs today) and replays the exact inputs of failed run a3173c97. Observed output:

    ALLOW  agent_default from agent-home cwd  (mode=agent_default)
    REFUSE isolated_workspace from agent-home cwd  code=workspace_validation_failed reason=fallback_agent_home_cwd
    REFUSE operator_branch from agent-home cwd    code=workspace_validation_failed reason=fallback_agent_home_cwd
    REFUSE shared_workspace from agent-home cwd    code=workspace_validation_failed reason=fallback_agent_home_cwd
    GATE PASS: agent_default ALLOWs, every non-agent_default mode still REFUSEs
    exit 0

    The three REFUSE messages are the failing run's message verbatim ("Issue SPA-9283 expected a
    project workspace, but opencode_local would launch from agent fallback cwd ...") and the guard
    now names its reason, `fallback_agent_home_cwd`. That is what makes the positive a real control:
    same harness, same inputs, one variable — the mode.

    Caveat on the printed path: `resolveDefaultAgentWorkspaceDir` derives the fallback from ambient
    instance context, so the probe's cwd string resolves to
    `/home/jamesilsley/.paperclip-worktrees/instances/spa-9283-…` rather than the
    `/home/jamesilsley/.paperclip/instances/default/workspaces/<agent-id>` recorded in the 00:10Z run.
    The comparison that matters — ALLOW vs REFUSE on one variable — is unaffected, and the board
    state evidence for the literal path is G7.

## G6 Regression suite for the surface stays green
    CHECK: timeout 900 npx vitest run server/src/__tests__/heartbeat-workspace-session.test.ts server/src/__tests__/execution-workspace-policy.test.ts
    EXPECT: both files pass; heartbeat-workspace-session 166 passed, execution-workspace-policy 33 passed
Result: exit 0. Run separately and observed identically: `heartbeat-workspace-session.test.ts`
166/166 (34.24s), `execution-workspace-policy.test.ts` 33/33 (4.83s). Includes the SPA-9139
allow-tests and the `isolated_workspace` negative control that proves the guard still has a job.

## G7 Independent live differential on this very card (no probe harness)
    CHECK: timeout 30 curl -sS -H "Authorization: Bearer $PAPERCLIP_API_KEY" "$PAPERCLIP_API_URL/api/issues/$PAPERCLIP_TASK_ID/runs?limit=25"
    EXPECT: run 67962656 (2026-09-29T20:29Z) succeeded with errorCode null, dispatched in mode agent_default from the agent-home cwd
Result: exit 0; EXPECT matched. The two agent_default leases on this issue persisted
`mode=adapter_managed, strategyType=project_primary, providerType=local_fs,
cwd=/home/jamesilsley/.paperclip/instances/default/workspaces/5f006ee1-…` — and the 20:29Z run on
that exact shape **succeeded** while the 00:10Z run on the identical shape failed. The only
difference is the engine build. This is the live end-to-end proof the advisor required; G5 proves
the same thing at the guard boundary with a negative control.

    NEGATIVE: the same endpoint, asked for a run that failed, must still resolve — the gate reads
    the 00:10Z failure as its own control, so it cannot pass by the endpoint merely answering
    EXPECT: the 00:10Z run a3173c97 is present with status=failed, errorCode=workspace_validation_failed
Result: exit 0; EXPECT matched. Both runs are returned by the same call, so the contrast (succeeded
on the same workspace shape at 20:29Z, failed on it at 00:10Z) is read from one response rather than
asserted across two. This distinguishes "the live engine allows agent_default" from "the endpoint
answered".

## G8 Negative control for the probe itself (guards against a vacuous pass)
    CHECK: timeout 120 node .unlazy/SPA-9283/probe-live-engine.mjs --negative-only
    EXPECT: exit 1 and a GATE FAIL line, proving the harness can and does fail
Result: exit 1; EXPECT matched. Observed:

    GATE FAIL positive_agent_default: expected REFUSE got ALLOW
    GATE FAIL

    The assertion inverts only the positive expectation, so the harness's own verdict is shown to be
    derived from observation rather than hardcoded — a green run is not vacuous.

## G9 The card's non-code deliverable: friction issue #857 closed with a matching reason
    CHECK: timeout 60 gh issue view 857 -R Spark-Mojo/sparkmojo-internal --json number,state,stateReason,closedAt --jq '"state=\(.state) reason=\(.stateReason) closedAt=\(.closedAt)"'
    EXPECT: state=CLOSED with a reason from the card's own list {completed, not planned, deferred} that MATCHES the outcome — and since no resolver landed (G1/G4), the only member that matches is `not planned`
Result: exit 0; EXPECT matched. Observed:

    state=CLOSED reason=NOT_PLANNED closedAt=2026-09-30T21:59:14Z

    GitHub's wire value is `not_planned`; the card's prose is "not planned". These are the same
    member of the card's triple.

    Why not `completed`: `completed` asserts the stated work shipped, and the card conditions the
    closure on "when the resolver lands". No resolver landed — G1 and G1b show the fix was already
    present and G4 shows the failure was a stale engine build. Recording `completed` would import a
    claim this ledger refutes three times, and a future triager reading only the state reason would
    infer a code fix shipped on this card. An earlier pass closed it as `completed` on the grounds
    that the underlying problem is fixed; that conflated "the problem is gone" with "the proposed
    work shipped", and independent review caught it. The closing comment states the distinction
    explicitly: https://github.com/Spark-Mojo/sparkmojo-internal/issues/857#issuecomment-5920454919

    NEGATIVE: the same query against the sibling residual issue proves the query discriminates a
    closed issue from an open one
    EXPECT: state=OPEN — so G9's green is not a constant
Result: exit 0, #1013 reads `state=OPEN reason=`. EXPECT matched.

## G10 The reviewer's unresolvable discrepancy is a wrapper defect, not a wrong claim
    CHECK: timeout 60 bash -c 'H=51a5724fcab4cc150bc7c3918e16493f1cadb4fe; F=server/src/services/heartbeat.ts; a=$(gh api -H "Accept: application/vnd.github.raw" "repos/Spark-Mojo/paperclip/contents/$F?ref=$H" 2>/dev/null | wc -l); b=$(/home/jamesilsley/.config/opencode-fleet-xdg/fleet/pr-read.sh show $H $F --repo Spark-Mojo/paperclip 2>/dev/null | wc -l); c=$(/home/jamesilsley/.config/opencode-fleet-xdg/fleet/pr-read.sh show $H $F --repo Spark-Mojo/paperclip 2>/dev/null | wc -c); echo "api=$a wrapper_lines=$b wrapper_bytes=$c"'
    EXPECT: api=30315; wrapper_bytes exactly 400000 (the MAX_OUT cap) and wrapper_lines < api
Result: exit 0; EXPECT matched. Observed: `api=30315 wrapper_lines=10676 wrapper_bytes=400000`.
The wrapper's byte count is the round number 400000, which is `MAX_OUT` at pr-read.sh:46 — a cap,
not the file's real length (1 162 041 bytes per the contents API). The truncation is the whole
explanation, and it is why the reviewer's surface could not see line 12800.

    NEGATIVE: run the same wrapper read on a file UNDER the cap and confirm the two agree
    EXPECT: no byte-gap — proving the cap, not the file, explains the difference
    Result: exit 0; EXPECT matched. `server/src/services/execution-workspace-policy.ts` (20 564
    bytes, far under 400000) reads identically through the wrapper and via the API — 461 lines each,
    20 564 bytes each — and its line 80/98 greps match. The defect therefore reproduces on size,
    not on this file or this path.

## Residual defect found (not on this card's scope — filed separately)

The advisor flagged, correctly, that green tests do not prove the verifier dispatch works when the
issue's `projectWorkspaceId` was auto-derived from the project row. Probing that case against the
live dist finds two guards that `agent_default` does **not** bypass:

    REFUSE issue.projectWorkspaceId set, no persisted ws
           reason=missing_persisted_execution_workspace
    REFUSE resolvedWorkspace.workspaceId set, no persisted ws
           reason=missing_persisted_execution_workspace
    ALLOW  agent_default, persisted ws present, projectWorkspaceId null

`workspaceExpectation` (heartbeat.ts:3269) is true whenever `issue.projectWorkspaceId` is set, so an
`agent_default` card whose project workspace was auto-derived demands a persisted execution
workspace and fails `missing_persisted_execution_workspace` before the SPA-9139 bypass is ever
reached. A fourth probe closes it: with a persisted workspace present but no `projectWorkspaceId`,
`agent_default` is ALLOWed; add a non-null `issue.projectWorkspaceId` and it REFUSes with
`persisted_workspace_missing_project_workspace_id`. This is a distinct guard from the one this card
reported, survives the fix, and is not covered by the SPA-9139 tests (both allow-tests at
`heartbeat-workspace-session.test.ts:367-407` run *with* a persisted workspace — the one shape where
the earlier guards pass). Filed as `sparkmojo-internal#1013` rather than folded in here, because
this card's scope is the reported defect and its DoD is already met.

## Scope note

This is a **no-code-change** card. The card's proposed fix (G1, G1b) and its factual premise (G2)
were both already satisfied at HEAD; the reported failure was served by a build predating SPA-9139
(G4). Writing a resolver change would have been a fix to working code. The engine diff is therefore
empty and the deliverables are this ledger, the two probes, the closure of #857 with a reason (G9),
and the filing of the residual defect as #1013.

## Review history on this PR

Four independent verifications ran against this card, each at a fresh head. Every one returned
non-PASS, and each caught something the others did not — which is the point of independent
re-judgement, and the reason this card is not marked done on the strength of one green run:

1. **FAIL** — R1: the resolvers short-circuit on an explicit `workspaceStrategy.type` before the
   `agent_default` default. Answered by G1b; formally **withdrawn** by the second verifier as
   unreachable on the dispatch path.
2. **FAIL** — R2: `heartbeat.ts` mkdir and warning absent at head. Refuted from the authoritative
   blob; the second verifier judged it not material, the third could not resolve it at all.
3. **FAIL** — R3: the card's #857 closure clause, undischarged. A real miss. Now G9, with
   `not_planned`; the third verifier's further point — that the reason code must match the outcome,
   not merely be present — is why the first pass's `completed` was corrected.
4. **BLOCKED** — the third verifier could not see `heartbeat.ts:12800` and could not reconcile the
   line count, because the allowlisted read primitive truncates at 400 KB and reports a partial
   file alongside a "blob not found" message. That was a tooling defect, not a wrong claim; see G10
   and `sparkmojo-internal#1014`. It is filed rather than fixed here, and it is the reason this
   ledger quotes the API and `git cat-file` routes alongside the wrapper rather than treating any
   one surface as sufficient.

The net effect: three card clauses were discharged (G1/G1b, G9, and the #857 closure), one tooling
defect was found and filed (#1014), and one real engine defect was found and filed (#1013) — none of
them by the first run.

## G11 Hand-merge path (SPA-9702) — all four clauses, recorded before the handoff

    CHECK: timeout 60 bash -c 'gh api repos/Spark-Mojo/paperclip --jq .allow_auto_merge; gh repo view Spark-Mojo/paperclip --json defaultBranchRef --jq .defaultBranchRef.name; gh api repos/Spark-Mojo/paperclip/pulls/137 --jq .mergeable'
    EXPECT: allow_auto_merge=false; default branch rebuild/v2026.916.0-survivors; mergeable=true (MERGEABLE, not unknown)
Result: exit 0; EXPECT matched. All three read live with the repo named explicitly, never inferred from a
checkout. `gh api repos/Spark-Mojo/paperclip/rulesets` returns 0, so no required-check rule is
load-bearing; `mergeStateStatus` is deliberately not used as a precondition (SPA-9702 explains why it
contradicts itself on a base-red fork).

    CLAUSE 1 — head/base pinned atomically by one call:
        pr-read.sh head 137 --repo Spark-Mojo/paperclip
        -> H(head)=a4cead23cef22dd239641a9e208167eb35fbc5c3
           B(base) =6f74b2f05c99354f3c22f893e326c23c23ef494f
           baseRefName=rebuild/v2026.916.0-survivors

    CLAUSE 2 — conflict state: mergeable=true. A red that reproduces on the base is exempt under
    blocker discipline; a head-only red refuses.

    CLAUSE 3 — failing-assertion non-touch. The reds are `ci / General tests (server (12/12))` and
    `ci / Verify serialized server suites (6/9)`, both vitest suites under `server/`. The whole diff
    is three new files under `.unlazy/SPA-9283/`:
        git diff --exit-code 6f74b2f05c..a4cead23c -- server packages scripts .github
        -> exit 0, empty output (no engine, package, script or CI file touched)
    Causal non-touch is therefore provable, not merely asserted: the diff cannot affect a vitest
    suite it does not touch.

    CLAUSE 4 — base has no CI run of its own (`gh api .../commits/6f74b2f05c/check-runs --jq
    .total_count` -> 0), so the ancestor stand-in clause applies. `8aa20505cc71298e305e4184a3aa3eff164ae4c8`
    is verified an ancestor of the base (`git merge-base --is-ancestor 8aa20505cc 6f74b2f05c` -> 0)
    and its run `36762282332` fails the SAME TWO checks by check name:
        failure  ci / General tests (server (12/12))
        failure  ci / Verify serialized server suites (6/9)
    Both names match the head reds exactly. The ancestor additionally reds 4 checks that are green or
    in flight on head (`ci / e2e`, `ci / verify`, `workspaces-b`, `server (11/12)`,
    `serialized (7/9)`), which is consistent with a partially-flaky fork CI and inconsistent with a
    red this docs-only diff caused.

    Disposition under SPA-9702: both head reds are `base_red_only`. The `review` check is the vendor
    `commitperclip` action and is never a blocker on this fork. Verified head SHA to hand to Dex:
    a4cead23cef22dd239641a9e208167eb35fbc5c3.
