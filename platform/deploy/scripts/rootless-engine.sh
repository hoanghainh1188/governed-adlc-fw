# The steps of a rootless Docker Engine for one user (D-08 V18, design/ADR-M107; deploy README
# "The runner on its own Docker Engine", step 1). Sourced, never run: `runner-host-setup.sh` uses
# it on a server, `test-rootless-docker.sh` in the CI jobs `runner-rootless` and `runner-split`, so
# the two keep one sequence.
#
# Each step checks the state first and says what is already done. A file that already holds other
# content is refused, never overwritten. It never sets
# kernel.apparmor_restrict_unprivileged_userns=0 and never touches the machine's own (rootful)
# Engine.
#
# The caller sets, before it calls a step:
#   RE_TAG      message prefix
#   RE_USER     the user that runs the Engine; RE_UID its numeric ID
#   RE_BIN      the folder with rootlesskit and dockerd-rootless-setuptool.sh
#   RE_DRY_RUN  1: say what would change, change nothing (default 0)
#   RE_ROOT     the host's root folder for the files it reads and writes (default empty; tests only)

RE_DRY_RUN="${RE_DRY_RUN:-0}"
RE_ROOT="${RE_ROOT:-}"
RE_CHANGED=0

re_say() { echo "$RE_TAG: $*"; }
re_fail() {
  echo "$RE_TAG: $*" >&2
  exit 1
}
re_runtime() { echo "/run/user/$RE_UID"; }
re_socket() { echo "$(re_runtime)/docker.sock"; }

# A command as root: directly when this process is root, else through sudo.
re_as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi
}

# A command as the Engine's user, with its systemd user session and the Engine's binaries.
re_as_user() {
  set -- env XDG_RUNTIME_DIR="$(re_runtime)" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=$(re_runtime)/bus" \
    DOCKER_HOST="unix://$(re_socket)" PATH="$RE_BIN:$PATH" "$@"
  if [ "$(id -u)" -eq "$RE_UID" ]; then "$@"; else sudo -u "$RE_USER" -H "$@"; fi
}

# Runs a change as root, or only says it in a dry run.
re_change() {
  label="$1"
  shift
  if [ "$RE_DRY_RUN" = 1 ]; then
    re_say "would: $label"
  else
    re_say "$label"
    re_as_root "$@"
  fi
}

# Writes a root-owned file with exactly this content. Sets RE_CHANGED=1 when it writes it. A file
# with other content is refused: an operator's own settings are never overwritten.
re_put() {
  file="$1"
  content="$2"
  label="$3"
  RE_CHANGED=0
  if [ -f "$file" ]; then
    if [ "$(cat "$file")" = "$content" ]; then
      re_say "$label: already done"
      return 0
    fi
    re_fail "$file already holds other settings; check it, remove it, then run again ($label)"
  fi
  RE_CHANGED=1
  if [ "$RE_DRY_RUN" = 1 ]; then
    re_say "would: $label ($file)"
    return 0
  fi
  re_say "$label ($file)"
  re_as_root mkdir -p "$(dirname "$file")"
  printf '%s\n' "$content" | re_as_root tee "$file" >/dev/null
}

# Waits up to $1 seconds for a command to succeed.
re_wait() {
  seconds="$1"
  shift
  waited=0
  until "$@" >/dev/null 2>&1; do
    [ "$waited" -lt "$seconds" ] || return 1
    sleep 1
    waited=$((waited + 1))
  done
}

# 1. Subordinate user and group IDs for the user namespace.
re_subids() {
  if grep -q "^$RE_USER:" "$RE_ROOT/etc/subuid" 2>/dev/null &&
    grep -q "^$RE_USER:" "$RE_ROOT/etc/subgid" 2>/dev/null; then
    re_say "subordinate IDs of $RE_USER: already done"
    return 0
  fi
  re_change "subordinate IDs for $RE_USER" \
    usermod --add-subuids 200000-265535 --add-subgids 200000-265535 "$RE_USER"
}

# 2. Ubuntu 23.10 and later restrict unprivileged user namespaces with AppArmor: allow them for
#    this RootlessKit binary only, never for the whole machine.
re_apparmor() {
  if [ ! -f "$RE_ROOT/proc/sys/kernel/apparmor_restrict_unprivileged_userns" ]; then
    re_say "AppArmor: user namespaces are not restricted on this machine; nothing to do"
    return 0
  fi
  profile="$RE_ROOT/etc/apparmor.d/sdlc-rootlesskit"
  re_put "$profile" "abi <abi/4.0>,
include <tunables/global>

\"$RE_BIN/rootlesskit\" flags=(unconfined) {
  userns,
  include if exists <local/sdlc-rootlesskit>
}" "AppArmor profile for $RE_BIN/rootlesskit only"
  if [ "$RE_CHANGED" = 1 ]; then re_change "load the AppArmor profile" apparmor_parser -r "$profile"; fi
}

# 3. cgroup v2 delegation of cpu, cpuset, io, memory and pids to user services. Without cpu, a
#    rootless Engine accepts the sandbox's CPU limit but does not apply it (ADR-M25 §2.4).
re_delegate() {
  re_put "$RE_ROOT/etc/systemd/system/user@.service.d/delegate.conf" "[Service]
Delegate=cpu cpuset io memory pids" "cgroup delegation to user services"
  RE_DELEGATED="$RE_CHANGED"
  if [ "$RE_CHANGED" = 1 ]; then re_change "reload systemd" systemctl daemon-reload; fi
}

re_controllers() {
  echo "$RE_ROOT/sys/fs/cgroup/user.slice/user-$RE_UID.slice/user@$RE_UID.service/cgroup.controllers"
}

re_all_controllers() {
  for controller in cpu memory pids; do
    grep -qw "$controller" "$(re_controllers)" 2>/dev/null || return 1
  done
}

# 4. Linger, and the user's own systemd, (re)started after the delegation so that it gets every
#    controller.
re_linger() {
  if [ -e "$RE_ROOT/var/lib/systemd/linger/$RE_USER" ]; then
    re_say "linger for $RE_USER: already done"
  else
    re_change "linger for $RE_USER" loginctl enable-linger "$RE_USER"
  fi
  if [ "${RE_DELEGATED:-0}" = 1 ] || ! re_all_controllers; then
    re_change "stop the systemd user manager of $RE_USER" systemctl stop "user@$RE_UID.service"
    re_change "start the systemd user manager of $RE_USER" systemctl start "user@$RE_UID.service"
  fi
  [ "$RE_DRY_RUN" = 1 ] && return 0
  re_wait 30 test -e "$RE_ROOT$(re_runtime)/bus" ||
    re_fail "no user D-Bus at $(re_runtime)/bus (is dbus-user-session installed?)"
  re_all_controllers ||
    re_fail "cpu, memory and pids are not all delegated ($(cat "$(re_controllers)" 2>/dev/null))"
}

re_engine_up() { re_as_user docker info >/dev/null 2>&1; }

# 5. The rootless Engine as a systemd user service. --force: the machine's own (rootful) Engine
#    keeps running; the two never share containers, networks or volumes.
re_engine() {
  if re_engine_up; then
    re_say "the rootless Engine of $RE_USER: already running ($(re_socket))"
    return 0
  fi
  if [ "$RE_DRY_RUN" = 1 ]; then
    re_say "would: install the rootless Engine of $RE_USER (dockerd-rootless-setuptool.sh install)"
    return 0
  fi
  re_say "install the rootless Engine of $RE_USER"
  re_as_user "$RE_BIN/dockerd-rootless-setuptool.sh" install --force
  re_wait 60 re_engine_up ||
    re_fail "the rootless Engine did not start (journalctl --user -u docker.service, as $RE_USER)"
}

# 6. Really rootless, with cgroup v2 and the systemd cgroup driver; and never the platform's data.
re_check() {
  if [ "$RE_DRY_RUN" = 1 ] && ! re_engine_up; then return 0; fi
  info="$(re_as_user docker info --format '{{.SecurityOptions}} cgroup={{.CgroupVersion}} driver={{.CgroupDriver}} version={{.ServerVersion}}')"
  re_say "$info"
  case "$info" in
    *rootless*cgroup=2\ driver=systemd*) ;;
    *) re_fail "not a rootless Engine with cgroup v2 and systemd" ;;
  esac
  if [ -n "$(re_as_user docker volume ls -q --filter label=com.docker.compose.volume=postgres-data)" ]; then
    re_fail "this Docker Engine holds the platform's data (volume postgres-data): the runner needs its own Engine (ADR-M91)"
  fi
}

re_authz_on() {
  case "$(re_as_user docker info --format '{{json .Plugins.Authorization}}' 2>/dev/null)" in
    *sdlc-authz*) return 0 ;;
    *) return 1 ;;
  esac
}

# 7. The AuthZ plugin for create bodies (H07, ADR-M105): $1 is the script that enables it
#    (install-rootless.sh on a server, enable.sh in CI), $2 the plugin's built main.js.
re_authz() {
  script="$1"
  dist="$2"
  if re_authz_on; then
    re_say "AuthZ plugin sdlc-authz: already enabled"
    return 0
  fi
  [ -f "$dist" ] ||
    re_fail "the AuthZ plugin is not built ($dist): run pnpm exec tsc -b platform/deploy/docker-authz"
  if [ "$RE_DRY_RUN" = 1 ]; then
    re_say "would: enable the AuthZ plugin sdlc-authz"
    return 0
  fi
  re_say "enable the AuthZ plugin sdlc-authz"
  re_as_user sh "$script" --dist "$dist"
  re_wait 60 re_engine_up || re_fail "the rootless Engine did not come back after the AuthZ plugin"
  re_authz_on || re_fail "docker info lists no authorization plugin sdlc-authz"
}
