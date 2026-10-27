# Kompass in one container: the workspace server (Hono, run with tsx) also serves the built web app.
# deploy/deploy.sh builds it on the team's workshop VM; deploy/README.md explains the setup.

FROM node:24-slim AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY shared /app/shared
COPY web ./
# The team nginx serves Kompass under /kompass/; build with --build-arg KOMPASS_BASE=/ to serve it at the root.
ARG KOMPASS_BASE=/kompass/
RUN KOMPASS_BASE=$KOMPASS_BASE npx vite build

FROM node:24-slim
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY shared /app/shared
COPY api /app/api
COPY maingau_nba_mockdata_csv_jsonl /app/maingau_nba_mockdata_csv_jsonl
COPY event_stream_2026-10-01.jsonl /app/
COPY server ./
COPY --from=web /app/web/dist /app/web/dist
# The workspace and the logs live in /data, a volume on the VM's data disk, so they survive a redeploy.
ENV NODE_ENV=production SERVE_WEB=/app/web/dist ENGINE_PORT=8787 WORKSPACE_FILE=/data/workspace.json LOG_DIR=/data/logs
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD node -e "fetch('http://localhost:8787/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node_modules/.bin/tsx", "src/index.ts"]
