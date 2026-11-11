# syntax=docker/dockerfile:1
# Sandbox image "node24" (task C04, design/ADR-M25 §2.9, QUESTIONS #59 option A): the pinned
# OpenHands Agent Server (ADR-M10 §2.1) plus the toolchain of Node.js projects such as the sample
# repo pilot-order-inventory (Vue + NestJS, D-09 §5). Build and push: platform/sandbox-images/build.sh.
# A project uses it through its configuration, always by digest:
#   sandbox:
#     image: localhost:5000/sdlc/sandbox-node24@sha256:<digest printed by build.sh>
#
# Image contract (ADR-M25 §2.3): /workspace owned by 10001:10001, a HEALTHCHECK that passes when
# the Agent Server is ready, user 10001. The runner adds the hardening (read-only root, no
# capabilities, per-run internal network) and the package proxy address; nothing secret is baked in.
FROM ghcr.io/openhands/agent-server:1.48.0-python-slim@sha256:8fcfab2dedb4b41b6aef219b9fa9b1f2588033fad3d998ae6aa11fe8c4fcf8b7

USER root
# Node.js 24 and corepack come with the pinned base image (Node 24.21.0, corepack 0.36.0 in
# 1.48.0). The build fails if a new base ever ships another Node major.
# - `corepack enable pnpm` installs the pnpm shim. Corepack downloads the pnpm version that a
#   project pins in `packageManager` through COREPACK_NPM_REGISTRY, which the runner sets to the
#   package proxy (Verdaccio) at run time; the sandbox has no other way out.
# - COREPACK_HOME and the npm cache live on the sandbox's tmpfs: the root filesystem is read-only.
# - The base image's empty /workspace/project is removed: the workspace is the repository itself.
# - Chromium and the VS Code server are removed. The browser tool is not allowed at L2 (ADR-M10
#   §4.1) and VS Code is disabled in every sandbox (OH_ENABLE_VSCODE=false, ADR-M25 §2.4). They
#   carried most CRITICAL findings of the base image and most GPL/LGPL packages (Harry,
#   2026-09-27, C04 session 3). Two findings without a fix stay listed in .trivyignore.
# - uv and uvx are removed: the sandbox reaches only the npm package proxy, so they could never
#   fetch a Python package there, and the base's build of uv carries the zip crate 8.x
#   (CVE-2026-115905, release scan of v0.8.0, PR #466).
# - libbrotli1 is upgraded to Debian's fixed package (CVE-2026-111497, the same scan) from the
#   dated Debian security snapshot of 2026-10-27; the base reads a snapshot of 2026-09-13. The extra
#   source is removed again. linux-libc-dev comes from the same snapshot (6.12.113-1,
#   CVE-2026-98432, found by the image scan on 2026-11-11, PR #502). Remove this step when the
#   pinned base image ships both fixes.
# - The Agent Server keeps its own state (conversations, bash events) under the relative path
#   `workspace/…` of its working directory by default. The runner starts the sandbox in
#   /workspace, which is the repository, so the state would show up as changed files. The OH_*
#   paths below move it to the home tmpfs.
RUN node --version | grep -Eq '^v24\.' \
  && dpkg --purge chromium chromium-common \
  && rm -rf /openhands/.openvscode-server \
  && rm -f /usr/bin/uv /usr/bin/uvx \
  && printf '%s\n' 'Types: deb' \
       'URIs: http://snapshot.debian.org/archive/debian-security/20261027T000000Z/' \
       'Suites: trixie-security' 'Components: main' \
       'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' 'Check-Valid-Until: no' \
       > /etc/apt/sources.list.d/sdlc-security-fix.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends --only-upgrade libbrotli1=1.1.0-2+deb13u1 \
       linux-libc-dev=6.12.113-1 \
  && rm -f /etc/apt/sources.list.d/sdlc-security-fix.sources \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable pnpm \
  && rm -rf /workspace/project \
  && chown 10001:10001 /workspace \
  && chmod 0755 /workspace
ENV COREPACK_HOME=/tmp/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_ENABLE_AUTO_PIN=0 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    OH_CONVERSATIONS_PATH=/home/openhands/.openhands/conversations \
    OH_BASH_EVENTS_DIR=/home/openhands/.openhands/bash_events \
    OH_WORKSPACE_PATH=/workspace \
    CHROME_BIN= \
    PUPPETEER_EXECUTABLE_PATH=

# X03 (ADR-M68 §7): the adapter that drives this image's agent server, and its version. The runner
# refuses a run whose agent names another adapter (`adapter_mismatch`).
LABEL sdlc.agent.adapter=openhands \
      sdlc.agent.version=1.48.0

USER 10001:10001
# The Agent Server answers /ready once it can take a conversation (ADR-M10 §2.2: 4.5–6.8 s).
HEALTHCHECK --interval=2s --timeout=3s --start-period=5s --retries=60 \
  CMD ["curl", "-fsS", "-o", "/dev/null", "http://127.0.0.1:8000/ready"]
