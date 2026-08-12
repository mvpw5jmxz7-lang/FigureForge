# Desktop shell image: Electron, plus the Python service it supervises.
#
# This exists to *verify* the desktop build, not to ship it — a real release is
# an installer produced by electron-builder on each target OS. But the standing
# rule here is that green tests do not mean the app runs, and the Electron main
# process is precisely what unit tests cannot reach: window creation, preload
# wiring, and spawning and reaping a real child process.
#
# Based on the API image rather than on a Node image, deliberately. The thing
# under test is a shell that owns a Python sidecar, so a container with no
# Python could only ever verify half of it — and pointing the shell at a
# service someone else started would skip the entire lifecycle this stage
# exists to build. This layout is also the closer analogue of a packaged
# application, which ships an interpreter beside the executable.
#
# Requires `make build` first: it starts from that image.
FROM docker.io/library/node:22-bookworm-slim AS node

FROM localhost/figureforge-api

# Both images are bookworm, so the glibc these binaries were linked against is
# the one they land on; copying is simpler and more reproducible than adding a
# third-party apt repository for a current Node.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# Playwright's Chromium already brought most of Electron's dependency set into
# this image; GTK and Xvfb are what remain. Chromium's headless shell does not
# need GTK, but an Electron BrowserWindow is a real toplevel window and does.
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb xauth libgtk-3-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY docker/desktop-entrypoint.sh /usr/local/bin/desktop-entrypoint.sh
RUN chmod +x /usr/local/bin/desktop-entrypoint.sh

# Electron's binary lives outside the bind-mounted workspace so it survives the
# shared node_modules volume being installed with ELECTRON_SKIP_BINARY_DOWNLOAD
# — the web and test containers need only the TypeScript definitions, never the
# ~100 MB Chromium they would otherwise download.
ENV FIGUREFORGE_ELECTRON_DIR=/opt/electron
ENV FIGUREFORGE_API_DIR=/app/services/api

ENTRYPOINT ["/usr/local/bin/desktop-entrypoint.sh"]
CMD ["bash"]
