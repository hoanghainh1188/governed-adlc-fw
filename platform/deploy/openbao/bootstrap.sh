#!/bin/sh
# OpenBao bootstrap (task A03, design/ADR-M19). Procedure and custody rules:
# handbook/03-templates/T11-openbao-runbook.md.
#
# Runs on the host and uses the bao command inside the Compose "openbao" container, so the host
# needs only Docker. Key shares and tokens are read from a hidden prompt (or stdin when stdin is
# not a terminal), passed to the container on stdin, and never written to a file, a command
# line or an environment variable of the host.
#
# Environment:
#   SDLC_ENV_FILE  Compose env file (default: platform/deploy/.env)
set -eu

deploy_dir="$(cd "$(dirname "$0")/.." && pwd)"
settings="$deploy_dir/openbao/bootstrap/bootstrap.conf"
in_container=/openbao/bootstrap

usage() {
  cat <<'EOF'
Usage: platform/deploy/openbao/bootstrap.sh <command> [options]

Commands:
  status               Show whether OpenBao is uninitialised, sealed or unsealed.
  init                 Initialise OpenBao once. Prints the key shares and the first root
                       token ONE time, to the terminal only. Refuses when output is not a
                       terminal and when OpenBao is already initialised.
  unseal               Ask for key shares (hidden) until OpenBao is unsealed.
  configure [--keep-token | --issue-admin-token]
                       Ask for a root token (hidden) and apply the configuration: KV v2,
                       Transit key, policies, AppRoles, admin token role. Safe to run again.
                       Revokes the root token at the end unless --keep-token is given.
                       --issue-admin-token: also create one admin token just before the root
                       token is revoked and print it as the last line; refused when the output
                       is a terminal (pnpm server:setup reads it from a pipe, D-08 V16).
  root-token           Ask for key shares (hidden) and create a new root token. Prints it
                       ONE time, to the terminal only. Revoke it after use.
  litellm-credentials  Ask for an admin token (hidden), issue a new secret ID for the AppRole
                       "litellm" and write it with the role ID into the volume of the LiteLLM
                       sidecar (Compose profile "models"). Prints no secret. Run it again to
                       rotate the secret ID, then restart litellm-agent (runbook T11).
  api-credentials      Ask for an admin token (hidden). Store the platform_app database password
                       (PLATFORM_APP_DB_PASSWORD from the env file) at kv/api/database, issue a
                       new secret ID for the AppRole "api" and write it with the role ID into the
                       volume of sdlc-api (Compose profile "platform"). Prints no secret. Run it
                       again to rotate, then restart sdlc-api (runbook T11).
  worker-credentials   The same for the worker: kv/worker/database, AppRole "worker", volume of
                       sdlc-worker. Also the AppRole "cost-controller" into the volume
                       worker-cost-approle: the worker runs the Cost Controller (C06, ADR-M33).
                       Run it again to rotate, then restart sdlc-worker (runbook T11).
  runner-credentials   The same for the runner: kv/runner/database, AppRole "runner", volume of
                       sdlc-runner (Compose profile "sandbox"). Run it again to rotate, then
                       restart sdlc-runner (runbook T11 §5g). With SDLC_RUNNER_DOCKER_HOST in the
                       env file, the volume is the runner host's (its own Engine, ADR-M91).
  runner-evidence-credentials
                       Ask for an admin token (hidden). Create a new SeaweedFS key pair for the
                       runner's L1 proposals and run diffs, store it at kv/runner/evidence and
                       apply it to SeaweedFS as the identity "runner-evidence", limited to
                       Write:evidence/proposals/*, Write:evidence/diffs/* and Read:evidence/diffs/*
                       (C06, ADR-M33 §2.9; C07, ADR-M34 §2.2; C08, ADR-M38 §2.2: the push reads
                       the checked diff back). The old key stops working.
                       Prints no secret. Run it again to rotate, then restart sdlc-runner.
  api-evidence-credentials
                       Ask for an admin token (hidden). Create a new SeaweedFS key pair for the
                       api's Evidence Packs, store it at kv/api/evidence and apply it to SeaweedFS
                       as the identity "api-evidence", limited to Read:evidence/proposals/*,
                       Read:evidence/diffs/* (the hash re-check), Read:evidence/packs/* and
                       Write:evidence/packs/* (E02, ADR-M48). The old key stops working.
                       Prints no secret. Run it again to rotate, then restart sdlc-api.
  api-github-oauth-credentials
                       Ask for an admin token (hidden, from the terminal), then read the GitHub
                       App's client secret (a hidden prompt, or standard input: < <file>) and
                       store it at kv/api/github-oauth, field client_secret, for the dashboard's
                       GitHub sign-in (U05, ADR-M73 §2.2). Only the api AppRole reads it. Prints
                       no secret. Run it again to rotate (the api reads it again within 10
                       minutes).
  worker-evidence-credentials
                       The same for the worker's release packs at G8: kv/worker/evidence, the
                       identity "worker-evidence" with the same four rights (E03, ADR-M49). The
                       old key stops working. Prints no secret. Run it again to rotate, then
                       restart sdlc-worker.
  worker-purge-credentials
                       The worker's evidence retention loop (E05, ADR-M51): kv/worker/purge, the
                       identity "worker-purge": List:evidence, and on evidence/proposals/*,
                       evidence/diffs/*, evidence/packs/*: Write (delete), BypassGovernanceRetention,
                       PutObjectLegalHold, PutObjectRetention, GetObjectRetention. No read. The old
                       key stops working. Prints no secret. Run it again to rotate, then restart
                       sdlc-worker.
  worker-anchor-credentials
                       The worker's daily audit anchor (E05 PR 2, ADR-M51 §2.9): kv/worker/anchor,
                       the identity "worker-anchor": Write, Read, List and GetObjectRetention on
                       the bucket audit-anchors (object lock COMPLIANCE) only. The old key stops
                       working. Prints no secret. Run it again to rotate, then restart sdlc-worker.
  backup-credentials   Ask for an admin token (hidden), issue a new secret ID for the AppRole
                       "backup" (only OpenBao's Raft snapshot, A10, ADR-M63) and write it with the
                       role ID into the volume of the backup job (Compose profile "backup"). Prints
                       no secret. Run it again to rotate (runbook T11 section 6).
  worker-langfuse-credentials
                       The worker's Langfuse purge (E08, ADR-M53): asks for the worker's own Langfuse
                       project key (made once in the Langfuse UI; public key, then secret key, hidden)
                       and stores it at kv/worker/langfuse with a new password of the ClickHouse user
                       "sdlc_purge" (only ALTER DELETE on events_full and events_core) and a new key
                       of the SeaweedFS identity "worker-langfuse" (List:langfuse and
                       Write:langfuse/events/otel/*, no read). Needs the profile observability. The
                       old ClickHouse password and S3 key stop working. Prints no secret. Run it
                       again to rotate, then restart sdlc-worker (runbook T11 section 5m).
  worker-knowledge-credentials
                       The worker's index of project documents (X04 PR 3a, ADR-M89): makes a new
                       password of the knowledge-db role "knowledge" (owner of the database
                       knowledge, CREATEROLE, no superuser), stores it at kv/worker/knowledge-db
                       and sets it in knowledge-db. Needs the profile knowledge. The old password
                       stops working. Prints no secret. Run it again to rotate, then restart
                       sdlc-worker (runbook T11 section 5o).
  knowledge-issuer-credentials
                       The tools' short-lived logins to knowledge-db (X04 PR 3b, ADR-M89): makes
                       the knowledge-db role "kdocs_issuer" (CREATEROLE, no superuser, the admin
                       option on each project's read role only) with a new password, writes the
                       connection knowledge-db of the database engine (roles kdocs-* only) and
                       rotates the password inside OpenBao, so nobody knows it. Needs the profile
                       knowledge and "configure" first. Prints no secret. Run it again to repair or
                       rotate (runbook T11 section 5o).

  rotate-credentials   Ask for an admin token (hidden) once and renew every AppRole secret ID
                       that is set up here: api-credentials, worker-credentials (worker and
                       cost-controller), runner-credentials, litellm-credentials and
                       backup-credentials; an AppRole with no secret ID yet is skipped. The other
                       credentials do not expire and are not touched. Prints no secret. Then
                       restart the services it names (O05, runbook T11 section 8.1).

Runbook: handbook/03-templates/T11-openbao-runbook.md
EOF
}

say() { echo "bootstrap: $*"; }
fail() {
  echo "bootstrap: $*" >&2
  exit 1
}
setting() {
  value="$(sed -n "s/^$1=//p" "$settings" | tail -n 1)"
  [ -n "$value" ] || fail "setting $1 missing in $settings"
  printf '%s' "$value"
}

# --- Arguments (parsed before anything touches Docker) ----------------------------------------
[ "$#" -ge 1 ] || {
  usage >&2
  exit 2
}
command="$1"
shift
keep_token=no
issue_admin=no
allow_non_tty=no
for arg in "$@"; do
  case "$arg" in
    --keep-token)
      [ "$command" = configure ] || fail "unknown option: $arg"
      keep_token=yes
      ;;
    # The admin token of `pnpm server:setup` and `pnpm trial:up` (D-08 V16, design/ADR-M98): to a
    # pipe only, never to a terminal or the screen's scroll-back.
    --issue-admin-token)
      [ "$command" = configure ] || fail "unknown option: $arg"
      [ ! -t 1 ] || fail "--issue-admin-token prints a token; it is for a pipe only, never a terminal"
      issue_admin=yes
      ;;
    # Lets a caller keep the printed secrets in memory: the live tests (SDLC_OPENBAO_TEST=1) and
    # `pnpm trial:up` (SDLC_OPENBAO_THROWAWAY=1, throw-away keys of a trial stack on a developer
    # machine, D-08 V02). Never with NODE_ENV=production; never documented in --help.
    --stdout-not-tty)
      [ "${NODE_ENV:-}" != production ] || fail "unknown option: $arg"
      [ "${SDLC_OPENBAO_TEST:-}" = 1 ] || [ "${SDLC_OPENBAO_THROWAWAY:-}" = 1 ] ||
        fail "unknown option: $arg"
      allow_non_tty=yes
      ;;
    *) fail "unknown option: $arg" ;;
  esac
done
case "$command" in
  -h | --help | help)
    usage
    exit 0
    ;;
  status | init | unseal | configure | root-token | litellm-credentials | backup-credentials | api-credentials | worker-credentials | runner-credentials | runner-evidence-credentials | api-evidence-credentials | worker-evidence-credentials | worker-purge-credentials | worker-anchor-credentials | worker-langfuse-credentials | worker-knowledge-credentials | knowledge-issuer-credentials | api-github-oauth-credentials | rotate-credentials) ;;
  *)
    usage >&2
    exit 2
    ;;
esac

env_file="${SDLC_ENV_FILE:-$deploy_dir/.env}"
[ -f "$env_file" ] || fail "$env_file not found; run scripts/init-env.sh first"
# The trial's switch (D-08 V02): `init` only, and only on a trial stack's own env file, so it can
# never send a real deployment's key shares to a pipe or a log.
if [ "$allow_non_tty" = yes ] && [ "${SDLC_OPENBAO_TEST:-}" != 1 ]; then
  [ "$command" = init ] || fail "unknown option: --stdout-not-tty"
  case "$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$env_file" | tail -n 1)" in
    sdlc-trial* | sdlctrialit*) ;;
    *) fail "--stdout-not-tty is for the throw-away keys of a trial stack only (pnpm trial:up)" ;;
  esac
fi
command -v docker >/dev/null 2>&1 || fail "docker is required"

compose() { docker compose -f "$deploy_dir/docker-compose.yml" --env-file "$env_file" "$@"; }
# "docker compose exec" reads stdin until it ends. Only calls that pass a secret get stdin;
# every other call gets /dev/null, so it cannot swallow the next key share or token.
bao_exec() { compose exec -T openbao "$@"; }
bao_exec_no_input() { compose exec -T openbao "$@" </dev/null; }

# Prints uninitialised, sealed or unsealed. Fails when the container or API is not reachable.
state() {
  # The key-holder listener 8210: plain, reachable only inside the container (openbao.hcl).
  out="$(bao_exec_no_input wget -q -O - http://127.0.0.1:8210/v1/sys/seal-status 2>/dev/null)" ||
    fail "OpenBao is not reachable; start it with: pnpm compose:core"
  case "$out" in
    *'"initialized":false'*) echo uninitialised ;;
    *'"sealed":true'*) echo sealed ;;
    *'"sealed":false'*) echo unsealed ;;
    *) fail "unexpected answer from OpenBao seal-status" ;;
  esac
}

require_unsealed() {
  case "$(state)" in
    unsealed) ;;
    sealed) fail "OpenBao is sealed; unseal it first: bootstrap.sh unseal (runbook T11 section 4)" ;;
    uninitialised) fail "OpenBao is not initialised; run: bootstrap.sh init (runbook T11 section 3)" ;;
  esac
}

# Secrets go to the terminal only (AC1: printed once, never to a file).
require_terminal_output() {
  [ -t 1 ] || [ "$allow_non_tty" = yes ] ||
    fail "output is not a terminal; secrets are printed only to a terminal. Do not redirect or pipe this command"
}

restore_echo() { [ -t 0 ] && stty echo 2>/dev/null || true; }

# read_secret <prompt>: hidden prompt on a terminal, plain line from stdin otherwise.
read_secret() {
  if [ -t 0 ]; then
    printf '%s: ' "$1" >&2
    trap 'restore_echo; exit 130' INT TERM
    stty -echo
    IFS= read -r secret || secret=""
    restore_echo
    trap - INT TERM
    echo >&2
  else
    IFS= read -r secret || secret=""
  fi
  printf '%s' "$secret"
}

cmd_status() {
  say "OpenBao is $(state)"
}

cmd_init() {
  require_terminal_output
  [ "$(state)" = uninitialised ] || fail "OpenBao is already initialised; nothing printed"
  shares="$(setting BAO_KEY_SHARES)"
  threshold="$(setting BAO_KEY_THRESHOLD)"
  cat <<EOF
================================================================================
 OpenBao initialisation: $shares key shares, any $threshold unseal.
 The shares and the root token below are shown ONCE. They are not stored anywhere.
 Give each share to a different key holder (runbook T11 section 3).
 Never paste them into chat, email, issues, files or logs.
================================================================================
EOF
  bao_exec_no_input bao operator init -key-shares="$shares" -key-threshold="$threshold"
  cat <<EOF
================================================================================
 Next: bootstrap.sh unseal ($threshold shares), then bootstrap.sh configure (root token).
 configure revokes the root token when it finishes.
================================================================================
EOF
}

cmd_unseal() {
  case "$(state)" in
    unsealed)
      say "OpenBao is already unsealed"
      return 0
      ;;
    uninitialised) fail "OpenBao is not initialised; run: bootstrap.sh init" ;;
  esac
  while [ "$(state)" = sealed ]; do
    share="$(read_secret 'Unseal key share (hidden)')"
    [ -n "$share" ] || fail "no key share given; OpenBao is still sealed"
    progress="$(printf '%s' "$share" | bao_exec bao write -field=progress sys/unseal key=- 2>/dev/null)" ||
      fail "the key share was rejected; OpenBao is still sealed"
    [ "$(state)" = sealed ] && say "share accepted ($progress of $(setting BAO_KEY_THRESHOLD))"
  done
  say "OpenBao is unsealed"
}

# Subnet(s) of the Compose network the openbao container is on, WITHOUT the gateway address:
# on a Linux host every host process reaches containers from the gateway (QUESTIONS #37).
network_cidrs() {
  container="$(compose ps -q openbao </dev/null)"
  [ -n "$container" ] || fail "the openbao container is not running"
  network="$(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' "$container")"
  cidrs=""
  for n in $network; do
    for pair in $(docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}}|{{.Gateway}} {{end}}' "$n"); do
      subnet="${pair%%|*}"
      gateway="${pair#*|}"
      [ -n "$gateway" ] || fail "the Compose network has no fixed gateway (SDLC_NETWORK_GATEWAY in .env)"
      blocks="$("$deploy_dir/openbao/cidr-exclude.sh" "$subnet" "$gateway")" ||
        fail "cannot exclude the gateway $gateway from $subnet"
      cidrs="${cidrs:+$cidrs,}$blocks"
    done
  done
  [ -n "$cidrs" ] || fail "cannot read the subnet of the Compose network"
  printf '%s' "$cidrs"
}

cmd_configure() {
  require_unsealed
  cidrs="$(setting SECRET_ID_BOUND_CIDRS)"
  [ "$cidrs" = compose-network ] && cidrs="$(network_cidrs)"
  token="$(read_secret 'Root token (hidden)')"
  [ -n "$token" ] || fail "no root token given"
  set -- "$cidrs"
  [ "$keep_token" = yes ] && set -- "$@" --keep-token
  [ "$issue_admin" = yes ] && set -- "$@" --issue-admin-token
  # The runner on its own Engine (O01, ADR-M91 §2.7, QUESTIONS #596): its source address, for the
  # AppRole "runner" only.
  runner_cidr="$(sed -n 's/^SDLC_RUNNER_SOURCE_CIDR=//p' "$env_file" | tail -n 1)"
  if [ -n "$runner_cidr" ]; then
    printf '%s' "$runner_cidr" |
      grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}/([0-9]|[12][0-9]|3[0-2])$' ||
      fail "SDLC_RUNNER_SOURCE_CIDR must be one IPv4 block such as 10.66.0.2/32"
    set -- "$@" --runner-cidr "$runner_cidr"
  fi
  printf '%s\n' "$token" | bao_exec sh "$in_container/configure.sh" "$@"
}

cmd_root_token() {
  require_terminal_output
  require_unsealed
  threshold="$(setting BAO_KEY_THRESHOLD)"
  input=""
  i=1
  while [ "$i" -le "$threshold" ]; do
    share="$(read_secret "Key share $i of $threshold (hidden)")"
    [ -n "$share" ] || fail "no key share given"
    input="$input$share
"
    i=$((i + 1))
  done
  echo "New root token (shown ONCE; revoke it after use, record the use in the operations log):"
  printf '%s' "$input" | bao_exec sh "$in_container/root-token.sh"
}

# Prints the role ID, a new secret ID and the new secret ID's accessor, one per line, from the
# openbao container. The accessor comes from the same create response, never from a list. The
# admin token comes on stdin. issue_secret_id <AppRole>
issue_secret_id() {
  printf '%s\n' "$token" |
    bao_exec sh -c 'IFS= read -r BAO_TOKEN && export BAO_TOKEN &&
      bao read -field=role_id "auth/approle/role/$1/role-id" && echo &&
      bao write -f -format=table "auth/approle/role/$1/secret-id" |
        awk '"'"'$1 == "secret_id" { s = $2 } $1 == "secret_id_accessor" { a = $2 }
          END { if (s == "" || a == "") exit 1; print s; print a }'"'"'' sh "$1"
}

# Destroys every secret ID of an AppRole except the one with the given accessor, so a rotation
# cuts off the previous secret ID at once (QUESTIONS #140). Runs only after the new secret ID is
# written to the service's volume. One process per AppRole: a second instance of a service would
# lose its secret ID here (ADR-M19). Tokens already issued from an old secret ID stay valid until
# their TTL (runbook T11 section 8). revoke_other_secret_ids <AppRole> <accessor to keep>
revoke_other_secret_ids() {
  case "$2" in
    '' | *[!0-9a-f-]*) fail "no valid accessor for the new $1 secret ID; old secret IDs NOT revoked" ;;
  esac
  printf '%s\n%s\n' "$token" "$2" |
    bao_exec sh -c 'IFS= read -r BAO_TOKEN && export BAO_TOKEN && IFS= read -r keep || exit 1
      accessors="$(bao list -format=json "auth/approle/role/$1/secret-id" | tr -d "[]\", ")" || exit 1
      printf "%s\n" "$accessors" | grep -qxF "$keep" || { echo "new secret ID not listed" >&2; exit 1; }
      for a in $accessors; do
        [ "$a" = "$keep" ] && continue
        bao write "auth/approle/role/$1/secret-id-accessor/destroy" secret_id_accessor="$a" >/dev/null || exit 1
      done' sh "$1" ||
    fail "the new $1 credentials are delivered, but old secret IDs could NOT be revoked; run the command again (runbook T11 section 8)"
}

# The role ID and a new secret ID go from the openbao container straight into the sidecar's volume
# through a pipe: never a host file, a command line or an environment variable. The admin token
# goes to the openbao container on stdin. The old secret IDs are revoked afterwards.
cmd_litellm_credentials() {
  require_unsealed
  token="$(read_secret 'Admin or root token (hidden)')"
  [ -n "$token" ] || fail "no token given"
  ensure_service_image litellm-agent models
  accessor="$(issue_secret_id litellm |
    compose --profile core --profile models run --rm -T --no-deps --user root --entrypoint sh \
      litellm-agent -c '
      set -e
      umask 077
      IFS= read -r role_id || role_id=""
      IFS= read -r secret_id || secret_id=""
      IFS= read -r accessor || accessor=""
      [ -n "$role_id" ] && [ -n "$secret_id" ] && [ -n "$accessor" ] ||
        { echo "no role ID or secret ID received" >&2; exit 1; }
      printf "%s\n" "$role_id" >/openbao/approle/role_id
      printf "%s\n" "$secret_id" >/openbao/approle/secret_id
      chown -R openbao:openbao /openbao/approle
      chmod 700 /openbao/approle
      printf "%s\n" "$accessor"')" ||
    fail "could not deliver the litellm credentials (token valid? OpenBao configured with the litellm AppRole?)"
  accessor="$(printf '%s\n' "$accessor" | tail -n 1)"
  revoke_other_secret_ids litellm "$accessor"
  say "litellm AppRole credentials written to the litellm-approle volume, old secret IDs revoked; restart litellm-agent to use them"
}

# Writes the role ID and a new secret ID of an AppRole straight into a volume of a platform
# service: from the openbao container through a pipe, never a host file, a command line or an
# environment variable. The platform services drop every capability; this one-shot root container
# gets back only what it needs to write the files and give them to the user node. It prints the
# new accessor only after the files are written; then the old secret IDs are revoked. Needs $token.
# On a fresh machine the service's image does not exist yet; `compose run` would then build it
# and print the build log on stdout, before the accessor (seen in CI on a fresh deployment). So
# the image is built first, its log on stderr. An existing image is used as it is.
# ensure_service_image <Compose service> <profile>
# The Compose project a service's credentials go to: the platform's, or the runner host's when
# runner-credentials runs with SDLC_RUNNER_DOCKER_HOST (O01, ADR-M91 §2.7, QUESTIONS #597). Then
# the same `compose run`, of the job runner-approle-init, reaches the runner's own Engine (ssh:// or
# its socket); the secret ID still travels on stdin only.
delivery_host=""
service_compose() {
  if [ -n "$delivery_host" ]; then
    DOCKER_HOST="$delivery_host" docker compose \
      -f "$deploy_dir/runner-host/docker-compose.yml" --env-file "$env_file" "$@"
  else
    compose "$@"
  fi
}
service_docker() {
  if [ -n "$delivery_host" ]; then DOCKER_HOST="$delivery_host" docker "$@"; else docker "$@"; fi
}

ensure_service_image() {
  image="$(service_compose --profile core --profile "$2" config --images "$1" 2>/dev/null | head -n 1)"
  [ -n "$image" ] || fail "no image for the Compose service $1"
  service_docker image inspect "$image" >/dev/null 2>&1 && return 0
  if [ -n "$delivery_host" ]; then
    service_compose --profile "$2" pull "$1" >&2 || fail "could not pull the image of $1"
    return 0
  fi
  say "building the image of $1 (first run on this machine; a few minutes)"
  service_compose --profile core --profile "$2" build "$1" >&2 ||
    fail "could not build the image of $1; run: docker compose … build $1"
}
# deliver_approle <AppRole> <Compose service> <directory in the service> <profile> [owner]
# The owner is node:node (the platform services) unless given (backup-agent: openbao:openbao).
deliver_approle() {
  ensure_service_image "$2" "$4"
  accessor="$(issue_secret_id "$1" |
    service_compose --profile core --profile "$4" run --rm -T --no-deps --user root \
      --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --entrypoint sh "$2" -c '
      set -e
      umask 077
      IFS= read -r role_id || role_id=""
      IFS= read -r secret_id || secret_id=""
      IFS= read -r accessor || accessor=""
      [ -n "$role_id" ] && [ -n "$secret_id" ] && [ -n "$accessor" ] ||
        { echo "no role ID or secret ID received" >&2; exit 1; }
      printf "%s\n" "$role_id" >"$0/role_id"
      printf "%s\n" "$secret_id" >"$0/secret_id"
      chown -R "$1" "$0"
      chmod 700 "$0"
      printf "%s\n" "$accessor"' "$3" "${5:-node:node}")" ||
    fail "could not deliver the $1 credentials (token valid? OpenBao configured with the $1 AppRole?)"
  # The accessor is the container's last line: anything Compose printed before it is not.
  accessor="$(printf '%s\n' "$accessor" | tail -n 1)"
  revoke_other_secret_ids "$1" "$accessor"
}

# The database password goes from the env file to the openbao container on stdin, after the admin
# token; the AppRole credentials go into the service's volume (deliver_approle).
# platform_credentials <AppRole and KV prefix: api | worker | runner> <Compose service> [profile]
#   [owner]
# The profile is "platform" by default; the runner lives in the profile "sandbox" (C04). The owner
# of the files is node:node unless given (the runner host's job: 1000:1000, the runner's node).
platform_credentials() {
  role="$1"
  service="$2"
  require_unsealed
  password="$(sed -n 's/^PLATFORM_APP_DB_PASSWORD=//p' "$env_file" | tail -n 1)"
  case "$password" in
    '' | CHANGEME) fail "PLATFORM_APP_DB_PASSWORD is not set in $env_file" ;;
  esac
  token="$(read_secret 'Admin or root token (hidden)')"
  [ -n "$token" ] || fail "no token given"
  printf '%s\n%s' "$token" "$password" |
    bao_exec sh -c 'IFS= read -r BAO_TOKEN && export BAO_TOKEN &&
      bao kv put -mount=kv "$1/database" password=- >/dev/null' sh "$role" ||
    fail "could not store kv/$role/database (token valid? OpenBao configured?)"
  deliver_approle "$role" "$service" /run/sdlc/approle "${3:-platform}" "${4:-node:node}"
  say "kv/$role/database stored; $role AppRole credentials written to the $role-approle volume, old secret IDs revoked; restart $service to use them"
}

# The worker also holds the Cost Controller capability (C06, ADR-M33 §2.5, QUESTIONS #112): the
# AppRole "cost-controller" goes into the volume worker-cost-approle. Uses the admin token read
# by platform_credentials.
cost_controller_credentials() {
  deliver_approle cost-controller sdlc-worker /run/sdlc/cost-approle platform
  say "cost-controller AppRole credentials written to the worker-cost-approle volume, old secret IDs revoked; restart sdlc-worker to use them"
}

cmd_api_credentials() { platform_credentials api sdlc-api; }
cmd_worker_credentials() {
  platform_credentials worker sdlc-worker
  cost_controller_credentials
}
cmd_runner_credentials() {
  delivery_host="$(sed -n 's/^SDLC_RUNNER_DOCKER_HOST=//p' "$env_file" | tail -n 1)"
  case "$delivery_host" in
    '' | ssh://?* | unix:///?*) ;;
    *) fail "SDLC_RUNNER_DOCKER_HOST must be ssh://<user>@<host> or unix:///<socket>" ;;
  esac
  if [ -n "$delivery_host" ]; then
    grep -Eq '^SDLC_RUNNER_LINK_ADDR=.+' "$env_file" ||
      fail "SDLC_RUNNER_DOCKER_HOST needs SDLC_RUNNER_LINK_ADDR in $env_file"
    say "the runner's credentials go to the runner host's Engine ($delivery_host)"
    platform_credentials runner runner-approle-init credentials 1000:1000
    return 0
  fi
  platform_credentials runner sdlc-runner sandbox
}

# The GitHub App's client secret for the dashboard's sign-in (U05, ADR-M73 §2.2, runbook T11 §5n).
# The admin token comes from the terminal (hidden); the client secret from a hidden prompt, or from
# standard input when it is a file (`< <client secret file>` made by `pnpm github-app:create`). The
# secret goes to OpenBao on the container's stdin: never a host file, a command line or a log.
# Without a terminal at all (the live tests), the token is the first line of standard input.
read_tty_secret() {
  if [ -t 0 ]; then
    read_secret "$1"
  elif (: </dev/tty) 2>/dev/null; then
    read_secret "$1" </dev/tty
  else
    read_secret "$1"
  fi
}
cmd_api_github_oauth_credentials() {
  require_unsealed
  token="$(read_tty_secret 'Admin or root token (hidden)')"
  [ -n "$token" ] || fail "no token given"
  client_secret="$(read_secret "The GitHub App's client secret (hidden)")"
  printf '%s' "$client_secret" | grep -Eq '^[A-Za-z0-9_.-]{20,255}$' ||
    fail "that is not a GitHub App client secret (20 to 255 letters, digits, '_', '.', '-')"
  printf '%s\n%s\n' "$token" "$client_secret" |
    bao_exec sh -c 'set -e
      IFS= read -r BAO_TOKEN && export BAO_TOKEN
      IFS= read -r cs
      printf "{\"client_secret\":\"%s\"}" "$cs" | bao kv put -mount=kv api/github-oauth - >/dev/null' ||
    fail "storing kv/api/github-oauth failed"
  unset token client_secret
  echo "stored: kv/api/github-oauth (client_secret). Set SDLC_API_WEB_SIGNIN=github and SDLC_API_PUBLIC_ORIGIN, then restart sdlc-api (runbook T11 §5n)."
}

# The runner's write-only SeaweedFS identity for L1 proposals (C06 session 2b, ADR-M33 §2.9) and
# run diffs (C07, ADR-M34 §2.2).
# The openbao container makes the key pair, stores it at kv/runner/evidence (JSON on stdin) and
# prints the two `s3.configure` lines, which go through a pipe to `weed shell` on its stdin: the
# keys are never a host file, a command line or an environment variable. `weed shell` prints the
# identities with their secrets, so its output is discarded; the check reads names only. The old
# identity is deleted first, so a rotation leaves one key (that call fails harmlessly when there is
# none yet: `weed shell` exits 1 after any failed command, so it runs on its own).
cmd_runner_evidence_credentials() {
  require_unsealed
  token="$(read_secret 'Admin or root token (hidden)')"
  [ -n "$token" ] || fail "no token given"
  weed="weed shell -master=127.0.0.1:9333"
  # The KV version (no secret) tells whether the new key pair was stored: `weed shell` exits 0 even
  # when it received nothing.
  kv_version() {
    printf '%s\n' "$token" | bao_exec sh -c 'IFS= read -r BAO_TOKEN && export BAO_TOKEN &&
      bao read -field=current_version kv/metadata/runner/evidence 2>/dev/null || echo 0'
  }
  before="$(kv_version)"
  echo "s3.configure -user runner-evidence -delete -apply" |
    compose exec -T seaweedfs $weed >/dev/null 2>&1 || true
  printf '%s\n' "$token" |
    bao_exec sh -c 'set -e
      IFS= read -r BAO_TOKEN && export BAO_TOKEN
      access="sdlcrunner$(od -An -N10 -tx1 /dev/urandom | tr -d " \n")"
      secret="$(od -An -N30 -tx1 /dev/urandom | tr -d " \n")"
      [ "${#access}" -eq 30 ] || exit 1
      [ "${#secret}" -eq 60 ] || exit 1
      printf "{\"access_key\":\"%s\",\"secret_key\":\"%s\"}" "$access" "$secret" |
        bao kv put -mount=kv runner/evidence - >/dev/null
      printf "s3.configure -user runner-evidence -access_key %s -secret_key %s -actions Write:evidence/proposals/*,Write:evidence/diffs/*,Read:evidence/diffs/* -apply\n" "$access" "$secret"' |
    compose exec -T seaweedfs $weed >/dev/null 2>&1 ||
    fail "could not create the runner evidence credentials (token valid? OpenBao configured? SeaweedFS running?)"
  [ "$(kv_version)" = "$((before + 1))" ] ||
    fail "kv/runner/evidence was not stored (token valid? OpenBao configured?); run the command again"
  echo "s3.configure" | compose exec -T seaweedfs sh -c "$weed 2>/dev/null | grep -q '\"name\": *\"runner-evidence\"'" ||
    fail "SeaweedFS has no identity runner-evidence; run the command again"
  say "kv/runner/evidence stored; SeaweedFS identity runner-evidence (Write:evidence/proposals/*, Write:evidence/diffs/*, Read:evidence/diffs/*) applied; restart sdlc-runner to use it"
}

# SeaweedFS identities of the platform processes, made the same way: the keys are made inside the
# openbao container, stored at kv/<role>/<name> (JSON on stdin), piped to `weed shell` on its
# stdin, its output discarded; the old identity is deleted first, so a rotation leaves one key.
# The AppRoles "api" and "worker" already read kv/data/<role>/*: no policy change.
# s3_credentials <role: api | worker> <kv name> <access key prefix, 9 characters> <actions> <service>
# The identity is "<role>-<kv name>".
s3_credentials() {
  role="$1"
  name="$2"
  key_prefix="$3"
  actions="$4"
  service="$5"
  identity="$role-$name"
  require_unsealed
  token="$(read_secret 'Admin or root token (hidden)')"
  [ -n "$token" ] || fail "no token given"
  weed="weed shell -master=127.0.0.1:9333"
  kv_version() {
    printf '%s\n' "$token" | bao_exec sh -c 'IFS= read -r BAO_TOKEN && export BAO_TOKEN &&
      bao read -field=current_version "kv/metadata/$1/$2" 2>/dev/null || echo 0' sh "$role" "$name"
  }
  before="$(kv_version)"
  echo "s3.configure -user $identity -delete -apply" |
    compose exec -T seaweedfs $weed >/dev/null 2>&1 || true
  printf '%s\n' "$token" |
    bao_exec sh -c 'set -e
      IFS= read -r BAO_TOKEN && export BAO_TOKEN
      access="$3$(od -An -N10 -tx1 /dev/urandom | tr -d " \n")"
      secret="$(od -An -N30 -tx1 /dev/urandom | tr -d " \n")"
      [ "${#access}" -eq 29 ] || exit 1
      [ "${#secret}" -eq 60 ] || exit 1
      printf "{\"access_key\":\"%s\",\"secret_key\":\"%s\"}" "$access" "$secret" |
        bao kv put -mount=kv "$1/$2" - >/dev/null
      printf "s3.configure -user %s-%s -access_key %s -secret_key %s -actions %s -apply\n" "$1" "$2" "$access" "$secret" "$4"' \
      sh "$role" "$name" "$key_prefix" "$actions" |
    compose exec -T seaweedfs $weed >/dev/null 2>&1 ||
    fail "could not create the $identity credentials (token valid? OpenBao configured? SeaweedFS running?)"
  [ "$(kv_version)" = "$((before + 1))" ] ||
    fail "kv/$role/$name was not stored (token valid? OpenBao configured?); run the command again"
  echo "s3.configure" | compose exec -T seaweedfs sh -c "$weed 2>/dev/null | grep -q '\"name\": *\"$identity\"'" ||
    fail "SeaweedFS has no identity $identity; run the command again"
  say "kv/$role/$name stored; SeaweedFS identity $identity ($actions) applied; restart $service to use it"
}

# The SeaweedFS identities that build Evidence Packs: the api's (E02, ADR-M48 §2.2) and the
# worker's for G8's release pack (E03, ADR-M49 §2.2). Each reads proposals and diffs to re-check
# their hashes (a deliberate widening: read only, those two prefixes) and reads and writes packs/.
# pack_evidence_credentials <role: api | worker> <access key prefix, 9 characters> <service>
pack_evidence_credentials() {
  s3_credentials "$1" evidence "$2" \
    'Read:evidence/proposals/*,Read:evidence/diffs/*,Read:evidence/packs/*,Write:evidence/packs/*' "$3"
}

# The worker's purge identity (E05, ADR-M51 §2.3): deletes every version of evidence files whose
# retention is over (SeaweedFS `Write` includes delete), lists the bucket (versions, the orphan
# sweep), bypasses the GOVERNANCE lock (archived projects, orphan pack files), and sets legal holds
# and locks. It never reads a file. Stored at kv/worker/purge.
PURGE_ACTIONS=''
for prefix in proposals diffs packs; do
  for action in Write BypassGovernanceRetention PutObjectLegalHold PutObjectRetention GetObjectRetention; do
    PURGE_ACTIONS="$PURGE_ACTIONS,$action:evidence/$prefix/*"
  done
done
PURGE_ACTIONS="List:evidence$PURGE_ACTIONS"
cmd_worker_purge_credentials() { s3_credentials worker purge sdlcwrkpg "$PURGE_ACTIONS" sdlc-worker; }

# The worker's audit anchor identity (E05 PR 2, ADR-M51 §2.9): writes, reads and lists the daily
# anchors in the bucket `audit-anchors` (object lock COMPLIANCE: its write can never delete a
# version) and reads their lock. Nothing in `evidence`. Stored at kv/worker/anchor.
ANCHOR_ACTIONS='Write:audit-anchors,Read:audit-anchors,List:audit-anchors,GetObjectRetention:audit-anchors'
cmd_worker_anchor_credentials() { s3_credentials worker anchor sdlcwrkan "$ANCHOR_ACTIONS" sdlc-worker; }

# The worker's Langfuse purge (E08, ADR-M53 §2.3). One entry, kv/worker/langfuse:
# - the worker's own Langfuse project key, made by an operator in the Langfuse UI (runbook T11
#   §5m), read from a hidden prompt (or stdin) and passed to the openbao container on stdin;
# - a new password of the ClickHouse user `sdlc_purge`: only ALTER DELETE on the two event tables
#   (APPLY DELETED MASK needs it; it reads nothing). The SQL goes to clickhouse-client on stdin as
#   the loopback-only user `sdlc_admin` (clickhouse/sdlc-admin.xml, ADR-M63 §6), and ClickHouse
#   masks the password in its query log (checked live);
# - a new key of the SeaweedFS identity `worker-langfuse`: List on the bucket `langfuse`, Write
#   (delete) under `langfuse/events/otel/*` only, never Read.
# Every secret is made inside the openbao container and goes through pipes only.
LANGFUSE_RAW_ACTIONS='List:langfuse,Write:langfuse/events/otel/*'
cmd_worker_langfuse_credentials() {
  require_unsealed
  token="$(read_secret 'Admin or root token (hidden)')"
  [ -n "$token" ] || fail "no token given"
  lf_public="$(read_secret "The worker's Langfuse public key (pk-lf-...)")"
  lf_secret="$(read_secret "The worker's Langfuse secret key (sk-lf-..., hidden)")"
  case "$lf_public" in pk-lf-*) ;; *) fail "the public key must start with pk-lf-" ;; esac
  case "$lf_secret" in sk-lf-*) ;; *) fail "the secret key must start with sk-lf-" ;; esac
  case "$lf_public$lf_secret" in *[!A-Za-z0-9-]*) fail "the Langfuse key has unexpected characters" ;; esac
  ch_admin='clickhouse-client --user sdlc_admin --multiquery'
  compose exec -T clickhouse sh -c "echo 'SELECT 1' | $ch_admin" </dev/null >/dev/null 2>&1 ||
    fail "ClickHouse is not reachable; start the profile observability first (pnpm compose:obs)"
  weed="weed shell -master=127.0.0.1:9333"
  kv_version() {
    printf '%s\n' "$token" | bao_exec sh -c 'IFS= read -r BAO_TOKEN && export BAO_TOKEN &&
      bao read -field=current_version kv/metadata/worker/langfuse 2>/dev/null || echo 0'
  }
  before="$(kv_version)"
  printf '%s\n%s\n%s\n' "$token" "$lf_public" "$lf_secret" |
    bao_exec sh -c 'set -e
      IFS= read -r BAO_TOKEN && export BAO_TOKEN
      IFS= read -r public && IFS= read -r secret
      access="sdlcwrklf$(od -An -N10 -tx1 /dev/urandom | tr -d " \n")"
      s3secret="$(od -An -N30 -tx1 /dev/urandom | tr -d " \n")"
      chpw="$(od -An -N24 -tx1 /dev/urandom | tr -d " \n")"
      [ "${#access}" -eq 29 ] || exit 1
      [ "${#s3secret}" -eq 60 ] || exit 1
      [ "${#chpw}" -eq 48 ] || exit 1
      printf "{\"langfuse_public_key\":\"%s\",\"langfuse_secret_key\":\"%s\",\"clickhouse_password\":\"%s\",\"access_key\":\"%s\",\"secret_key\":\"%s\"}" \
        "$public" "$secret" "$chpw" "$access" "$s3secret" |
        bao kv put -mount=kv worker/langfuse - >/dev/null' ||
    fail "could not store kv/worker/langfuse (token valid? OpenBao configured?)"
  [ "$(kv_version)" = "$((before + 1))" ] ||
    fail "kv/worker/langfuse was not stored (token valid? OpenBao configured?); run the command again"
  # The SeaweedFS identity: the old one first, so a rotation leaves one key.
  echo "s3.configure -user worker-langfuse -delete -apply" |
    compose exec -T seaweedfs $weed >/dev/null 2>&1 || true
  printf '%s\n' "$token" |
    bao_exec sh -c 'set -e
      IFS= read -r BAO_TOKEN && export BAO_TOKEN
      access="$(bao kv get -mount=kv -field=access_key worker/langfuse)"
      secret="$(bao kv get -mount=kv -field=secret_key worker/langfuse)"
      printf "s3.configure -user worker-langfuse -access_key %s -secret_key %s -actions %s -apply\n" "$access" "$secret" "$1"' \
      sh "$LANGFUSE_RAW_ACTIONS" |
    compose exec -T seaweedfs $weed >/dev/null 2>&1 ||
    fail "could not apply the SeaweedFS identity worker-langfuse; run the command again"
  echo "s3.configure" | compose exec -T seaweedfs sh -c "$weed 2>/dev/null | grep -q '\"name\": *\"worker-langfuse\"'" ||
    fail "SeaweedFS has no identity worker-langfuse; run the command again"
  # The ClickHouse user: created once, its password replaced on every run, its grants exact.
  printf '%s\n' "$token" |
    bao_exec sh -c 'set -e
      IFS= read -r BAO_TOKEN && export BAO_TOKEN
      pw="$(bao kv get -mount=kv -field=clickhouse_password worker/langfuse)"
      printf "CREATE USER IF NOT EXISTS sdlc_purge IDENTIFIED WITH sha256_password BY '"'"'%s'"'"';\n" "$pw"
      printf "ALTER USER sdlc_purge IDENTIFIED WITH sha256_password BY '"'"'%s'"'"';\n" "$pw"
      printf "REVOKE ALL ON *.* FROM sdlc_purge;\n"
      printf "GRANT ALTER DELETE ON default.events_full TO sdlc_purge;\n"
      printf "GRANT ALTER DELETE ON default.events_core TO sdlc_purge;\n"' |
    compose exec -T clickhouse sh -c "$ch_admin" >/dev/null 2>&1 ||
    fail "could not create the ClickHouse user sdlc_purge (the user sdlc_admin exists? ClickHouse restarted after the update?)"
  grants="$(compose exec -T clickhouse sh -c "echo 'SHOW GRANTS FOR sdlc_purge' | $ch_admin" </dev/null 2>/dev/null)" ||
    fail "could not read the grants of sdlc_purge; run the command again"
  [ "$(printf '%s\n' "$grants" | grep -c .)" -eq 2 ] &&
    printf '%s\n' "$grants" | grep -qx 'GRANT ALTER DELETE ON default.events_full TO sdlc_purge' &&
    printf '%s\n' "$grants" | grep -qx 'GRANT ALTER DELETE ON default.events_core TO sdlc_purge' ||
    fail "the ClickHouse user sdlc_purge has unexpected grants; run the command again"
  say "kv/worker/langfuse stored (the worker's Langfuse key); SeaweedFS identity worker-langfuse ($LANGFUSE_RAW_ACTIONS) and ClickHouse user sdlc_purge (ALTER DELETE on events_full, events_core) applied; restart sdlc-worker to use them"
}

# The worker's index of project documents (X04 PR 3a, ADR-M89 §2.1). One entry,
# kv/worker/knowledge-db, field `password`: made inside the openbao container, then set on the
# role `knowledge` by psql in knowledge-db (local socket, as the superuser), the SQL on stdin.
# The session never logs a statement, also not a failed one, so the password stays out of the logs.
cmd_worker_knowledge_credentials() {
  require_unsealed
  token="$(read_secret 'Admin or root token (hidden)')"
  [ -n "$token" ] || fail "no token given"
  psql_admin='psql -v ON_ERROR_STOP=1 -X -q -U postgres -d knowledge'
  compose exec -T knowledge-db sh -c "$psql_admin -c 'SELECT 1'" </dev/null >/dev/null 2>&1 ||
    fail "knowledge-db is not reachable; start the profile knowledge first (pnpm compose:knowledge)"
  kv_version() {
    printf '%s\n' "$token" | bao_exec sh -c 'IFS= read -r BAO_TOKEN && export BAO_TOKEN &&
      bao read -field=current_version kv/metadata/worker/knowledge-db 2>/dev/null || echo 0'
  }
  before="$(kv_version)"
  printf '%s\n' "$token" |
    bao_exec sh -c 'set -e
      IFS= read -r BAO_TOKEN && export BAO_TOKEN
      pw="$(od -An -N24 -tx1 /dev/urandom | tr -d " \n")"
      [ "${#pw}" -eq 48 ] || exit 1
      printf "{\"password\":\"%s\"}" "$pw" | bao kv put -mount=kv worker/knowledge-db - >/dev/null' ||
    fail "could not store kv/worker/knowledge-db (token valid? OpenBao configured?)"
  [ "$(kv_version)" = "$((before + 1))" ] ||
    fail "kv/worker/knowledge-db was not stored (token valid? OpenBao configured?); run the command again"
  # The SQL is made first, into a variable (never a file): without `pipefail`, a failed OpenBao
  # step would otherwise give psql empty input, and psql would succeed.
  sql="$(printf '%s\n' "$token" |
    bao_exec sh -c 'set -e
      IFS= read -r BAO_TOKEN && export BAO_TOKEN
      pw="$(bao kv get -mount=kv -field=password worker/knowledge-db)"
      case "$pw" in *[!0-9a-f]*|"") exit 1 ;; esac
      [ "${#pw}" -eq 48 ] || exit 1
      printf "SET log_statement = '"'"'none'"'"';\n"
      printf "SET log_min_error_statement = '"'"'panic'"'"';\n"
      printf "ALTER ROLE knowledge LOGIN NOSUPERUSER CREATEROLE PASSWORD '"'"'%s'"'"';\n" "$pw"')" ||
    fail "could not read kv/worker/knowledge-db back (token valid?); run the command again"
  case "$sql" in *"ALTER ROLE knowledge"*) ;; *) fail "could not read kv/worker/knowledge-db back; run the command again" ;; esac
  printf '%s\n' "$sql" | compose exec -T knowledge-db sh -c "$psql_admin" >/dev/null 2>&1 ||
    fail "could not set the password of the knowledge-db role knowledge (database made by knowledge-db/init?); run the command again"
  unset sql
  say "kv/worker/knowledge-db stored and set on the knowledge-db role knowledge; restart sdlc-worker to use it"
}

# The issuer of the tools' database logins (X04 PR 3b, ADR-M89, QUESTIONS #535, #537, #540). The
# password is made inside the openbao container, written into the database engine's connection
# (not verified yet) and printed as SQL into a variable, never a file or an argument; psql sets it
# on the role in knowledge-db (the session logs no statement); then `rotate-root` replaces it with
# a password only OpenBao knows. The role may create and drop roles and end their sessions; it
# holds each project's read role with the admin option only (it cannot read the indexes itself).
cmd_knowledge_issuer_credentials() {
  require_unsealed
  token="$(read_secret 'Admin or root token (hidden)')"
  [ -n "$token" ] || fail "no token given"
  psql_admin='psql -v ON_ERROR_STOP=1 -X -q -U postgres -d knowledge'
  compose exec -T knowledge-db sh -c "$psql_admin -c 'SELECT 1'" </dev/null >/dev/null 2>&1 ||
    fail "knowledge-db is not reachable; start the profile knowledge first (pnpm compose:knowledge)"
  printf '%s\n' "$token" | bao_exec sh -c 'IFS= read -r BAO_TOKEN && export BAO_TOKEN &&
    bao read -field=type sys/mounts/database' 2>/dev/null | grep -qx database ||
    fail "the mount database/ is missing; run pnpm openbao:bootstrap configure first"
  sql="$(printf '%s\n' "$token" |
    bao_exec sh -c 'set -e
      IFS= read -r BAO_TOKEN && export BAO_TOKEN
      pw="$(od -An -N24 -tx1 /dev/urandom | tr -d " \n")"
      [ "${#pw}" -eq 48 ] || exit 1
      printf "{\"plugin_name\":\"postgresql-database-plugin\",\"connection_url\":\"postgresql://{{username}}:{{password}}@knowledge-db:5432/knowledge?sslmode=disable\",\"username\":\"kdocs_issuer\",\"password\":\"%s\",\"allowed_roles\":\"kdocs-*\",\"verify_connection\":false,\"password_authentication\":\"scram-sha-256\"}" "$pw" |
        bao write database/config/knowledge-db - >/dev/null
      printf "SET log_statement = '"'"'none'"'"';\n"
      printf "SET log_min_error_statement = '"'"'panic'"'"';\n"
      printf "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '"'"'kdocs_issuer'"'"') THEN CREATE ROLE kdocs_issuer; END IF; END \$\$;\n"
      printf "ALTER ROLE kdocs_issuer LOGIN NOSUPERUSER NOCREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '"'"'%s'"'"';\n" "$pw"
      printf "GRANT CONNECT ON DATABASE knowledge TO kdocs_issuer;\n"
      printf "GRANT pg_signal_backend TO kdocs_issuer;\n"
      printf "DO \$\$ DECLARE r text; BEGIN FOR r IN SELECT rolname FROM pg_roles WHERE rolname ~ '"'"'^kdocs_p[0-9a-f]{32}_read\$'"'"' LOOP EXECUTE format('"'"'GRANT %%I TO kdocs_issuer WITH ADMIN OPTION, INHERIT FALSE, SET FALSE'"'"', r); END LOOP; END \$\$;\n"')" ||
    fail "could not write the connection knowledge-db (token valid? OpenBao configured?)"
  case "$sql" in *"ALTER ROLE kdocs_issuer"*) ;; *) fail "could not write the connection knowledge-db; run the command again" ;; esac
  printf '%s\n' "$sql" | compose exec -T knowledge-db sh -c "$psql_admin" >/dev/null 2>&1 ||
    fail "could not set up the knowledge-db role kdocs_issuer (database made by knowledge-db/init?); run the command again"
  unset sql
  printf '%s\n' "$token" | bao_exec sh -c 'set -e
    IFS= read -r BAO_TOKEN && export BAO_TOKEN
    bao write -f database/rotate-root/knowledge-db >/dev/null' ||
    fail "OpenBao could not log in to knowledge-db as kdocs_issuer; run the command again"
  say "knowledge-db role kdocs_issuer set up; connection knowledge-db written (roles kdocs-* only) and its password rotated inside OpenBao"
}

# The backup job's AppRole (A10 PR 2, ADR-M63 §5): into the volume backup-approle of the one-shot
# service backup-agent, whose user is openbao.
cmd_backup_credentials() {
  require_unsealed
  token="$(read_secret 'Admin or root token (hidden)')"
  [ -n "$token" ] || fail "no token given"
  deliver_approle backup backup-agent /openbao/approle backup openbao:openbao
  say "backup AppRole credentials written to the backup-approle volume, old secret IDs revoked"
}

cmd_api_evidence_credentials() { pack_evidence_credentials api sdlcapiev sdlc-api; }

# Every AppRole secret ID in one pass, with one admin token (O05, ADR-M102, runbook T11 §8.1):
# the five commands doctor watches (`credentials.approle`). An AppRole with no secret ID yet is
# skipped (its profile or feature is not set up here); any other answer (a token without the
# right, a missing role) stops the pass, so "renewed" is never claimed for nothing. A failing
# command stops the pass with its own message; running it again is safe. The S3, ClickHouse and
# database credentials do not expire.
secret_id_state() {
  printf '%s\n' "$rotate_token" | bao_exec sh -c 'IFS= read -r BAO_TOKEN && export BAO_TOKEN
    out="$(bao list -format=json "auth/approle/role/$1/secret-id" 2>&1)"
    case "$out" in
      "{}") echo none ;;
      "["*) echo some ;;
      *) echo error ;;
    esac' sh "$1"
}

cmd_rotate_credentials() {
  require_unsealed
  token="$(read_secret 'Admin or root token (hidden)')"
  [ -n "$token" ] || fail "no token given"
  printf '%s\n' "$token" |
    bao_exec sh -c 'IFS= read -r BAO_TOKEN && export BAO_TOKEN && bao token lookup >/dev/null' ||
    fail "the token is not valid (expired, revoked or mistyped)"
  rotate_token="$token"
  # Each credentials command below asks for the token again: it gets the one given here.
  read_secret() { printf '%s' "$rotate_token"; }
  renewed=""
  for role in api worker runner litellm backup; do
    case "$(secret_id_state "$role")" in
      none)
        say "$role: no secret ID yet, so it is not set up here; skipped"
        continue
        ;;
      some) ;;
      *) fail "could not list the secret IDs of the AppRole $role (an admin token? OpenBao configured?); renewed so far:${renewed:- none}" ;;
    esac
    case "$role" in
      api) cmd_api_credentials ;;
      worker) cmd_worker_credentials ;;
      runner) cmd_runner_credentials ;;
      litellm) cmd_litellm_credentials ;;
      backup) cmd_backup_credentials ;;
    esac
    renewed="$renewed $role"
  done
  [ -n "$renewed" ] || fail "no AppRole has a secret ID here, so nothing was renewed"
  say "secret IDs renewed:$renewed; restart the services named above to log in with them at once (runbook T11 section 8.1)"
}
cmd_worker_evidence_credentials() { pack_evidence_credentials worker sdlcwrkev sdlc-worker; }

case "$command" in
  status) cmd_status ;;
  init) cmd_init ;;
  unseal) cmd_unseal ;;
  configure) cmd_configure ;;
  root-token) cmd_root_token ;;
  litellm-credentials) cmd_litellm_credentials ;;
  backup-credentials) cmd_backup_credentials ;;
  api-credentials) cmd_api_credentials ;;
  worker-credentials) cmd_worker_credentials ;;
  runner-credentials) cmd_runner_credentials ;;
  runner-evidence-credentials) cmd_runner_evidence_credentials ;;
  api-evidence-credentials) cmd_api_evidence_credentials ;;
  worker-evidence-credentials) cmd_worker_evidence_credentials ;;
  worker-purge-credentials) cmd_worker_purge_credentials ;;
  worker-anchor-credentials) cmd_worker_anchor_credentials ;;
  worker-langfuse-credentials) cmd_worker_langfuse_credentials ;;
  worker-knowledge-credentials) cmd_worker_knowledge_credentials ;;
  knowledge-issuer-credentials) cmd_knowledge_issuer_credentials ;;
  api-github-oauth-credentials) cmd_api_github_oauth_credentials ;;
  rotate-credentials) cmd_rotate_credentials ;;
esac
