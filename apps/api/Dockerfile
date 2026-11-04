# syntax=docker/dockerfile:1
# JARVIS API + worker image. Build from the repository root:
#
#   docker build -f apps/api/Dockerfile -t jarvis-api .
#
# One image, three processes:
#   API      docker run ... jarvis-api                          (CMD node dist/server.js)
#   worker   docker run ... jarvis-api node dist/worker.js
#   migrate  docker run -e DATABASE_OWNER_URL=... jarvis-api node dist/migrate.js
#   owner    docker run -it -e JARVIS_OWNER_PASSWORD ... jarvis-api node dist/cli.js create-owner ...
#
# Target "devtools" (local stacks only) adds the dev mailbox and fixture site; see docker-compose.yml.
# The browser worker has its own image with Chromium: apps/api/Dockerfile.browser.
# Base images are pinned by tag; pinning by digest is a README follow-up.
#
# Railway (deploy/railway/api.json, worker.json) builds this file as is. It uses no BuildKit cache
# mounts: Railway accepts them only with a service-specific id (id=s/<service id>-<path>), which a
# shared Dockerfile cannot know. The manifest-first layer order below still caches the install.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
WORKDIR /repo
# pnpm comes from the version pinned in package.json "packageManager".
COPY package.json ./
RUN corepack enable && corepack install

# ---------------------------------------------------------------------------------------------
FROM base AS build
# Manifests first so the dependency layer is cached until the lockfile changes. Every workspace
# manifest is copied so the frozen lockfile matches; only @jarvis/api and its workspace
# dependencies are installed.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/tokens/package.json packages/tokens/
RUN pnpm install --frozen-lockfile --filter "@jarvis/api..."

COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY db/migrations db/migrations
COPY apps/api apps/api
# esbuild bundles @jarvis/* into dist/{server,worker,browser-worker,cli,migrate}.js; npm packages
# stay external. build.mjs only warns when an entry point is missing, so check they all exist.
RUN pnpm --filter @jarvis/api build \
 && ls apps/api/dist/server.js apps/api/dist/worker.js apps/api/dist/browser-worker.js \
       apps/api/dist/migrate.js apps/api/dist/cli.js apps/api/dist/migrations/0001_init.sql
# Production node_modules for the external imports (--legacy: the workspace does not use
# inject-workspace-packages; only node_modules and package.json are taken from /out).
RUN pnpm --filter @jarvis/api deploy --prod --legacy /out

# ---------------------------------------------------------------------------------------------
# Local development helpers (dev mailbox needs tsx + smtp-server, which are dev dependencies).
# Never deploy this target.
FROM build AS devtools
COPY scripts/fixture-site.mjs /repo/scripts/fixture-site.mjs
WORKDIR /repo/apps/api
USER node
CMD ["node", "/repo/scripts/fixture-site.mjs"]

# ---------------------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
# Reported by GET /v1/assistant/status; CI can pass the git tag or SHA.
ARG APP_VERSION=0.1.0
# HOST/PORT are defaults; a platform's variables override them (Railway: PORT=4000 and HOST=::,
# the IPv6 wildcard, which also accepts IPv4, so the private network can reach the API).
ENV NODE_ENV=production \
    APP_VERSION=$APP_VERSION \
    HOST=0.0.0.0 \
    PORT=4000 \
    MIGRATIONS_DIR=/app/db/migrations \
    NODE_OPTIONS=--enable-source-maps
WORKDIR /app
# Code stays owned by root and read-only for the runtime user.
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/db/migrations ./db/migrations
USER node
EXPOSE 4000
# Liveness only (no database); readiness is GET /readyz. Override or disable for the worker.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
LABEL org.opencontainers.image.title="jarvis-api" \
      org.opencontainers.image.description="JARVIS API, worker, migrations and operator CLI" \
      org.opencontainers.image.source="https://github.com/mgrd281/NEXORA-AI"
CMD ["node", "dist/server.js"]
