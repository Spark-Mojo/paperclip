#!/bin/bash
# Enable runnable bigbox units, disable non-portable ones (gbrain/macOS/iMessage).
# paperclip.service is LEFT ALONE (already enabled + running).
set -u
cd ~/.config/systemd/user

echo "##### DISABLE non-portable units #####"
disable () {
  for u in "$@"; do
    systemctl --user disable "$u" 2>/dev/null
    rm -f default.target.wants/"$u"
    echo "disabled $u"
  done
}
# gbrain host / script-missing
disable gbrain-tunnel.service gbrain-dream.service gbrain-dream.timer \
  claude-memory-mirror.service claude-memory-mirror.timer \
  governance-autocommit.service governance-autocommit.timer \
  gbrain-sync-reaper.service gbrain-sync-reaper.timer
# macOS iMessage (osascript)
disable question-pinger.service question-pinger.timer \
  health-monitor.service health-monitor.timer \
  health-monitor-watchdog.service health-monitor-watchdog.timer \
  deploy-failure-alarm.service deploy-failure-alarm.timer
# macOS ~/Library script
disable process-team-wake.service process-team-wake.timer
# laptop litellm fallback (start.sh missing; bigbox runs its own primary)
disable litellm.service

echo "##### ENABLE runnable units #####"
enable () {
  for u in "$@"; do
    # skip if unit file missing
    [ -f "$u" ] || { echo "skip (no file) $u"; continue; }
    mkdir -p default.target.wants
    ln -sf "../$u" default.target.wants/"$u"
    systemctl --user enable "$u" 2>/dev/null && echo "enabled $u" || echo "ENABLE-FAIL $u"
  done
}
# daemons (paperclip excluded — already running)
enable github-review-bridge.service jamesboard.service
# timers
enable cadence-heartbeat.timer cadence-nightly.timer \
  dex-release-check.timer disposition-guard.timer \
  governance-workspace-detector.timer hygiene-nightly.timer \
  installed-source-check.timer managed-skill-sync.timer \
  merge-flow-deploy-gate-closer.timer merge-flow-guard-deadman.timer \
  merge-flow-lifecycle-guard.timer skill-sync.timer worktree-sweep.timer

echo "##### daemon-reload #####"
systemctl --user daemon-reload
echo "##### DONE #####"
