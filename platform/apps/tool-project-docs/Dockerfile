# syntax=docker/dockerfile:1
# Image of the first register tool, `read_documents` (task X04 PR 3b, design/ADR-M89, ADR-M69 §2.4).
# Build context: the repo root.
#   pnpm tool-image:build project-docs          # local build, prints the image by digest
# A tenant registers the image by digest (`adlc admin tool register … --image-digest sha256:…`).
# The runner starts it as user 10001, with a read-only root, no capability and no environment value;
# the health check below is required (the runner waits for "healthy").

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
  && pnpm exec tsc -b platform/apps/tool-project-docs \
  && pnpm --filter @sdlc/tool-project-docs deploy --legacy --prod /out

FROM node:24.13.0-bookworm-slim
# Debian's security updates at build time, and no npm, npx or corepack at run time (as the other
# images, V04, design/ADR-M66 §2.6).
RUN apt-get update \
  && apt-get upgrade -y --no-install-recommends \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=root:root /out /app
LABEL org.opencontainers.image.title="sdlc tool project-docs" \
  org.opencontainers.image.licenses="MIT"
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=2s --timeout=3s --start-period=5s --retries=30 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "/app/dist/main.js"]
