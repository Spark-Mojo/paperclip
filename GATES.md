# GATES — SPA-9007 land requirements-signoff workflow on Spark-Mojo/paperclip

Card: SPA-9007 (follow-up to SPA-8996, whose work was parked and never merged).
Deliverable: cherry-pick `c8ea0b1b0` (3 files) onto `origin/master` of `Spark-Mojo/paperclip`.

## G1 — All three files land on the branch
  The deliverable is three files, not one: the workflow's final step runs the checker.
    CHECK: git show --stat --oneline HEAD | tail -4
    EXPECT: 3 files changed

## G2 — Workflow YAML is parseable and triggers on pull_request
  A malformed workflow file is the single most likely way this lands broken.
    CHECK: python3 -c "import yaml,sys; d=yaml.safe_load(open('.github/workflows/requirements-signoff.yml')); print('jobs',list(d['jobs'])); print('on',list(d[True] if True in d else d['on']))"
    EXPECT: jobs ['evaluate']

## G3 — Runner label is ubuntu-latest, not self-hosted
  This fork has 0 self-hosted runners; a self-hosted label queues forever.
    CHECK: grep -n '^    runs-on:' .github/workflows/requirements-signoff.yml
    EXPECT: exactly one directive, reading `runs-on: ubuntu-latest`

## G4 — No stale self-hosted reference on the runner directive
  Occurrences in comments are expected and intentional (the file documents its
  own substitution); the *directive* must not carry one.
    CHECK: grep -n '^    runs-on:' .github/workflows/requirements-signoff.yml | grep -c 'self-hosted' || true
    EXPECT: 0

## G5 — Checker regression test passes
  The checker script ships with its own test in the same commit.
    CHECK: bash scripts/ci/requirements-signoff-check.test.sh
    EXPECT: exit 0

## G6 — Checker exits 1 with no trusted marker (fail-closed default)
  With no marker the gate must FAIL, not silently pass. Also proves the
  JamesSparkMojo-authored marker is rejected.
    CHECK: bash scripts/ci/requirements-signoff-check.sh 2>&1; test $? -ne 0
    EXPECT: non-zero exit

## G7 — Workflow YAML matches the sparkmojo-internal source-of-record plus exactly two authorized substitutions
    CHECK: git show HEAD:.github/workflows/requirements-signoff.yml | sha256sum; sha256sum of internal's copy for comparison
    EXPECT: differs from internal only in the two documented substitutions (verified out-of-band by diff, recorded in the PR body)

## G8 — Nothing else touched
    CHECK: git diff --name-only origin/master...HEAD
    EXPECT: exactly the three deliverable paths
