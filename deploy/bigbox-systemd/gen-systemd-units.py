#!/usr/bin/env python3
"""Generate systemd user units from captured LaunchAgent plist data.

Output: one .service and (where scheduled) matching .timer per unit.
Paths are bigbox-absolute (/home/jamesilsley). Run on laptop, scp to bigbox.
"""
# Units that talk to the local Paperclip API must NOT hardcode the port. They
# read PAPERCLIP_API_URL (and friends) from BOX_ENV_FILE via EnvironmentFile=
# so the value is box-local: laptop default :3100, bigbox overridden (today
# :3100, :3101 once the shadow-engine port moves). Card DoD: every script that
# hardcodes 127.0.0.1:3100 reads PAPERCLIP_API_URL (default kept for laptop).
import os
OUT = os.path.dirname(os.path.abspath(__file__))
BOX_ENV_FILE = "/home/jamesilsley/.config/paperclip/box.env"
units = [
  dict(label="paperclip", kind="daemon",
       exec_start="/usr/bin/node /usr/lib/node_modules/paperclipai/dist/index.js run --bind tailnet",
       env={"ANTHROPIC_BASE_URL":"http://127.0.0.1:4141","ANTHROPIC_API_KEY":"sk-ant-proxy-dummy",
            "CLAUDE_CONFIG_DIR":"/home/jamesilsley/.claude-fleet","ACPX_CLAUDE_INCLUDE_USER_SETTINGS":"1"},
       wd="/home/jamesilsley", keepalive=True, out=".paperclip/instances/default/logs/launchd-out.log", err=".paperclip/instances/default/logs/launchd-err.log"),
  dict(label="github-review-bridge", kind="daemon", needs_repo=True,
       exec_start="/usr/bin/python3 /home/jamesilsley/bin/github-review-bridge.py",
       wd="/home/jamesilsley", keepalive=True, out=".machine-github-bridge/stderr.log", err=".machine-github-bridge/stderr.log"),
  dict(label="jamesboard", kind="daemon", needs_repo=True,
       exec_start="/usr/bin/python3 /home/jamesilsley/GitHub/spark-mojo-platform/scripts/jamesboard/serve.py",
       env={"PATH":"/usr/local/bin:/usr/bin:/bin:/home/jamesilsley/.local/bin"},
       wd="/home/jamesilsley", keepalive=True, out="/tmp/jamesboard.log", err="/tmp/jamesboard.err"),
  dict(label="litellm", kind="daemon", needs_repo=True,
       exec_start="/home/jamesilsley/.machine-litellm/start.sh",
       wd="/home/jamesilsley", keepalive=True, out=".machine-litellm/proxy.log", err=".machine-litellm/proxy.log"),
  dict(label="disposition-guard", kind="timer", interval=900, needs_repo=True,
       exec_start="/usr/bin/python3 /home/jamesilsley/.paperclip/machine-bin/disposition_guard.py --enforce --allow-undecided-stage --api-base ${PAPERCLIP_API_URL}",
       api_url=True, wd="/home/jamesilsley/.paperclip/machine-bin", out=".paperclip/disposition-guard-out.log", err=".paperclip/disposition-guard-err.log"),
  dict(label="dex-release-check", kind="timer", interval=900, needs_repo=True,
       exec_start="/usr/bin/python3 /home/jamesilsley/.paperclip/machine-bin/dex_release_check.py",
       wd="/home/jamesilsley/.paperclip/machine-bin", out=".paperclip/dex-release-check-out.log", err=".paperclip/dex-release-check-err.log"),
  dict(label="governance-workspace-detector", kind="timer", interval=900, needs_repo=True,
       exec_start="/bin/bash /home/jamesilsley/.paperclip/bin/governance-workspace-detector.sh",
       env={"PAPERCLIP_COMPANY_ID":"5f872702-0dc1-4a58-817c-774b614f1665"}, api_url=True,
       wd="/home/jamesilsley/GitHub/sparkmojo-internal", out=".paperclip/governance-detector.log", err=".paperclip/governance-detector.err.log"),
  dict(label="question-pinger", kind="timer", interval=900, needs_repo=True, imessage=True,
       exec_start="/bin/bash /home/jamesilsley/GitHub/sparkmojo-internal/platform/strategy-pipeline/monitor/bin/question-pinger.sh",
       env={"QUESTION_PINGER_DAILY_CAP":"5","QUESTION_PINGER_OLDER_HOURS":"4","QUESTION_PINGER_RENOTIFY_HOURS":"24"}, api_url=True,
       out="GitHub/sparkmojo-internal/platform/strategy-pipeline/monitor/state/question-pinger.out.log", err="GitHub/sparkmojo-internal/platform/strategy-pipeline/monitor/state/question-pinger.err.log"),
  dict(label="health-monitor", kind="timer", calendar="*-*-* 09:00:00", needs_repo=True, imessage=True,
       exec_start="/bin/sh /home/jamesilsley/.sparkmojo/monitor-sync-and-run.sh /bin/bash /home/jamesilsley/.sparkmojo/monitor-main/platform/strategy-pipeline/monitor/bin/run-monitor.sh",
       out=".sparkmojo/monitor-main/platform/strategy-pipeline/monitor/state/launchd.out.log", err=".sparkmojo/monitor-main/platform/strategy-pipeline/monitor/state/launchd.err.log"),
  dict(label="health-monitor-watchdog", kind="timer", calendar="*-*-* 09:45:00", needs_repo=True, imessage=True,
       exec_start="/bin/sh /home/jamesilsley/.sparkmojo/monitor-sync-and-run.sh /bin/bash /home/jamesilsley/.sparkmojo/monitor-main/platform/strategy-pipeline/monitor/bin/watchdog.sh",
       out=".sparkmojo/monitor-main/platform/strategy-pipeline/monitor/state/watchdog.out.log", err=".sparkmojo/monitor-main/platform/strategy-pipeline/monitor/state/watchdog.err.log"),
  dict(label="deploy-failure-alarm", kind="timer", interval=900, needs_repo=True, imessage=True,
       exec_start="/bin/sh /home/jamesilsley/.sparkmojo/monitor-sync-and-run.sh /bin/bash /home/jamesilsley/.sparkmojo/monitor-main/platform/strategy-pipeline/monitor/bin/deploy-failure-alarm.sh",
       out=".sparkmojo/monitor-main/platform/strategy-pipeline/monitor/state/deploy-failure-alarm.out.log", err=".sparkmojo/monitor-main/platform/strategy-pipeline/monitor/state/deploy-failure-alarm.err.log"),
  dict(label="gbrain-sync-reaper", kind="timer", interval=900, needs_repo=True,
       exec_start="/bin/bash /home/jamesilsley/GitHub/sparkmojo-internal/platform/strategy-pipeline/monitor/bin/gbrain-sync-reaper.sh",
       out="/dev/null", err="GitHub/sparkmojo-internal/platform/strategy-pipeline/monitor/state/gbrain-sync-reaper.err.log"),
  dict(label="governance-autocommit", kind="timer", interval=900, needs_repo=True,
       exec_start="/bin/bash /home/jamesilsley/.gbrain/governance-autocommit.sh",
       out=".gbrain/governance-autocommit-out.log", err=".gbrain/governance-autocommit-err.log"),
  dict(label="installed-source-check", kind="timer", calendar="*-*-* 05:10:00", needs_repo=True,
       exec_start="/bin/bash /home/jamesilsley/GitHub/sparkmojo-internal/infra/launchd/scripts/check-installed.sh",
       out=".gbrain/installed-source-check.log", err=".gbrain/installed-source-check.log"),
  dict(label="cadence-heartbeat", kind="timer", interval=10800, needs_repo=True,
       exec_start="/bin/bash /home/jamesilsley/GitHub/sparkmojo-internal/platform/strategy-pipeline/scheduler/bin/gate.sh",
       out="GitHub/sparkmojo-internal/platform/strategy-pipeline/scheduler/state/launchd-heartbeat.out.log", err="GitHub/sparkmojo-internal/platform/strategy-pipeline/scheduler/state/launchd-heartbeat.err.log"),
  dict(label="cadence-nightly", kind="timer", calendar="*-*-* 03:30:00", needs_repo=True,
       exec_start="/bin/bash /home/jamesilsley/GitHub/sparkmojo-internal/platform/strategy-pipeline/scheduler/bin/gate.sh",
       out="GitHub/sparkmojo-internal/platform/strategy-pipeline/scheduler/state/launchd-nightly.out.log", err="GitHub/sparkmojo-internal/platform/strategy-pipeline/scheduler/state/launchd-nightly.err.log"),
  dict(label="hygiene-nightly", kind="timer", calendar="*-*-* 04:15:00", needs_repo=True, needs_bun=True,
       exec_start="/bin/bash /home/jamesilsley/GitHub/spark-mojo-platform/scripts/hygiene/nightly-hygiene.sh",
       out=".gbrain/hygiene-nightly.log", err=".gbrain/hygiene-nightly.log"),
  dict(label="claude-memory-mirror", kind="timer", calendar="*-*-* 02:45:00", needs_repo=True,
       exec_start="/bin/bash /home/jamesilsley/.gbrain/claude-memory-mirror.sh",
       out=".gbrain/claude-memory-mirror.log", err=".gbrain/claude-memory-mirror.log"),
  dict(label="gbrain-dream", kind="timer", calendar="*-*-* 04:30:00", needs_repo=True,
       exec_start="/bin/sh /home/jamesilsley/.gbrain/run-dream.sh",
       out=".gbrain/dream.log", err=".gbrain/dream.log"),
  dict(label="gbrain-tunnel", kind="daemon", needs_repo=True,
       exec_start="/usr/bin/ssh -NT -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityAgent=none -o ControlMaster=no -o ControlPath=none -i /home/jamesilsley/.ssh/gbrain_tunnel -L 5433:127.0.0.1:5433 sparkmojo",
       wd="/home/jamesilsley", keepalive=True, out=".gbrain/tunnel.log", err=".gbrain/tunnel.log"),
  dict(label="merge-flow-deploy-gate-closer", kind="timer", interval=300, needs_repo=True,
       exec_start="/bin/bash -lc 'exec /home/jamesilsley/.sparkmojo/monitor-sync-and-run.sh /usr/bin/python3 /home/jamesilsley/.sparkmojo/platform-main/scripts/merge-flow/deploy-gate-closer.py --api-base ${PAPERCLIP_API_URL}'",
       env={"SYNC_TREE":"/home/jamesilsley/.sparkmojo/platform-main"}, api_url=True,
       wd="/home/jamesilsley/.sparkmojo/platform-main", out=".sparkmojo/merge-flow/deploy-gate-closer-out.log", err=".sparkmojo/merge-flow/deploy-gate-closer-err.log"),
  dict(label="merge-flow-lifecycle-guard", kind="timer", interval=300, needs_repo=True,
       exec_start="/bin/bash -lc 'exec /home/jamesilsley/.sparkmojo/monitor-sync-and-run.sh /usr/bin/python3 /home/jamesilsley/.sparkmojo/platform-main/scripts/merge-flow/lifecycle-guard.py --api-base ${PAPERCLIP_API_URL}'",
       env={"SYNC_TREE":"/home/jamesilsley/.sparkmojo/platform-main"}, api_url=True,
       wd="/home/jamesilsley/.sparkmojo/platform-main", out=".sparkmojo/merge-flow/lifecycle-guard-out.log", err=".sparkmojo/merge-flow/lifecycle-guard-err.log"),
  dict(label="merge-flow-guard-deadman", kind="timer", interval=300, needs_repo=True,
       exec_start="/usr/bin/python3 /home/jamesilsley/.sparkmojo/bin/guard-deadman.py --api-base ${PAPERCLIP_API_URL}",
       api_url=True, wd="/home/jamesilsley/.sparkmojo", out=".sparkmojo/merge-flow/guard-deadman-out.log", err=".sparkmojo/merge-flow/guard-deadman-err.log"),
  dict(label="process-team-wake", kind="timer", calendar="Mon *-*-* 07:00:00", needs_repo=True,
       exec_start="/bin/bash /home/jamesilsley/Library/LaunchAgents/process-team-wake.sh",
       out="/tmp/process-team.log", err="/tmp/process-team.log"),
  dict(label="managed-skill-sync", kind="timer", interval=900, needs_repo=True,
       exec_start="/bin/bash /home/jamesilsley/GitHub/sparkmojo-internal/skills/runner-managed-skill-sync.sh",
       env={"SPARKMOJO_REPO":"/home/jamesilsley/GitHub/sparkmojo-internal"},
       out=".claude/managed-skill-sync.stdout.log", err=".claude/managed-skill-sync.stderr.log"),
  dict(label="skill-sync", kind="timer", interval=900, needs_repo=True,
       exec_start="/bin/bash /home/jamesilsley/GitHub/sparkmojo-internal/skills/runner-sync-skills.sh",
       env={"SPARKMOJO_REPO":"/home/jamesilsley/GitHub/sparkmojo-internal"},
       out=".claude/skill-sync.stdout.log", err=".claude/skill-sync.stderr.log"),
  dict(label="worktree-sweep", kind="timer", calendar="*-*-* 04:47:00", needs_repo=True,
       exec_start="/bin/bash /home/jamesilsley/.sparkmojo/worktree-sweep/worktree-sweep.sh --apply",
       wd="/home/jamesilsley/GitHub/sparkmojo-internal", out=".paperclip/worktree-sweep.log", err=".paperclip/worktree-sweep.log"),
]

def svc(u):
    oneshot = not u.get("keepalive")
    lines = ["[Unit]", f"Description={u['label']} (bigbox)", "After=network-online.target", "", "[Service]",
             "Type=oneshot" if oneshot else "Type=simple"]
    if u.get("keepalive"):
        lines += ["Restart=always", "RestartSec=30"]
    lines.append(f"WorkingDirectory={u.get('wd','/home/jamesilsley')}")
    if u.get("api_url"):
        # Box-local API URL: default :3100 (laptop) in box.env, overridden per-box.
        lines.append(f"EnvironmentFile={BOX_ENV_FILE}")
    if u.get("env"):
        for k,v in u["env"].items():
            lines.append(f"Environment={k}={v}")
    lines += [f"ExecStart={u['exec_start']}",
              f"StandardOutput=append:/home/jamesilsley/{u['out']}",
              f"StandardError=append:/home/jamesilsley/{u['err']}",
              "", "[Install]", "WantedBy=default.target"]
    return "\n".join(lines)

def tmr(u):
    lines = ["[Unit]", f"Description=Timer for {u['label']}", "", "[Timer]", f"Unit={u['label']}.service"]
    if u.get("interval"):
        lines.append(f"OnUnitActiveSec={u['interval']}s")
    elif u.get("calendar"):
        lines.append(f"OnCalendar={u['calendar']}")
    lines += ["", "[Install]", "WantedBy=timers.target"]
    return "\n".join(lines)

for u in units:
    name = u["label"]
    with open(f"{OUT}/{name}.service", "w") as f:
        f.write(svc(u) + "\n")
    if u["kind"] == "timer":
        with open(f"{OUT}/{name}.timer", "w") as f:
            f.write(tmr(u) + "\n")
print(f"wrote {len(units)} services")
