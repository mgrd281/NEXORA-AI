# syntax=docker/dockerfile:1
# JARVIS web app image (Next.js standalone output). Build from the repository root:
#
#   docker build -f apps/web/Dockerfile --build-arg API_ORIGIN=http://api:4000 -t jarvis-web .
#   docker run -p 3000:3000 -e API_ORIGIN=http://api:4000 jarvis-web
#
# API_ORIGIN is where the same-origin /api proxy forwards to (ADR-0012). It is passed at build
# time too, because Next.js resolves next.config rewrites during `next build` (they end up in
# .next/routes-manifest.json); the streaming route for /api/v1/events reads it at run time. Keep
# both equal, and rebuild after changing it. Requires output: 'standalone' in
# apps/web/next.config. Base images are pinned by tag; pinning by digest is a README follow-up.
#
# Railway (deploy/railway/web.json): a service variable named API_ORIGIN is passed to the
# `ARG API_ORIGIN` lines below as a build argument, and to the container at run time, e.g.
# http://api.railway.internal:4000. The build log prints the value it used. PORT and HOSTNAME
# are read by the standalone server.js. No BuildKit cache mounts: Railway accepts them only with
# a service-specific id (see apps/api/Dockerfile).

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1 \
    CI=true
WORKDIR /repo
COPY package.json ./
RUN corepack enable && corepack install

# ---------------------------------------------------------------------------------------------
FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/tokens/package.json packages/tokens/
RUN pnpm install --frozen-lockfile --filter "@jarvis/web..."

COPY tsconfig.base.json ./
COPY packages packages
COPY apps/web apps/web
ARG API_ORIGIN=http://api:4000
ENV API_ORIGIN=$API_ORIGIN
# The origin is not a secret; printing it makes a wrong or missing build argument visible.
RUN echo "next.config rewrites /api/* to API_ORIGIN=${API_ORIGIN}" \
 && pnpm --filter @jarvis/web build
# Assemble a fixed layout under /out regardless of where Next placed server.js (it mirrors
# the path from the file-tracing root, which is the monorepo root or apps/web).
RUN set -eu; s=apps/web/.next/standalone; \
    if [ -f "$s/apps/web/server.js" ]; then mkdir -p /out && cp -a "$s/." /out/; \
    elif [ -f "$s/server.js" ]; then mkdir -p /out/apps/web && cp -a "$s/." /out/apps/web/; \
    else echo "No standalone server.js: set output: 'standalone' in apps/web/next.config" >&2; exit 1; fi; \
    mkdir -p /out/apps/web/.next; \
    cp -a apps/web/.next/static /out/apps/web/.next/static; \
    if [ -d apps/web/public ]; then cp -a apps/web/public /out/apps/web/public; fi

# ---------------------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ARG API_ORIGIN=http://api:4000
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    API_ORIGIN=$API_ORIGIN \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
# Code stays owned by root and read-only for the runtime user. Next writes its runtime cache
# (image optimisation, ISR) to .next/cache, which is the only writable path.
COPY --from=build /out ./
RUN mkdir -p apps/web/.next/cache && chown node:node apps/web/.next/cache
USER node
EXPOSE 3000
# Any non-5xx answer from the web server counts as alive (sign-in redirects are expected).
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/',{redirect:'manual'}).then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"]
LABEL org.opencontainers.image.title="jarvis-web" \
      org.opencontainers.image.description="JARVIS web app (Next.js)" \
      org.opencontainers.image.source="https://github.com/mgrd281/NEXORA-AI"
CMD ["node", "apps/web/server.js"]
