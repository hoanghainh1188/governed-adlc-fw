#!/bin/sh
# Start the AuthZ plugin and enable it on the current user's Docker Engine (H07, ADR-M105).
# Works for rootless (XDG paths) and for a rootful Engine run as root (system paths).
#
# Rootless note: RootlessKit uses --copy-up=/run, so a Unix socket under $XDG_RUNTIME_DIR is not
# reliably visible to dockerd inside the namespace. The plugin listens under $HOME (shared).
# Legacy AuthZ discovery only scans /etc/docker/plugins and /usr/lib/docker/plugins; for rootless
# we write the .spec into the host /etc/docker/plugins (sudo) so the next RootlessKit start copies
# it up. Rootful lists the plugin in daemon.json; rootless uses the ExecStart flag only.
#
# Usage:
#   platform/deploy/docker-authz/scripts/enable.sh [--dist <main.js>] [--socket <path>]
#
# Does not restart dockerd when SDLC_DOCKER_AUTHZ_NO_RESTART=1 (caller restarts).
#
# Stronger sandbox runtime (task H06, ADR-M25 §2.12): SDLC_DOCKER_AUTHZ_REQUIRE_RUNTIME=runsc (or
# kata) makes the plugin refuse every create with a run's workspace volume that does not name it.
# Set it to the runner's SDLC_RUNNER_SANDBOX_RUNTIME on a rootful runner Engine.
#
# Operator key (QUESTIONS #661): the runner host's own Compose project and `openbao:bootstrap
# runner-credentials` need binds and capabilities the denylist refuses. The operator's Docker CLI
# sends the header X-Sdlc-Operator with a key; the plugin skips the denylist only for that key.
# This script makes the key once (mode 600, never printed) and adds the header to the Docker
# configuration of the user who runs it (${DOCKER_CONFIG:-$HOME/.docker}/config.json, mode 600).
# The runner never sees either file.
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
  [ -n "$socket" ] || socket="$runtime_plugins/sdlc-authz.sock"
  discovery_spec="/etc/docker/plugins/sdlc-authz.spec"
  key_file="/etc/sdlc-docker-authz/operator-key"
else
  home="${HOME:?HOME is required for rootless AuthZ}"
  config="${XDG_CONFIG_HOME:-$home/.config}"
  share="${XDG_DATA_HOME:-$home/.local/share}"
  config_plugins="$config/docker/plugins"
  daemon_json="$config/docker/daemon.json"
  # Socket under $HOME: shared with dockerd inside RootlessKit (not under copy-up /run).
  [ -n "$socket" ] || socket="$share/sdlc-docker-authz/sdlc-authz.sock"
  # Host /etc path is copy-up'd into the rootless namespace on dockerd start (needs sudo once).
  discovery_spec="/etc/docker/plugins/sdlc-authz.spec"
  key_file="$share/sdlc-docker-authz/operator-key"
fi
mkdir -p "$(dirname "$socket")" "$config_plugins" "$(dirname "$daemon_json")"

# The operator key: made once, kept on a re-run (the Docker configuration keeps matching it).
mkdir -p "$(dirname "$key_file")"
chmod 700 "$(dirname "$key_file")"
if [ ! -s "$key_file" ]; then
  (umask 077 && od -An -N32 -tx1 /dev/urandom | tr -d ' \n' >"$key_file")
fi
chmod 600 "$key_file"
# The header in this user's Docker configuration; the key is read from its file, never an argument.
docker_config_dir="${DOCKER_CONFIG:-$HOME/.docker}"
mkdir -p "$docker_config_dir"
(umask 077 && node -e '
  const fs = require("fs");
  const [keyFile, configFile] = process.argv.slice(1);
  const key = fs.readFileSync(keyFile, "utf8").trim();
  const j = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, "utf8")) : {};
  const headers = j.HttpHeaders && typeof j.HttpHeaders === "object" ? j.HttpHeaders : {};
  j.HttpHeaders = { ...headers, "X-Sdlc-Operator": key };
  fs.writeFileSync(configFile, JSON.stringify(j, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(configFile, 0o600);
' "$key_file" "$docker_config_dir/config.json")

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
Environment=SDLC_DOCKER_AUTHZ_REQUIRE_RUNTIME=${SDLC_DOCKER_AUTHZ_REQUIRE_RUNTIME:-}
ExecStart=$(command -v node) $dist --socket $socket --operator-key-file $key_file
Restart=on-failure

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now sdlc-docker-authz.service
else
  nohup node "$dist" --socket "$socket" --operator-key-file "$key_file" \
    >/tmp/sdlc-docker-authz.log 2>&1 &
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

# Spec file: name sdlc-authz → unix socket. Also keep a copy under the user config tree.
printf 'unix://%s\n' "$socket" >"$config_plugins/sdlc-authz.spec"
if [ "$uid" -eq 0 ]; then
  mkdir -p "$(dirname "$discovery_spec")"
  cp "$config_plugins/sdlc-authz.spec" "$discovery_spec"
else
  # Rootless: dockerd only scans /etc/docker/plugins (copy-up from the host). runner-host-setup.sh
  # (V18) writes the spec as root first, so a runner user without sudo finds it in place.
  if cmp -s "$config_plugins/sdlc-authz.spec" "$discovery_spec"; then
    :
  elif [ -w /etc/docker/plugins ] 2>/dev/null || mkdir -p /etc/docker/plugins 2>/dev/null; then
    cp "$config_plugins/sdlc-authz.spec" "$discovery_spec"
  elif command -v sudo >/dev/null; then
    sudo mkdir -p /etc/docker/plugins
    sudo cp "$config_plugins/sdlc-authz.spec" "$discovery_spec"
  else
    echo "enable: cannot write $discovery_spec (need sudo for rootless AuthZ discovery)" >&2
    exit 1
  fi
fi

# Enable AuthZ on the Engine. Docker refuses the same directive from both a flag and
# daemon.json ("specified both as a flag and in the configuration file").
# - Rootful: list the plugin by name in daemon.json only.
# - Rootless: pass --authorization-plugin on dockerd ExecStart only. daemon.json alone can
#   show the plugin in `docker info` while the live AuthZ chain stays empty after some
#   rootless restarts; the CLI flag forces the chain to load sdlc-authz (H07 AC3). Always
#   strip sdlc-authz from daemon.json on rootless so a prior enable run cannot conflict.
if [ "$uid" -eq 0 ]; then
  node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const j = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
    const prev = Array.isArray(j["authorization-plugins"]) ? j["authorization-plugins"] : [];
    // Drop prior absolute-socket entries from older enable.sh; keep other named plugins.
    const next = prev.filter((id) => typeof id === "string" && !id.includes("/") && id !== "sdlc-authz");
    next.push("sdlc-authz");
    j["authorization-plugins"] = next;
    fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
  ' "$daemon_json"
else
  if [ -f "$daemon_json" ]; then
    node -e '
      const fs = require("fs");
      const p = process.argv[1];
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      const prev = Array.isArray(j["authorization-plugins"]) ? j["authorization-plugins"] : [];
      const next = prev.filter((id) => id !== "sdlc-authz");
      if (next.length === 0) delete j["authorization-plugins"];
      else j["authorization-plugins"] = next;
      fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
    ' "$daemon_json"
  fi
  if command -v systemctl >/dev/null; then
    drop_in="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/docker.service.d"
    mkdir -p "$drop_in"
    # Read the unit file itself (not merged drop-ins) so ExecStart= resets do not yield an empty line.
    frag=$(systemctl --user show docker.service -p FragmentPath --value 2>/dev/null || true)
    exec_line=""
    if [ -n "$frag" ] && [ -f "$frag" ]; then
      exec_line=$(sed -n 's/^ExecStart=//p' "$frag" | head -1)
    fi
    if [ -n "$exec_line" ]; then
      printf '%s\n' '[Service]' 'ExecStart=' "ExecStart=$exec_line --authorization-plugin=sdlc-authz" \
        >"$drop_in/sdlc-authz.conf"
      systemctl --user daemon-reload
    fi
  fi
fi

if [ "${SDLC_DOCKER_AUTHZ_NO_RESTART:-}" != "1" ]; then
  if [ "$uid" -eq 0 ]; then
    systemctl restart docker.service 2>/dev/null || service docker restart
  else
    systemctl --user restart docker.service
  fi
fi

echo "enable: sdlc-authz on $socket (spec $discovery_spec)"
