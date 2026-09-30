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
Result: exit 0; EXPECT matched. Both resolvers already return `adapter_managed` when the mode is
`agent_default`; neither can yield `project_primary` for that mode.

    NEGATIVE: timeout 30 git grep -n 'mode === "agent_default" ? "project_primary"' -- server/src/services/execution-workspace-policy.ts
    EXPECT: zero hits; exit 1 (the inverted default the friction asks for does not exist anywhere)
Result: exit 1, empty output; EXPECT matched. Confirmed the same at the pre-fix build
`5e4ef13673e6` (line 74), so this clause was never the defect.

## G2 The claimed "cwd does not exist on disk" is false — the engine materialises it
    CHECK: timeout 30 git grep -n 'await fs.mkdir(cwd, { recursive: true })' -- server/src/services/heartbeat.ts
    EXPECT: a hit on the agent-home fallback branch (12800), immediately before the `No project workspace directory is currently available` warning it is reported alongside
Result: exit 0, two hits (2569, 12800); EXPECT matched. heartbeat.ts:12800 mkdirs
`resolveDefaultAgentWorkspaceDir(agent.id)` on the same branch that emits the warning at :12812;
:12734 does the same for the project-workspace fallback. Present in the pre-fix build too
(lines 12403 / 12337).

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

## G8 Negative control for the probe itself (guards against a vacuous pass)
    CHECK: timeout 120 node .unlazy/SPA-9283/probe-live-engine.mjs --negative-only
    EXPECT: exit 1 and a GATE FAIL line, proving the harness can and does fail
Result: exit 1; EXPECT matched. Observed:

    GATE FAIL positive_agent_default: expected REFUSE got ALLOW
    GATE FAIL

    The assertion inverts only the positive expectation, so the harness's own verdict is shown to be
    derived from observation rather than hardcoded — a green run is not vacuous.

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

This is a **no-code-change** card. The card's proposed fix (G1) and its factual premise (G2) were
both already satisfied at HEAD; the reported failure was served by a build predating SPA-9139 (G4).
Writing a resolver change would have been a fix to working code. The git tree is therefore clean
and the deliverable is this ledger plus the issue disposition.
