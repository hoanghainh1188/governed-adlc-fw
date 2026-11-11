#!/bin/sh
# Starts a rootless Docker Engine for the current user, next to the machine's own Engine
# (task O01, design/ADR-M91 §2.4). CI only: the job `runner-rootless` runs `pnpm test:runner` on it.
# The steps are the ones of the server set-up (deploy README "The runner on its own Docker
# Engine"): subordinate IDs, an AppArmor profile for RootlessKit, cgroup delegation, then
# `dockerd-rootless-setuptool.sh install` as a systemd user service.
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

# 1. Subordinate user and group IDs for the user namespace.
if ! grep -q "^$user:" /etc/subuid || ! grep -q "^$user:" /etc/subgid; then
  sudo usermod --add-subuids 200000-265535 --add-subgids 200000-265535 "$user"
fi

# 2. Ubuntu 23.10 and later restrict unprivileged user namespaces with AppArmor: allow them for
#    this RootlessKit binary only, never for the whole machine.
if [ -f /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then
  profile=/etc/apparmor.d/sdlc-rootlesskit
  sudo tee "$profile" >/dev/null <<EOF
abi <abi/4.0>,
include <tunables/global>

"$bin/rootlesskit" flags=(unconfined) {
  userns,
  include if exists <local/sdlc-rootlesskit>
}
EOF
  sudo apparmor_parser -r "$profile"
fi

# 3. cgroup v2 delegation of cpu, cpuset, io, memory and pids to user services. Without cpu, a
#    rootless Engine cannot apply the sandbox's CPU limit (ADR-M25 §2.4).
sudo mkdir -p /etc/systemd/system/user@.service.d
printf '[Service]\nDelegate=cpu cpuset io memory pids\n' |
  sudo tee /etc/systemd/system/user@.service.d/delegate.conf >/dev/null
sudo systemctl daemon-reload

# 4. The user's own systemd, started after the delegation so it gets every controller.
sudo systemctl stop "user@$uid.service" 2>/dev/null || true
sudo loginctl enable-linger "$user"
sudo systemctl start "user@$uid.service"
export XDG_RUNTIME_DIR="/run/user/$uid"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
waited=0
until [ -S "$XDG_RUNTIME_DIR/bus" ]; do
  [ "$waited" -lt 30 ] || { echo "test-rootless-docker: no user D-Bus at $XDG_RUNTIME_DIR/bus" >&2; exit 1; }
  sleep 1
  waited=$((waited + 1))
done
controllers="/sys/fs/cgroup/user.slice/user-$uid.slice/user@$uid.service/cgroup.controllers"
for controller in cpu memory pids; do
  grep -qw "$controller" "$controllers" || {
    echo "test-rootless-docker: controller $controller is not delegated ($(cat "$controllers"))" >&2
    exit 1
  }
done

# 5. The rootless Engine as a systemd user service. --force: the machine's own (rootful) Engine
#    keeps running; the two never share containers, networks or volumes.
PATH="$bin:$PATH" "$bin/dockerd-rootless-setuptool.sh" install --force

socket="$XDG_RUNTIME_DIR/docker.sock"
waited=0
until DOCKER_HOST="unix://$socket" docker info >/dev/null 2>&1; do
  [ "$waited" -lt 60 ] || {
    echo "test-rootless-docker: the rootless Engine did not start" >&2
    journalctl --user -u docker.service --no-pager -n 100 >&2 || true
    exit 1
  }
  sleep 1
  waited=$((waited + 1))
done

# 6. Fail early unless it is really rootless, with cgroup v2 and the systemd cgroup driver.
info="$(DOCKER_HOST="unix://$socket" docker info --format '{{.SecurityOptions}} cgroup={{.CgroupVersion}} driver={{.CgroupDriver}} version={{.ServerVersion}}')"
echo "test-rootless-docker: $info"
case "$info" in
  *rootless*cgroup=2\ driver=systemd*) ;;
  *) echo "test-rootless-docker: not a rootless Engine with cgroup v2 and systemd" >&2; exit 1 ;;
esac

# 7. AuthZ plugin for create bodies (H07, ADR-M105). Starts the plugin, writes the .spec and
#    rootless ExecStart flag (not daemon.json — Docker rejects both), restarts dockerd.
#    Skip when SDLC_DOCKER_AUTHZ=0 (local debugging only).
repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
authz_main="$repo_root/platform/deploy/docker-authz/dist/main.js"
if [ "${SDLC_DOCKER_AUTHZ:-1}" != "0" ]; then
  if [ ! -f "$authz_main" ]; then
    (cd "$repo_root" && pnpm exec tsc -b platform/deploy/docker-authz)
  fi
  [ -f "$authz_main" ] || {
    echo "test-rootless-docker: AuthZ plugin dist missing at $authz_main" >&2
    exit 1
  }
  export XDG_RUNTIME_DIR="/run/user/$uid"
  export DOCKER_HOST="unix://$socket"
  sh "$repo_root/platform/deploy/docker-authz/scripts/enable.sh" --dist "$authz_main"
  waited=0
  until DOCKER_HOST="unix://$socket" docker info >/dev/null 2>&1; do
    [ "$waited" -lt 60 ] || {
      echo "test-rootless-docker: dockerd did not come back after AuthZ enable" >&2
      journalctl --user -u docker.service --no-pager -n 100 >&2 || true
      exit 1
    }
    sleep 1
    waited=$((waited + 1))
  done
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
    journalctl --user -u docker.service --no-pager -n 80 >&2 || true
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
