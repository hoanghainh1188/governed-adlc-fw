#!/bin/sh
# Start the AuthZ plugin and enable it on the current user's Docker Engine (H07, ADR-M105).
# Works for rootless (XDG paths) and for a rootful Engine run as root (system paths).
#
# Usage:
#   platform/deploy/docker-authz/scripts/enable.sh [--dist <main.js>] [--socket <path>]
#
# Does not restart dockerd when SDLC_DOCKER_AUTHZ_NO_RESTART=1 (caller restarts).
set -eu

root="$(cd "$(dirname "$0")/../../../.." && pwd)"
dist="$root/platform/deploy/docker-authz/dist/main.js"
socket=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dist) dist="$2"; shift 2 ;;
    --socket) socket="$2"; shift 2 ;;
    *) echo "enable: unknown argument $1" >&2; exit 2 ;;
  esac
done

[ -f "$dist" ] || {
  echo "enable: missing $dist — run pnpm build first" >&2
  exit 1
}
command -v node >/dev/null || {
  echo "enable: node is required" >&2
  exit 1
}

uid="$(id -u)"
if [ "$uid" -eq 0 ]; then
  runtime_plugins="/run/docker/plugins"
  config_plugins="/etc/docker/plugins"
  daemon_json="/etc/docker/daemon.json"
else
  runtime="${XDG_RUNTIME_DIR:-/run/user/$uid}"
  config="${XDG_CONFIG_HOME:-$HOME/.config}"
  runtime_plugins="$runtime/docker/plugins"
  config_plugins="$config/docker/plugins"
  daemon_json="$config/docker/daemon.json"
fi
[ -n "$socket" ] || socket="$runtime_plugins/sdlc-authz.sock"
mkdir -p "$runtime_plugins" "$config_plugins" "$(dirname "$daemon_json")"

# Stop a previous plugin on the same socket.
if [ -S "$socket" ]; then
  # Best effort: only our process listens here in CI / install.
  pkill -f "sdlc-docker-authz|docker-authz/dist/main.js" 2>/dev/null || true
  rm -f "$socket"
fi

# Start the plugin in the background when no systemd user session is managing it (CI).
if [ "${SDLC_DOCKER_AUTHZ_SYSTEMD:-}" = "1" ] && command -v systemctl >/dev/null; then
  unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$unit_dir"
  cat >"$unit_dir/sdlc-docker-authz.service" <<EOF
[Unit]
Description=SDLC Docker AuthZ plugin (ADR-M105)
Before=docker.service

[Service]
Type=simple
Environment=SDLC_DOCKER_AUTHZ_SOCKET=$socket
ExecStart=$(command -v node) $dist --socket $socket
Restart=on-failure

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now sdlc-docker-authz.service
else
  nohup node "$dist" --socket "$socket" >/tmp/sdlc-docker-authz.log 2>&1 &
  echo $! >/tmp/sdlc-docker-authz.pid
fi

waited=0
until [ -S "$socket" ]; do
  [ "$waited" -lt 30 ] || {
    echo "enable: plugin socket not ready at $socket" >&2
    [ -f /tmp/sdlc-docker-authz.log ] && cat /tmp/sdlc-docker-authz.log >&2 || true
    exit 1
  }
  sleep 1
  waited=$((waited + 1))
done

# Spec file for discovery by name; daemon.json also lists the absolute socket so rootless
# Engines do not depend on /run/docker/plugins inside the user namespace (ADR-M105).
printf 'unix://%s\n' "$socket" >"$config_plugins/sdlc-authz.spec"

if [ -f "$daemon_json" ]; then
  node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const sock = process.argv[2];
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    const list = Array.isArray(j["authorization-plugins"]) ? j["authorization-plugins"] : [];
    for (const id of ["sdlc-authz", sock]) {
      if (!list.includes(id)) list.push(id);
    }
    j["authorization-plugins"] = list;
    fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
  ' "$daemon_json" "$socket"
else
  node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const sock = process.argv[2];
    fs.writeFileSync(p, JSON.stringify({ "authorization-plugins": ["sdlc-authz", sock] }, null, 2) + "\n");
  ' "$daemon_json" "$socket"
fi

if [ "${SDLC_DOCKER_AUTHZ_NO_RESTART:-}" != "1" ]; then
  if [ "$uid" -eq 0 ]; then
    systemctl restart docker.service 2>/dev/null || service docker restart
  else
    systemctl --user restart docker.service
  fi
fi

echo "enable: sdlc-authz on $socket (spec $config_plugins/sdlc-authz.spec)"
