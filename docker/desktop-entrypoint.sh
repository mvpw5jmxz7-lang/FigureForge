#!/usr/bin/env bash
set -euo pipefail

# Electron's binary is fetched here, once, into an image path rather than into
# the shared /app/node_modules volume. The web and test containers install that
# volume with ELECTRON_SKIP_BINARY_DOWNLOAD=1 — they only ever need the
# TypeScript definitions — so the ~100 MB Chromium belongs to this image alone.
#
# Pinned exactly, not floated: the whole point of the container images here is
# that an export (and now a shell) behaves the same on every machine.
ELECTRON_VERSION="${ELECTRON_VERSION:-43.4.0}"
ELECTRON_DIR="${FIGUREFORGE_ELECTRON_DIR:-/opt/electron}"
ELECTRON_BIN="${ELECTRON_DIR}/node_modules/electron/dist/electron"

if [ ! -x "${ELECTRON_BIN}" ]; then
  echo "==> fetching electron ${ELECTRON_VERSION} (first run)"
  mkdir -p "${ELECTRON_DIR}"
  cd "${ELECTRON_DIR}"
  [ -f package.json ] || echo '{"name":"electron-host","private":true}' > package.json
  npm install --no-audit --no-fund "electron@${ELECTRON_VERSION}" >/dev/null
  # npm is configured to skip lifecycle scripts in this environment, so the
  # binary download is invoked explicitly rather than left to a postinstall
  # that may or may not have run.
  node node_modules/electron/install.js
fi

export FIGUREFORGE_ELECTRON_BIN="${ELECTRON_BIN}"
cd /app

exec "$@"
