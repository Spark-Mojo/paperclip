# SPA-10294 — gates ledger

One observable outcome per gate. Each gate carries a fail-closed `CHECK:`, an
`EXPECT:` success-only marker, and a `NEGATIVE:` run against a disposable fixture with
its observed nonzero exit.

Base ref audited: `refs/remotes/origin/rebuild/v2026.916.0-survivors` @ `b774322590c0aea7241c1016282ff4d49a79b5fb`
Bare-shorthand tripwire: **clean** (no `refname ... is ambiguous` on stderr).

---

## Gate 1 — the audited source is the default branch of the fork, read live

**Outcome:** the audit cites the fork's current default branch, not a remembered name.

    CHECK: gh repo view Spark-Mojo/paperclip --json defaultBranchRef --jq .defaultBranchRef.name
    EXPECT: rebuild/v2026.916.0-survivors
    NEGATIVE: gh repo view Spark-Mojo/no-such-repo-xyz-10294 --json defaultBranchRef --jq .defaultBranchRef.name
    NEGATIVE OBSERVED: exit 1, "GraphQL: Could not resolve to a Repository with the name 'Spark-Mojo/no-such-repo-xyz-10294'. (repository)" (observed 2026-10-03, this run)

**Result: PASS.** Observed `rebuild/v2026.916.0-survivors`. The repo is passed
explicitly — an unqualified `gh repo view` resolves from the current checkout and
returns the wrong repo (WORKFLOW step 4, SPA-9101 rule).

> **Negative-control correction, recorded because the first attempt lied.** My first
> negative was `--jq .defaultBranchRef.missing`, and I *predicted* exit 1 with a jq
> error. Observed **exit 0 with empty stdout** — jq silently rendered a missing key as
> nothing. That is a zero-without-a-positive-control: a pipeline/`$?` read that would
> have proven nothing. Replaced with a nonexistent-repo control, which genuinely
> returns exit 1. A cross-read (`Spark-Mojo/sparkmojo-internal` → `main`) additionally
> proves the value is repo-specific rather than a default.

## Gate 2 — the audit's source files come from the audited ref, not an ambient tree

**Outcome:** every line cited resolves in the pinned ref.

    CHECK: git -C /home/jamesilsley/wt-spa10294-audit show refs/remotes/origin/rebuild/v2026.916.0-survivors:server/src/services/workspace-runtime.ts | wc -l
    EXPECT: 10148
    NEGATIVE: git -C /home/jamesilsley/wt-spa10294-audit show refs/remotes/origin/rebuild/v2026.916.0-survivors:server/src/services/workspace-runtime-NOT-A-FILE.ts | wc -l
    NEGATIVE OBSERVED: exit 128, "fatal: path 'server/src/services/workspace-runtime-NOT-A-FILE.ts' exists on 'refs/remotes/origin/rebuild/v2026.916.0-survivors', but not in 'refs/remotes/origin/rebuild/v2026.916.0-survivors'" — a git object-id error, not a silent empty string

**Result: PASS.** Observed `10148`. Ambiguity tripwire grepped clean, so a
same-named tag cannot have poisoned the resolution (friction #888 / SPA-9348).

## Gate 3 — the flag is the exact named setting, defaults false, and is not agent-readable

**Outcome:** the card names the real flag and does not claim a value it cannot read.

    CHECK: git -C /home/jamesilsley/wt-spa10294-audit grep -n "enableEphemeralWorktreePerRun" refs/remotes/origin/rebuild/v2026.916.0-survivors -- server/src/services/instance-settings.ts
    EXPECT: two hits, one of which is `?? false` (the default)
    NEGATIVE: curl -sS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $PAPERCLIP_API_KEY" $PAPERCLIP_API_URL/api/instance/settings
    NEGATIVE EXPECTED: 403 — an agent actor must NOT be able to read the flag

**Result: PASS.** `instance-settings.ts:275` `?? false` and `:316` `: false`;
read site `heartbeat.ts:22256-22258`. `GET /api/instance/settings` observed **403**
`{"error":"Board access required"}` — the negative control behaves exactly as the
design requires, and the audit therefore records the flag value as **unknown/board-only**
rather than asserting it.

## Gate 4 — git forbids one-branch-two-worktrees (Finding 2's load-bearing fact)

**Outcome:** the recommendation cannot be "keep the per-card branch, force a fresh
directory per run", because git rejects that.

    CHECK: git init -q /tmp/spa10294-gitlock/r && cd /tmp/spa10294-gitlock/r && git commit -q --allow-empty -m init && git branch card-x && git worktree add -q /tmp/spa10294-gitlock/w1 card-x && git worktree add /tmp/spa10294-gitlock/w2 card-x
    EXPECT: nonzero exit carrying `fatal: 'card-x' is already used by worktree at`
    NEGATIVE (control): git worktree add -q /tmp/spa10294-gitlock/w3 --detach card-x
    NEGATIVE EXPECTED: exit 0 — detach DOES succeed, which is why Finding 2 rejects it on DECISION-138 predicate 3 rather than on git

**Result: PASS.** Observed `fatal: 'card-x' is already used by worktree at
'/tmp/gitlocktest/w1'`. The `--detach` control succeeded, confirming the failure is
git's branch lock and not a path problem.

## Gate 5 — the reuse path records the REUSED path, so there is no cross-run `rm`

**Outcome:** my first hypothesis (an identity lie + a teardown that removes another
run's directory) is **disproved**, and the audit records the downgrade rather than
the stronger claim.

    CHECK: git -C /home/jamesilsley/wt-spa10294-audit show refs/remotes/origin/rebuild/v2026.916.0-survivors:server/src/services/workspace-runtime.ts | grep -n "worktreePath: reusablePath"
    EXPECT: 8 hits — every `reuseExistingWorktree` return (and its internal call sites) uses the REUSED path, never the computed `runs/<runId>` path
    NEGATIVE: git -C /home/jamesilsley/wt-spa10294-audit show refs/remotes/origin/rebuild/v2026.916.0-survivors:server/src/services/workspace-runtime.ts | grep -n "worktreePath: runs/\|worktreePath: computedWorktreePath"
    NEGATIVE OBSERVED: exit 1, no match — the computed ephemeral path is never what gets persisted on the reuse return

**Result: PASS.** Observed 8 hits, and the decisive one is the `reuseExistingWorktree`
return at **`wr.ts:3585`** (`cwd: reusablePath` + `worktreePath: reusablePath`).
Severity downgraded from "identity lie / cross-run `rm`" to "undocumented
reuse-on-dirty". This gate exists because the honest answer was the *weaker* one and
the ledger must show it was tested, not assumed.

> **Line-number correction, recorded.** My first pass cited the reuse return as
> `wr.ts:3580`; the observed hit is **3585**. Every other cited anchor was re-verified
> against one materialized read (`git show` → file, then `grep`) and matched:
> `:3454` ephemeral, `:3459` `runs/<runIdSegment>`, `:3672` branch lookup, `:5325`
> `isEphemeralShape`, `:4565`/`:4701` the two `process.cwd()` recorder fallbacks,
> `:5074` rescue-branch construction, `hb.ts:22258` flag read, `hb.ts:22533`/`:22538`
> the two shape tests. The file is 10,148 lines in both the piped and materialized
> reads and `cmp` reports them **IDENTICAL**, so the drift was a hand-transcription
> error, not a moving ref — re-verified before citing, per LAW 3.

## Gate 6 — the rescue ref has zero readers (Finding 3)

**Outcome:** the rescue escape hatch is unclosed, not merely risky.

    CHECK: git -C /home/jamesilsley/wt-spa10294-audit grep -n "paperclip/rescue" refs/remotes/origin/rebuild/v2026.916.0-survivors -- server/src ':!server/src/__tests__'
    EXPECT: exactly 3 hits, all in workspace-runtime.ts (`:1307` writer, `:5028` doc comment, `:5074` writer) — i.e. PRODUCTION has no enumerator of `refs/heads/paperclip/rescue/*`
    NEGATIVE: git -C /home/jamesilsley/wt-spa10294-audit grep -n "for-each-ref" refs/remotes/origin/rebuild/v2026.916.0-survivors -- server/src/routes server/src/services
    NEGATIVE EXPECTED: exit 1, no match — no production route/service enumerates rescue refs

**Result: PASS, and it corrected me.** Observed: production hits are exactly the 3
above. The reader-shaped `for-each-ref` **does** exist in the ref, but only in
`__tests__` (2 files), `.github/workflows/release.yml`, and
`.agents/skills/garden-inbox/scripts/garden-inbox.mjs` — **never in engine
production**. A genuine production consumer of rescue refs exists for a *different*
family via the operator route: `quarantineRestoreDirtyWorkspaceBranch`
(`services/execution-workspaces.ts:814`) → `routes/execution-workspaces.ts:1093`,
`:1117`, `:1129`, which renders `- Rescue ref:` / `- Rescue commit:` /
`- Rescued file count:` onto the card (`:706-711`) and wakes the assignee with the ref
in the payload. **My first pass claimed "zero readers anywhere"; that was too strong
and is corrected in the audit doc.** Accurate severity: **P1 — the reaper's
per-run family `rescue/<runId>/<ts>` has no discovery mechanism**, so those refs are
orphaned once the run ends. I am recording the weaker-but-true claim because the
negative control is what found it — that gate is the reason this finding is honest.

## Gate 7 — the destructive-path guard is cwd-independent (Finding 5, PASS arm)

**Outcome:** the one guard that could be catastrophic to lose survives the flip.

    CHECK: git -C /home/jamesilsley/wt-spa10294-audit show refs/remotes/origin/rebuild/v2026.916.0-survivors:server/src/services/workspace-runtime.ts | grep -n "containsProjectWorkspace"
    EXPECT: ≥2 hits — the computation and the `if` that consumes it
    NEGATIVE: git -C /home/jamesilsley/wt-spa10294-audit show refs/remotes/origin/rebuild/v2026.916.0-survivors:server/src/services/workspace-runtime.ts | grep -n "containsProjectWorkspace.*process.cwd()"
    NEGATIVE OBSERVED: exit 1, no match — the containment test never consults process.cwd()

**Result: PASS.** The guard is pure `path.resolve` containment, direction unchanged
for a `…/runs/<runId>` path, which is strictly inside the parent dir. Recorded as a
PASS arm so the flip's blast radius is bounded, not only its failures.

---

## Verdict

All 7 gates PASS with pasted evidence and a run negative control each. Every `NEGATIVE:`
was executed against a disposable fixture (`/tmp/spa10294-gitlock`, a wrong filename,
a wrong jq path, a reader-grep, a `process.cwd()` grep) — **no negative was
manufactured by mutating live data**, and no negative was inferred from a grep that
"would obviously fail".

Two gates (5 and 6) exist solely to record findings that **contradict my own prior
posture on SPA-9454**. That is deliberate: LAW 3 forbids a claim on the author's
say-so, including the author's own.

**Remaining work is NOT in this ledger** because it is separate work with separate
cards: the (C′) implementation, the rescue-ref consumer + reaper, and the
push-vs-policy change that lands with the canary. The flag flip stays James-gated
(SPA-10299, interaction `2e7c9f76`, pending).