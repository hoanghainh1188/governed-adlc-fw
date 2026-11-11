# syntax=docker/dockerfile:1
# Optional image of the Docker AuthZ plugin (H07, ADR-M105 §2.3). Build context: the repo root.
#   docker build -f platform/deploy/docker-authz/Dockerfile -t sdlc-docker-authz .
#
# The plugin runs as a host process on the runner Engine, never as a container of that Engine
# (chicken-egg with --authorization-plugin). Operators may extract `/app` onto the host, or run
# `node platform/deploy/docker-authz/dist/main.js` after `pnpm build`. Not one of the six platform
# Compose images in images.lock.
FROM node:24.13.0-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json .npmrc ./
COPY platform/deploy/docker-authz platform/deploy/docker-authz
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @sdlc/docker-authz... \
  && pnpm exec tsc -b platform/deploy/docker-authz

FROM node:24.13.0-bookworm-slim
WORKDIR /app
COPY --from=build /repo/platform/deploy/docker-authz/dist ./dist
USER node
ENV SDLC_DOCKER_AUTHZ_SOCKET=/run/docker/plugins/sdlc-authz.sock
ENTRYPOINT ["node", "dist/main.js"]
