#!/usr/bin/env bash
set -euo pipefail
exec python3 "$(dirname "$0")/spa-11264-negative-control.py"
