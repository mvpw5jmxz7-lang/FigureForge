# Frontend dev image: Vite + React + TypeScript.
# Node is pinned here because the host has no Node installed at all.
FROM docker.io/library/node:22-bookworm-slim

WORKDIR /app

# Source is bind-mounted and node_modules lives in a named volume, so dependency
# installation happens at container start rather than at build time.
COPY docker/web-entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 5173
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["npm", "run", "dev"]
