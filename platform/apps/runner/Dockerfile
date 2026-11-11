# syntax=docker/dockerfile:1
# Image of the runner process (task C04, design/ADR-M25). Build context: the repo root.
#   docker compose -f platform/deploy/docker-compose.yml --profile sandbox build sdlc-runner
# Multi-stage: the build stage compiles the workspace; the runtime stage holds only the runner,
# its production dependencies and git (the runner clones, never the sandbox: QUESTIONS #52). It
# runs as the non-root user "node", contains no secret and reaches Docker only through the
# socket proxy of the profile "sandbox".

FROM node:24.13.0-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
# Gitleaks for the secret scan of every run's diff (H04, ADR-M93 §2.1): the version and SHA-256
# pinned in the script (the same as the CI `scan` job), for the build machine's own architecture.
COPY platform/deploy/scripts/gitleaks.sh /tmp/gitleaks.sh
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && cp "$(SDLC_GITLEAKS_DIR=/tmp/gitleaks sh /tmp/gitleaks.sh)" /usr/local/bin/gitleaks \
  && rm -rf /tmp/gitleaks /tmp/gitleaks.sh
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json .npmrc ./
COPY platform/apps platform/apps
COPY platform/packages platform/packages
COPY platform/eval platform/eval
# Shared AuthZ denylist package (H07, ADR-M105); required workspace member for frozen install.
COPY platform/deploy/docker-authz platform/deploy/docker-authz
RUN pnpm install --frozen-lockfile --ignore-scripts \
  && pnpm exec tsc -b platform/apps/runner \
  && pnpm --filter @sdlc/runner deploy --legacy --prod /out
# Evaluation runs (L04, ADR-M81 §2.7): task set v1 and the configurations travel with the image,
# as /app/eval-tasks and /app/eval-configs. The reference solutions are for the task checks on a
# developer machine; the runner never needs them.
RUN mkdir -p /out/eval-tasks /out/eval-configs \
  && cp -R platform/eval/tasks/v1/. /out/eval-tasks/ \
  && cp -R platform/eval/configs/. /out/eval-configs/ \
  && find /out/eval-tasks -name solution.patch -delete

FROM node:24.13.0-bookworm-slim
# git for the clone; ca-certificates for HTTPS to the Git host. Debian's security updates at build
# time, and no npm, npx or corepack at run time: the process runs `node` only, and npm's own
# dependencies carried CRITICAL findings (V04, design/ADR-M66 §2.6).
RUN apt-get update \
  && apt-get upgrade -y --no-install-recommends \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
  && mkdir -p /var/lib/sdlc-runner/work \
  && chown node:node /var/lib/sdlc-runner/work \
  && chmod 0700 /var/lib/sdlc-runner/work
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=root:root /out /app
COPY --from=build --chown=root:root --chmod=0755 /usr/local/bin/gitleaks /usr/local/bin/gitleaks
USER node
CMD ["node", "/app/dist/main.js"]
