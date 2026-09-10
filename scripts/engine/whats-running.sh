#!/usr/bin/env bash
set -euo pipefail
CURRENT_LINK="${CURRENT_LINK:-$HOME/paperclip-current}"; UNIT_NAME="${UNIT_NAME:-paperclip.service}"
ENGINE_SCRIPT_DIR="${PAPERCLIP_ENGINE_SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"; PROC_ROOT="${PAPERCLIP_PROC_ROOT:-/proc}"
[ -L "$CURRENT_LINK" ] || { echo "ERROR: managed current link missing" >&2; exit 1; }
prefix="$(readlink -f "$CURRENT_LINK")"; receipt="$prefix/.paperclip-engine-overlay.json"
[ -f "$receipt" ] || { echo "ERROR: managed overlay receipt missing" >&2; exit 1; }
read -r version source_sha < <(node -e 'const fs=require("fs"),r=JSON.parse(fs.readFileSync(process.argv[2]));console.log(`${JSON.parse(fs.readFileSync(process.argv[1])).version} ${r.sourceSha}`)' "$prefix/lib/node_modules/paperclipai/package.json" "$receipt")
node "$ENGINE_SCRIPT_DIR/overlay-contract.mjs" --verify "$prefix" "$source_sha" "$receipt" >/dev/null
active="$(systemctl --user show "$UNIT_NAME" --property=ActiveState --value 2>/dev/null||true)"; pid="$(systemctl --user show "$UNIT_NAME" --property=MainPID --value 2>/dev/null||true)"; configured="$(systemctl --user show "$UNIT_NAME" --property=ExecStart --value 2>/dev/null||true)"; running=NO
configured_ok=0
if printf '%s' "$configured" | node -e '
  const fs=require("fs");let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const m=s.match(/^\{ path=([^ ;]+) ; argv\[\]=([^ ;]+)(?: | ;)/);if(!m)process.exit(1);const link=process.argv[1],prefix=fs.realpathSync(process.argv[2]),expected=prefix+"/lib/node_modules/paperclipai/dist/index.js";if(m[1]!==link+"/bin/paperclipai"||m[2]!==m[1]||fs.realpathSync(m[1])!==expected)process.exit(1)})
' "$CURRENT_LINK" "$prefix"; then configured_ok=1; fi
if [ "$configured_ok" = 1 ] && [ "$active" = active ] && [[ "$pid" =~ ^[1-9][0-9]*$ ]] && [ -e "$PROC_ROOT/$pid/exe" ] && [ -r "$PROC_ROOT/$pid/cmdline" ]; then
  if node -e '
    const fs=require("fs"),path=require("path"); const proc=process.argv[1],prefix=fs.realpathSync(process.argv[2]);
    const exe=fs.realpathSync(path.join(proc,"exe")), argv=fs.readFileSync(path.join(proc,"cmdline")).toString().split("\0").filter(Boolean);
    if(!/(^|\/)node(js)?$/.test(exe))process.exit(1); if(argv.length<2)process.exit(1);
    const script=fs.realpathSync(argv[1]), expected=path.join(prefix,"lib/node_modules/paperclipai/dist/index.js"); if(script!==expected)process.exit(1);
  ' "$PROC_ROOT/$pid" "$CURRENT_LINK"; then running=YES; fi
fi
if [ -n "${PAPERCLIP_ENGINE_TEST_FLIP_CURRENT_TO:-}" ]; then ln -sfn "$PAPERCLIP_ENGINE_TEST_FLIP_CURRENT_TO" "$CURRENT_LINK"; fi
[ "$(readlink -f "$CURRENT_LINK")" = "$prefix" ] || { echo "ERROR: managed current link changed during inspection" >&2; exit 1; }
echo "Managed prefix : $prefix"; echo "Version        : $version"; echo "Source SHA     : $source_sha"; echo "Engine running : $running"
node "$ENGINE_SCRIPT_DIR/overlay-contract.mjs" --changes "$receipt"
[ "$running" = YES ]
