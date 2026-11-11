#!/bin/sh
# Sets up the runner host: the runner's own rootless Docker Engine (D-08 V18, design/ADR-M107;
# deploy README "The runner on its own Docker Engine", steps 1, 2 and 5). Runs as root, on the
# runner host: a separate VM, or the platform's server for a second user.
#
#   1. Docker's packages: checked, never installed (QUESTIONS #672).
#   2. The Engine's steps (rootless-engine.sh, the same code as the CI job `runner-rootless`):
#      subordinate IDs, the AppArmor profile for rootlesskit only, cgroup v2 delegation, linger,
#      `dockerd-rootless-setuptool.sh install`, the check of `docker info`.
#   3. The AuthZ plugin (H07, ADR-M105): install-rootless.sh as the user, with its operator key.
#   4. On the same server: the dummy interface `sdlc-link` with the link address (systemd-networkd).
#   5. The runner host's .env (runner-host.sh env, then only its empty keys).
#
# Safe to run again: each step checks the state first and says what is already done. --dry-run
# changes nothing. A file or an .env key that already holds another value is refused before
# anything changes, never overwritten. It never sets kernel.apparmor_restrict_unprivileged_userns=0,
# never touches the machine's own (rootful) Engine and refuses an Engine that holds the platform's
# data. It holds and prints no secret. WireGuard on a VM stays the infrastructure operator's job.
#
# Usage: sudo platform/deploy/scripts/runner-host-setup.sh --user <user> --mode same-server|vm
#          [--link-addr <IPv4>] [--project <name>] [--ca-file <path>] [--bin <folder>] [--dry-run]
#   --user       the user that runs the runner's Engine (for example sdlc-runner); it must exist
#                and own this checkout
#   --mode       same-server: a second Engine on the platform's server, linked by a dummy interface
#                vm: a separate VM, linked by WireGuard (set up by the infrastructure operator)
#   --link-addr  the platform host's link address (the same server: the dummy interface's address;
#                a VM: the platform host's WireGuard address); required for same-server
#   --project    COMPOSE_PROJECT_NAME of the platform (default: the .env template's)
#   --ca-file    where OpenBao's ca.pem is on this host (SDLC_OPENBAO_CA_FILE)
#   --bin        the folder of rootlesskit and dockerd-rootless-setuptool.sh (default: from PATH)
#
# Environment (tests only): SDLC_HOST_ROOT, the host's root folder for the files it reads and writes.
set -eu

script_dir="$(cd "$(dirname "$0")" && pwd)"
deploy_dir="$(cd "$script_dir/.." && pwd)"
host_dir="$deploy_dir/runner-host"
env_file="$host_dir/.env"
env_example="$host_dir/.env.example"
authz_dir="$deploy_dir/docker-authz"

. "$script_dir/rootless-engine.sh"
RE_TAG=runner-host-setup
RE_ROOT="${SDLC_HOST_ROOT:-}"

usage="usage: runner-host-setup.sh --user <user> --mode same-server|vm [--link-addr <IPv4>] [--project <name>] [--ca-file <path>] [--bin <folder>] [--dry-run]"
user=""
mode=""
link_addr=""
project=""
ca_file=""
bin=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --user | --mode | --link-addr | --project | --ca-file | --bin)
      [ "$#" -ge 2 ] || re_fail "$1 needs a value; $usage"
      case "$1" in
        --user) user="$2" ;;
        --mode) mode="$2" ;;
        --link-addr) link_addr="$2" ;;
        --project) project="$2" ;;
        --ca-file) ca_file="$2" ;;
        --bin) bin="$2" ;;
      esac
      shift 2
      ;;
    --dry-run)
      RE_DRY_RUN=1
      shift
      ;;
    *) re_fail "unknown argument $1; $usage" ;;
  esac
done

# --- Checks before any change ---------------------------------------------------------------

[ -n "$user" ] || re_fail "--user is required; $usage"
[ "$user" != root ] || re_fail "--user root: the runner's Engine runs rootless, as its own user"
case "$mode" in
  same-server | vm) ;;
  *) re_fail "--mode must be same-server or vm; $usage" ;;
esac
if [ -n "$link_addr" ] && ! printf '%s\n' "$link_addr" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; then
  re_fail "--link-addr must be an IPv4 address without a prefix (for example 10.203.0.1)"
fi
[ "$mode" = vm ] || [ -n "$link_addr" ] ||
  re_fail "--mode same-server needs --link-addr (the dummy interface's address, for example 10.203.0.1)"
case "$project" in
  '' | [a-z0-9]*) ;;
  *) re_fail "--project must be a Compose project name (lower-case letters, digits, - and _)" ;;
esac
if [ "$RE_DRY_RUN" != 1 ] && [ "$(id -u)" -ne 0 ]; then
  re_fail "run it as root (sudo), or add --dry-run"
fi

entry="$(getent passwd "$user" || true)"
[ -n "$entry" ] ||
  re_fail "no user $user; create it first: sudo useradd --create-home --shell /bin/bash $user"
RE_USER="$user"
RE_UID="$(printf '%s\n' "$entry" | cut -d: -f3)"

# Docker's packages: checked, never installed (QUESTIONS #672).
missing=""
need() { command -v "$1" >/dev/null 2>&1 || missing="$missing $2"; }
need dockerd docker-ce
need docker docker-ce-cli
need dockerd-rootless-setuptool.sh docker-ce-rootless-extras
need rootlesskit docker-ce-rootless-extras
need newuidmap uidmap
need newgidmap uidmap
need node "Node.js (for the AuthZ plugin)"
[ -e "$RE_ROOT/usr/lib/systemd/user/dbus.socket" ] || missing="$missing dbus-user-session"
if [ -n "$missing" ]; then
  re_fail "install these packages first (this command installs none):$(printf '%s\n' $missing | sort -u | tr '\n' ' ' | sed 's/ $//; s/^/ /')"
fi
if [ -z "$bin" ]; then
  bin="$(dirname "$(command -v dockerd-rootless-setuptool.sh)")"
fi
[ -x "$bin/rootlesskit" ] && [ -x "$bin/dockerd-rootless-setuptool.sh" ] ||
  re_fail "$bin holds no rootlesskit and dockerd-rootless-setuptool.sh (--bin)"
RE_BIN="$(cd "$bin" && pwd)"

re_as_user test -w "$host_dir" ||
  re_fail "$user cannot write $host_dir: the checkout must belong to $user (deploy README, runner step 5)"

# The .env keys, refused before anything changes when one holds another value.
env_get() { [ -f "$1" ] && sed -n "s/^$2=//p" "$1" | tail -n 1; }
env_keys="SDLC_DOCKER_SOCKET=$(re_socket)"
[ -z "$link_addr" ] || env_keys="$env_keys SDLC_RUNNER_LINK_ADDR=$link_addr"
[ -z "$project" ] || env_keys="$env_keys COMPOSE_PROJECT_NAME=$project"
[ -z "$ca_file" ] || env_keys="$env_keys SDLC_OPENBAO_CA_FILE=$ca_file"
env_set=""
for pair in $env_keys; do
  key="${pair%%=*}"
  value="${pair#*=}"
  template="$(env_get "$env_example" "$key" || true)"
  if [ -f "$env_file" ]; then current="$(env_get "$env_file" "$key" || true)"; else current="$template"; fi
  if [ "$current" = "$value" ]; then continue; fi
  if [ -n "$current" ] && [ "$current" != "$template" ]; then
    re_fail "$env_file: $key already holds another value; check it and change it by hand, then run again"
  fi
  env_set="$env_set $pair"
done

# The same server: the dummy interface's files, refused before anything changes.
link_netdev="$RE_ROOT/etc/systemd/network/50-sdlc-link.netdev"
link_network="$RE_ROOT/etc/systemd/network/50-sdlc-link.network"
netdev_text="[NetDev]
Name=sdlc-link
Kind=dummy"
network_text="[Match]
Name=sdlc-link

[Network]
Address=$link_addr/32"
link_up() { ip -4 -o addr show dev sdlc-link 2>/dev/null | grep -q " $link_addr/32 "; }
if [ "$mode" = same-server ]; then
  for pair in "$link_netdev|$netdev_text" "$link_network|$network_text"; do
    file="${pair%%|*}"
    if [ -f "$file" ] && [ "$(cat "$file")" != "${pair#*|}" ]; then
      re_fail "$file already holds other settings (another link address?); check it, then run again"
    fi
  done
  if ! link_up && ! systemctl is-active --quiet systemd-networkd; then
    re_fail "systemd-networkd is not running: create the dummy interface by hand (deploy README, runner step 2)"
  fi
fi

[ "$RE_DRY_RUN" != 1 ] || re_say "dry run: nothing changes"

# --- The runner's Engine (rootless-engine.sh) -------------------------------------------------

re_subids
re_apparmor
re_delegate
re_linger
re_engine
re_check

# --- The AuthZ plugin (H07): its discovery file as root, the rest as the user ------------------

home="$(printf '%s\n' "$entry" | cut -d: -f6)"
re_put "$RE_ROOT/etc/docker/plugins/sdlc-authz.spec" \
  "unix://$home/.local/share/sdlc-docker-authz/sdlc-authz.sock" "AuthZ plugin discovery file"
re_authz "$authz_dir/scripts/install-rootless.sh" "$authz_dir/dist/main.js"

# --- The same server: the link address on a dummy interface -----------------------------------

if [ "$mode" = same-server ]; then
  if link_up; then
    re_say "link address $link_addr on sdlc-link: already done"
  else
    re_put "$link_netdev" "$netdev_text" "dummy interface sdlc-link"
    re_put "$link_network" "$network_text" "link address $link_addr on sdlc-link"
    re_change "reload systemd-networkd" networkctl reload
    if [ "$RE_DRY_RUN" != 1 ]; then
      re_wait 10 link_up || re_fail "sdlc-link has no address $link_addr/32 after networkctl reload"
    fi
  fi
fi

# --- The runner host's .env ---------------------------------------------------------------------

if [ ! -f "$env_file" ]; then
  if [ "$RE_DRY_RUN" = 1 ]; then
    re_say "would: write $env_file (runner-host.sh env)"
  else
    re_as_user sh "$script_dir/runner-host.sh" env
  fi
fi
if [ -z "$env_set" ]; then
  re_say "$env_file: already done"
elif [ "$RE_DRY_RUN" = 1 ]; then
  re_say "would: set in $env_file:$(printf ' %s' $env_set | sed 's/=[^ ]*//g')"
else
  text="$(cat "$env_file")"
  for pair in $env_set; do
    text="$(printf '%s\n' "$text" | awk -v k="${pair%%=*}" -v v="${pair#*=}" \
      'index($0, k "=") == 1 { print k "=" v; found = 1; next } { print } END { if (!found) print k "=" v }')"
  done
  printf '%s\n' "$text" | re_as_user sh -c 'cat >"$1"' sh "$env_file"
  re_say "set in $env_file:$(printf ' %s' $env_set | sed 's/=[^ ]*//g')"
fi

# --- What stays by hand -------------------------------------------------------------------------

re_say "done. Still by hand (deploy README \"The runner on its own Docker Engine\"):"
[ "$mode" = same-server ] ||
  re_say "- the WireGuard tunnel to the platform host (the infrastructure operator), step 2"
[ -n "$link_addr" ] || re_say "- SDLC_RUNNER_LINK_ADDR in $env_file, step 5"
ca_now="$(env_get "$env_file" SDLC_OPENBAO_CA_FILE || true)"
[ -f "$RE_ROOT${ca_now:-/nonexistent}" ] ||
  re_say "- OpenBao's ca.pem (a public certificate, never its key) at ${ca_now:-SDLC_OPENBAO_CA_FILE}, step 5"
re_say "- on the platform host: steps 3, 4 and 6 (pnpm server:setup with runner_link does them)"
re_say "- then, as $user: platform/deploy/scripts/runner-host.sh up, step 7"
