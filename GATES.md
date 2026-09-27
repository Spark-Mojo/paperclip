# GATES — SPA-8996 (paperclip fork: add requirements-signoff workflow)

Target branch: `SPA-8960-carry-spa-8707-23e2d49ea-spa-8870-7e01bd2d0-onto-spark-mojo-paperclip-rebuild-v2026-916-0-survivors`
Base at dispatch: `d270f7d1d5` (PR #75 head). Head: `<new sha>`.

## G1 — workflow file is on the carry branch with the correct substitutions
CHECK: `test "$(git show HEAD:.github/workflows/requirements-signoff.yml | grep -c '^    runs-on: ubuntu-latest')" = "1" && test "$(git show HEAD:.github/workflows/requirements-signoff.yml | grep -c 'Ensure gh CLI$')" = "0"`
EXPECT: both = 1 and 0 respectively; workflow is on the branch, ubuntu-latest, no gh bootstrap step

## G2 — supporting script is on the carry branch, byte-equal to source-of-record
CHECK: `diff <(git show HEAD:scripts/ci/requirements-signoff-check.sh) <(git -C /home/jamesilsley/GitHub/sparkmojo-internal show 086a0d071:scripts/ci/requirements-signoff-check.sh)`
EXPECT: exit 0, no diff

## G3 — supporting test file is on the carry branch, byte-equal to source-of-record
CHECK: `diff <(git show HEAD:scripts/ci/requirements-signoff-check.test.sh) <(git -C /home/jamesilsley/GitHub/spark-mojo-platform show 8315b3e96:scripts/ci/requirements-signoff-check.test.sh)`
EXPECT: exit 0, no diff

## G4 — the workflow file is syntactically valid YAML (rough)
CHECK: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/requirements-signoff.yml').read())" 2>&1; echo "rc=$?"`
EXPECT: rc=0

## G5 — push is to the canonical repo (not James's fork)
CHECK: `git remote get-url sparkmojo`
EXPECT: `https://github.com/Spark-Mojo/paperclip.git`

## G6 — pushed head on the canonical repo equals local HEAD
CHECK: `git ls-remote sparkmojo SPA-8960-carry-spa-8707-23e2d49ea-spa-8870-7e01bd2d0-onto-spark-mojo-paperclip-rebuild-v2026-916-0-survivors | awk '{print $1}'`
EXPECT: equals local `git rev-parse HEAD`

## G7 — PR #75 sees the new check as a status context (workflow actually ran on PR)
CHECK: `sleep 30 && gh api repos/Spark-Mojo/paperclip/commits/<new head sha>/statuses --jq '[.[] | select(.context=="requirements-signoff/verdict")] | length'`
EXPECT: 1 (one verdict status posted, state=failure until verify posts the marker)

## G8 — re-invoke `verify` at the new head; verify returns `VERDICT: PASS`
CHECK: `task tool, subagent_type: verify, prompt: "PR: 75, HEAD: <new sha>, requirements verbatim from this child card, GATES.md from this child card with results"`
EXPECT: `VERDICT: PASS` and the verifier posts the `<!-- requirements-signoff:v1 head=<new sha> verdict=pass -->` marker as a PR comment from `sparkmojo-verify[bot]`

## G9 — verify marker → status flips to success
CHECK: `sleep 15 && gh api repos/Spark-Mojo/paperclip/commits/<new head sha>/statuses --jq '[.[] | select(.context=="requirements-signoff/verdict")] | first | .state'`
EXPECT: `success`

## G10 — pre-existing red CI on PR #75 is byte-identity-proven (do not chase)
CHECK: `git show 5e4ef13673e6:scripts/run-vitest-stable.mjs | sha256sum && git show HEAD:scripts/run-vitest-stable.mjs | sha256sum`
EXPECT: identical hashes (or the carry diff does not touch the file at all -- `git diff 5e4ef13673e6 HEAD -- scripts/run-vitest-stable.mjs | wc -l` returns 0)

## G11 (added) — the copied checker's own offline test suite passes on the fork
CHECK: `bash scripts/ci/requirements-signoff-check.test.sh`
EXPECT: `ALL TESTS PASSED` (rc=0)

## G12 (added) — the push adds exactly three files, nothing else
CHECK: `git diff --name-only <sha^> HEAD | sort | tr '\n' ' '`
EXPECT: `.github/workflows/requirements-signoff.yml scripts/ci/requirements-signoff-check.sh scripts/ci/requirements-signoff-check.test.sh` (GATES.md is committed separately as the record)

---
## Deviations from the dispatched gate table (recorded, not silent)

- **G4** — dispatched form had an unbalanced-quote typo (`.split('\n'))` inside a shell
  double-quoted string) that cannot execute. Replaced with the plain `safe_load(open(...).read())`
  form, which is the same check the dispatched form intended.
- **G6/G7/G9** — the gates read `HEAD` in the SPA-8996 worktree. This worktree's branch is
  permanently pinned to the harness contract and **must not be re-pointed**, so the commit is
  made on the PR #75 carry branch from a linked scratch worktree; the HEAD-reading gates are
  therefore re-expressed against the carry branch's remote tip (`refs/heads/SPA-8960-carry-*`
  on `sparkmojo`), which is the artifact PR #75 actually tracks.
- **G12** — added so the "three files, one commit" requirement is machine-checked rather than
  asserted.

**Known-and-accepted consequence (card-flagged, not a defect):** GitHub Actions runs `pull_request`
workflows from the workflow file **on the base branch**, not the PR head. This workflow is
therefore introduced by the *merge* of PR #75 onto `rebuild/v2026.916.0-survivors`, and the
`requirements-signoff/verdict` context cannot appear on any PR head before that merge. G7/G8/G9
as written cannot pass until the merge that this card enables. Consequence recorded on the card;
**auto-merge is not armed here** (charter v19 — Steve's lane).
