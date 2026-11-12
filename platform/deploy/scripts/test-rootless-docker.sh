#!/bin/sh
# Starts a rootless Docker Engine for the current user, next to the machine's own Engine
# (task O01, design/ADR-M91 §2.4). CI only: the job `runner-rootless` runs `pnpm test:runner` on it.
# The steps are the server's (deploy README "The runner on its own Docker Engine", step 1), from
# the same code as `runner-host-setup.sh` (rootless-engine.sh, D-08 V18): subordinate IDs, an
# AppArmor profile for RootlessKit, cgroup delegation, linger, `dockerd-rootless-setuptool.sh
# install` as a systemd user service, the check of `docker info`, the AuthZ plugin.
#
# Usage: platform/deploy/scripts/test-rootless-docker.sh <folder>
#   <folder>: the static Docker archives unpacked flat (dockerd, rootlesskit,
#   dockerd-rootless-setuptool.sh, …), pinned by SHA-256 in .github/workflows/ci.yml.
# Needs sudo, uidmap, slirp4netns and dbus-user-session. Writes DOCKER_HOST to $GITHUB_ENV when set.
set -eu

bin="$(cd "${1:?usage: test-rootless-docker.sh <folder with dockerd and rootlesskit>}" && pwd)"
user="$(id -un)"
uid="$(id -u)"

# Keep the pre-rootless Engine for throw-away test DBs. AuthZ on the rootless Engine refuses
# binds and port bindings (H07 denylist); test-db.sh needs both for postgres init + host port.
if [ -z "${SDLC_TEST_DB_DOCKER_HOST:-}" ]; then
  SDLC_TEST_DB_DOCKER_HOST="${DOCKER_HOST:-unix:///var/run/docker.sock}"
fi
export SDLC_TEST_DB_DOCKER_HOST

# The steps of the server set-up (runner-host-setup.sh), from the shared step code (V18, ADR-M107).
. "$(cd "$(dirname "$0")" && pwd)/rootless-engine.sh"
RE_TAG=test-rootless-docker
RE_USER="$user"
RE_UID="$uid"
RE_BIN="$bin"
re_subids
re_apparmor
re_delegate
re_linger

# CI only: prefer the containerd image store so local builds have RepoDigests. AuthZ refuses
# publishing a throw-away registry port (buildFixtureImage under H07).
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/docker"
daemon_json="${XDG_CONFIG_HOME:-$HOME/.config}/docker/daemon.json"
if [ -f "$daemon_json" ]; then
  node -e 'const fs=require("fs"); const p=process.argv[1]; const j=JSON.parse(fs.readFileSync(p,"utf8")); j.features={...(j.features||{}), "containerd-snapshotter": true}; fs.writeFileSync(p, JSON.stringify(j,null,2)+"\n");' "$daemon_json"
else
  printf '%s\n' '{"features":{"containerd-snapshotter":true}}' >"$daemon_json"
fi

re_engine
re_check
socket="$(re_socket)"

# The AuthZ plugin for create bodies (H07, ADR-M105), started in the background (enable.sh; a
# server uses install-rootless.sh, a systemd user service). Skip with SDLC_DOCKER_AUTHZ=0 (local
# debugging only).
repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
authz_main="$repo_root/platform/deploy/docker-authz/dist/main.js"
if [ "${SDLC_DOCKER_AUTHZ:-1}" != "0" ]; then
  if [ ! -f "$authz_main" ]; then
    (cd "$repo_root" && pnpm exec tsc -b platform/deploy/docker-authz)
  fi
  re_authz "$repo_root/platform/deploy/docker-authz/scripts/enable.sh" "$authz_main"
  # Boot probe (H07 AC3): AuthZ must deny privileged create before image resolution (403), not
  # fall through to "No such image" (404). Fail the Engine setup early with plugin diagnostics.
  probe_name="sdlc-authz-boot-$$"
  probe_code=$(
    DOCKER_HOST="unix://$socket" docker info --format '{{json .Plugins.Authorization}}' 2>/dev/null || echo 'null'
  )
  echo "test-rootless-docker: Authorization plugins: $probe_code"
  probe_status=$(
    curl -sS -o /tmp/sdlc-authz-boot.out -w '%{http_code}' --unix-socket "$socket" \
      -H 'Content-Type: application/json' \
      -d '{"Image":"busybox:1.37.0","HostConfig":{"Privileged":true}}' \
      "http://localhost/v1.44/containers/create?name=$probe_name" || echo '000'
  )
  if [ "$probe_status" != "403" ]; then
    echo "test-rootless-docker: AuthZ boot probe expected HTTP 403, got $probe_status" >&2
    echo "test-rootless-docker: body: $(cat /tmp/sdlc-authz-boot.out 2>/dev/null)" >&2
    [ -f /tmp/sdlc-docker-authz.log ] && cat /tmp/sdlc-docker-authz.log >&2 || true
    XDG_RUNTIME_DIR="$(re_runtime)" journalctl --user -u docker.service --no-pager -n 80 >&2 || true
    exit 1
  fi
  echo "test-rootless-docker: sdlc-authz enabled (privileged create → 403)"
fi

if [ -n "${GITHUB_ENV:-}" ]; then
  echo "DOCKER_HOST=unix://$socket" >>"$GITHUB_ENV"
  echo "SDLC_TEST_DB_DOCKER_HOST=$SDLC_TEST_DB_DOCKER_HOST" >>"$GITHUB_ENV"
fi
echo "DOCKER_HOST=unix://$socket"
echo "SDLC_TEST_DB_DOCKER_HOST=$SDLC_TEST_DB_DOCKER_HOST"
