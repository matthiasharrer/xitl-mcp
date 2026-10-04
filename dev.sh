#!/usr/bin/env bash
# Foreground dev runner: starts the API and web dev servers in parallel.
# Ctrl-C stops both. For a background/testing workflow use scripts/app.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

trap 'kill 0' EXIT

npm --workspace @xitl/api run dev &
npm --workspace @xitl/web run dev &
wait
