#!/bin/bash
# Cross-reference each unit's ExecStart against the live bigbox filesystem.
# iMessage units (osascript) flagged separately. Run on bigbox.
shopt -s nullglob
for f in ~/.config/systemd/user/*.service; do
  base=$(basename "$f")
  line=$(grep "^ExecStart=" "$f" | head -1)
  [ -z "$line" ] && { echo "NO-EXECSTART $base"; continue; }
  rest="${line#ExecStart=}"
  cmdword="${rest%% *}"
  args="${rest#* }"
  case "$cmdword" in
    /usr/bin/node) echo "NODE      $base" ;;
    /usr/bin/python3)
      p="${args%% *}"
      [ -e "$p" ] && echo "OK        $base" || echo "MISS      $base -> $p" ;;
    /usr/bin/ssh) echo "SSH       $base" ;;
    /bin/bash|/bin/sh)
      scmd="${args%% *}"
      [ -e "$scmd" ] && echo "OK        $base -> $scmd" || echo "MISS      $base -> $scmd" ;;
    /home/jamesilsley/.machine-litellm/start.sh) echo "LAPTOP    $base" ;;
    *) echo "OTHER     $base -> $cmdword" ;;
  esac
done
echo "=== iMessage (osascript) units ==="
grep -l "osascript\|send-imessage" ~/.config/systemd/user/*.service 2>/dev/null | while read -r f; do echo "IMESSAGE  $(basename "$f")"; done
echo "=== done ==="
