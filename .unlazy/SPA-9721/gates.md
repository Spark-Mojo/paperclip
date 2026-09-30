# SPA-9721 gates

- Gate 1: Four push workflows target the live fork default branch; Docker's cloud delegation excludes that same branch on push, preserving tag and dispatch triggers.
  CHECK: `timeout 30 python3 -c 'import pathlib, yaml; root=pathlib.Path(".github/workflows"); names=("docker.yml","release.yml","refresh-lockfile.yml","cloud-readiness.yml"); branch="rebuild/v2026.916.0-survivors"; data={name:yaml.safe_load((root/name).read_text()) for name in names}; assert all(doc[True]["push"]["branches"] == [branch] for doc in data.values()); docker=(root/"docker.yml").read_text(); assert "if: github.event_name != \u0027push\u0027 || github.ref != \u0027refs/heads/"+branch+"\u0027" in docker; assert data["docker.yml"][True]["push"]["tags"] == ["v*","nightly/v*","beta/v*"]; assert all("workflow_dispatch" in doc[True] for doc in data.values()); print("PUSH_FILTERS_OK")'`
  EXPECT: `PUSH_FILTERS_OK`
  NEGATIVE: `timeout 30 env BAD_BRANCH=master python3 -c 'import pathlib, yaml, os; root=pathlib.Path(".github/workflows"); names=("docker.yml","release.yml","refresh-lockfile.yml","cloud-readiness.yml"); branch="rebuild/v2026.916.0-survivors"; data={name:yaml.safe_load((root/name).read_text()) for name in names}; data["docker.yml"][True]["push"]["branches"]=[os.environ["BAD_BRANCH"]]; assert all(doc[True]["push"]["branches"] == [branch] for doc in data.values()); docker=(root/"docker.yml").read_text(); assert "if: github.event_name != \u0027push\u0027 || github.ref != \u0027refs/heads/"+branch+"\u0027" in docker; assert data["docker.yml"][True]["push"]["tags"] == ["v*","nightly/v*","beta/v*"]; assert all("workflow_dispatch" in doc[True] for doc in data.values()); print("PUSH_FILTERS_OK")'`
  EXPECT NEGATIVE: nonzero assertion failure for stale master branch in isolated in-memory fixture.
  NEGATIVE GUARD: `timeout 30 node -e 'const fs=require("fs");const t=fs.readFileSync(".github/workflows/docker.yml","utf8").replace("github.ref != '\''refs/heads/rebuild/v2026.916.0-survivors'\''","github.ref != '\''refs/heads/master'\''"); if(t.includes("if: github.event_name != '\''push'\'' || github.ref != '\''refs/heads/rebuild/v2026.916.0-survivors'\''"))process.exit(0); console.error("STALE_GUARD_REJECTED");process.exit(1)'`
  RESULT: CHECK exit 0, `PUSH_FILTERS_OK`; NEGATIVE exit 1, `AssertionError` on in-memory stale `master` fixture; NEGATIVE GUARD exit 1 `STALE_GUARD_REJECTED`. `git diff --check` exit 0.

- Gate 2: New fork trunk tip has actionable check runs and `pr-read.sh` rows with verbatim names.
  CHECK: `timeout 30 gh api repos/Spark-Mojo/paperclip/commits/$(gh api repos/Spark-Mojo/paperclip/branches/rebuild%2Fv2026.916.0-survivors --jq .commit.sha)/check-runs --jq '{total_count,names:[.check_runs[].name]}'`
  EXPECT: `total_count` greater than zero; names include at least one non-skipped push job.
  NEGATIVE: Not safe to mutate live check runs; no isolated equivalent for GitHub scheduler. This gate remains unproven until after merge.
  CHECK: `timeout 30 /home/jamesilsley/.config/opencode-fleet-xdg/fleet/pr-read.sh checks $(gh api repos/Spark-Mojo/paperclip/branches/rebuild%2Fv2026.916.0-survivors --jq .commit.sha) --repo Spark-Mojo/paperclip`
  EXPECT: nonempty rows for the new trunk tip, names transcribed verbatim on card.
  RESULT: pending post-merge; no safe negative for live GitHub scheduler.
