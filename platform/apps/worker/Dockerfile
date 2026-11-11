# syntax=docker/dockerfile:1
# Image of the worker process (task B06, design/ADR-M27 section 2.5; B07, ADR-M30 §2.1). Build
# context: the repo root.
#   docker compose -f platform/deploy/docker-compose.yml --profile platform build sdlc-worker
# Multi-stage: the build stage compiles the workspace; the runtime stage holds only the worker and its
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
  && pnpm exec tsc -b platform/apps/worker \
  && node platform/apps/worker/dist/bundle-workflows.js \
  && pnpm --filter @sdlc/worker deploy --legacy --prod /out
# Evaluation plans (L05, ADR-M82 §2.6): the plan loop reads task set v1's versions, commit and
# task IDs from /app/eval-tasks. The reference solutions are never needed here.
RUN mkdir -p /out/eval-tasks \
  && cp -R platform/eval/tasks/v1/. /out/eval-tasks/ \
  && find /out/eval-tasks -name solution.patch -delete

FROM node:24.13.0-bookworm-slim
# Debian's security updates at build time, and no npm, npx or corepack at run time: the process
# runs `node` only, and npm's own dependencies carried CRITICAL findings (V04, design/ADR-M66 §2.6).
RUN apt-get update \
  && apt-get upgrade -y --no-install-recommends \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
ENV NODE_ENV=production
# The intent workflow code, bundled at build time (B07): no bundler work at start-up.
ENV SDLC_WORKER_WORKFLOW_BUNDLE=/app/dist/workflow-bundle.js
WORKDIR /app
COPY --from=build --chown=root:root /out /app
USER node
CMD ["node", "/app/dist/main.js"]
