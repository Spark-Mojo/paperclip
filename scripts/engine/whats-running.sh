#!/usr/bin/env bash
set -euo pipefail
CURRENT_LINK="${CURRENT_LINK:-$HOME/paperclip-current}"
UNIT_NAME="${UNIT_NAME:-paperclip.service}"
ENGINE_SCRIPT_DIR="${PAPERCLIP_ENGINE_SCRIPT_DIR:-$HOME/.local/lib/paperclip-engine}"
[ -L "$CURRENT_LINK" ] || { echo "ERROR: managed current link missing" >&2; exit 1; }
prefix="$(readlink -f "$CURRENT_LINK")"
receipt="$prefix/.paperclip-engine-overlay.json"
[ -f "$receipt" ] || { echo "ERROR: managed overlay receipt missing" >&2; exit 1; }
read -r version source_sha < <(node -e 'const fs=require("fs"),p=process.argv[1],r=JSON.parse(fs.readFileSync(process.argv[2]));console.log(`${JSON.parse(fs.readFileSync(p)).version} ${r.sourceSha}`)' "$prefix/lib/node_modules/paperclipai/package.json" "$receipt")
node "$ENGINE_SCRIPT_DIR/overlay-contract.mjs" --verify "$prefix" "$source_sha" "$receipt" >/dev/null
active="$(systemctl --user show "$UNIT_NAME" --property=ActiveState --value 2>/dev/null || true)"
pid="$(systemctl --user show "$UNIT_NAME" --property=MainPID --value 2>/dev/null || true)"
exec_start="$(systemctl --user show "$UNIT_NAME" --property=ExecStart --value 2>/dev/null || true)"
running=NO
if [ "$active" = active ] && [[ "$pid" =~ ^[1-9][0-9]*$ ]] && [[ "$exec_start" == *"$CURRENT_LINK/bin/paperclipai"* ]]; then running=YES; fi
modified="$(node -e 'const r=require(process.argv[1]);console.log(r.overlays.reduce((n,x)=>n+x.resultInventory.length,0))' "$receipt")"
echo "Managed prefix : $prefix"
echo "Version        : $version"
echo "Source SHA     : $source_sha"
echo "Engine running : $running"
echo "Overlay files  : $modified (receipt verified)"
[ "$running" = YES ]
