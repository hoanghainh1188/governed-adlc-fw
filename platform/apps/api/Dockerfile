# syntax=docker/dockerfile:1
# Image of the api process (task B03, design/ADR-M26 section 2.6), with the read-only dashboard's
# static files (U01, ADR-M54). Build context: the repo root.
#   docker compose -f platform/deploy/docker-compose.yml --profile platform build sdlc-api
# Multi-stage: the build stage compiles the workspace; the runtime stage holds only the api and its
# production dependencies, runs as the non-root user "node" and contains no secret.

FROM node:24.13.0-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json .npmrc ./
COPY platform/apps platform/apps
COPY platform/packages platform/packages
COPY platform/eval platform/eval
# Workspace member required by @sdlc/runner (H07, ADR-M105); copied so frozen install resolves.
COPY platform/deploy/docker-authz platform/deploy/docker-authz
RUN pnpm install --frozen-lockfile --ignore-scripts \
  && pnpm exec tsc -b platform/apps/api \
  && pnpm --filter @sdlc/dashboard build \
  && pnpm --filter @sdlc/api deploy --legacy --prod /out

FROM node:24.13.0-bookworm-slim
# Debian's security updates at build time, and no npm, npx or corepack at run time: the process
# runs `node` only, and npm's own dependencies carried CRITICAL findings (V04, design/ADR-M66 §2.6).
RUN apt-get update \
  && apt-get upgrade -y --no-install-recommends \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=root:root /out /app
# The read-only dashboard's built files (U01, design/ADR-M54): read once at start-up, served
# under /dashboard/ with a strict CSP. Static files only: no dashboard code runs in Node.
COPY --from=build --chown=root:root /repo/platform/apps/dashboard/dist/web /app/dashboard
ENV SDLC_API_DASHBOARD_DIR=/app/dashboard
USER node
EXPOSE 8080
CMD ["node", "/app/dist/main.js"]
