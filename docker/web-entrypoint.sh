#!/usr/bin/env bash
set -euo pipefail

# node_modules is a named volume and starts empty on first run.
if [ ! -d /app/node_modules/typescript ]; then
  echo "==> installing npm dependencies (first run)"
  npm install
fi

exec "$@"
