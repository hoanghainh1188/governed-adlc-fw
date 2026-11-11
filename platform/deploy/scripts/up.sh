#!/bin/sh
# Starts the platform infrastructure and waits until it is ready (task A02).
#
# Usage: platform/deploy/scripts/up.sh <profile>...
#   e.g. up.sh core
#        up.sh core observability
#        up.sh core models platform access   (team access, V09: README "Team access")
#        up.sh core models models-local      (self-hosted model, L01: README "Self-hosted model")
#        up.sh core models models-remote     (vLLM on a separate GPU host, L01 PR 2: README
#                                            "Self-hosted model on a separate GPU host")
#        up.sh core models platform runner-link (the runner on its own Engine, O01: README "The
#                                            runner on its own Docker Engine")
#
# Environment:
#   SDLC_ENV_FILE      env file (default: platform/deploy/.env, created by init-env.sh)
#   SDLC_WAIT_TIMEOUT  seconds to wait for health (default: 300)
#   SDLC_IMAGES        published | local: the platform images (default: scripts/images.sh mode)
#
# "docker compose up --wait" reports one-shot jobs that exit 0 as failures, so this
# script waits for long-running services to be healthy and, separately, checks that
# every one-shot job exited with code 0.
set -eu

# One-shot jobs (restart: "no"). A static test keeps this list in sync with docker-compose.yml.
JOBS="backup-agent openbao-tls-init temporal-schema temporal-namespace seaweedfs-init access-tls-init vllm-pull vllm-link-tls-init"

[ "$#" -gt 0 ] || { echo "usage: $0 <profile>..." >&2; exit 2; }

deploy_dir="$(cd "$(dirname "$0")/.." && pwd)"
env_file="${SDLC_ENV_FILE:-$deploy_dir/.env}"
[ -f "$env_file" ] || { echo "up: $env_file not found; run scripts/init-env.sh first" >&2; exit 1; }

# vLLM on a separate GPU host (L01 PR 2, design/ADR-M71 §4.2): models-remote and models-local both
# put a service named vllm on `models`, so never together; models-remote needs its settings. A
# link certificate that ends within 30 days only warns.
case " $* " in
  *" models-remote "*)
    case " $* " in
      *" models-local "*)
        echo "up: the profiles models-local and models-remote cannot run together: vLLM is either on this server or on the GPU host (README \"Self-hosted model on a separate GPU host\")" >&2
        exit 1
        ;;
    esac
    for key in SDLC_GPU_HOST_NAME SDLC_GPU_HOST_ADDR SDLC_VLLM_LINK_TLS_DIR; do
      if [ -z "$(sed -n "s/^$key=//p" "$env_file" | tail -n 1)" ]; then
        echo "up: $key is not set in $env_file; the profile models-remote needs it (README \"Self-hosted model on a separate GPU host\")" >&2
        exit 1
      fi
    done
    link_tls="$(sed -n 's/^SDLC_VLLM_LINK_TLS_DIR=//p' "$env_file" | tail -n 1)"
    if ! "$deploy_dir/gpu-link/tls.sh" check "$link_tls" >/dev/null 2>&1; then
      "$deploy_dir/gpu-link/tls.sh" check "$link_tls" >&2 || true
      echo "up: warning: the link's client certificate is missing, invalid or ends soon (runbook T11 section 5d.2)" >&2
    fi
    ;;
esac

# Tracing (A08, design/ADR-M35 §2.4): with the profile observability, the platform processes and
# LiteLLM send traces to the collector, unless SDLC_OTEL_ENDPOINT is set in the environment or the
# env file. The profiles that use it (platform, models) must be started in the same call.
# The Langfuse purge (E08, design/ADR-M53): with the profile observability, or when Langfuse's
# ClickHouse volume exists, the worker purges the traces of purged intents in Langfuse, unless
# SDLC_WORKER_LANGFUSE_URL is set elsewhere.
case " $* " in
  *" observability "*)
    if [ -z "${SDLC_OTEL_ENDPOINT:-}" ] && ! grep -Eq '^SDLC_OTEL_ENDPOINT=.+' "$env_file"; then
      SDLC_OTEL_ENDPOINT=http://otel-collector:4318
      export SDLC_OTEL_ENDPOINT
    fi
    langfuse_on=yes
    ;;
  *)
    # Without observability in this call, Langfuse may still hold traces from an earlier start:
    # its ClickHouse volume exists. Then the worker keeps purging (or waits until Langfuse runs),
    # and never records `not_deployed` for data that is still there (review of E08).
    project="$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$env_file" | tail -n 1)"
    if [ -n "$(docker volume ls -q \
      --filter "label=com.docker.compose.project=${project:-deploy}" \
      --filter label=com.docker.compose.volume=clickhouse-data 2>/dev/null || true)" ]; then
      langfuse_on=yes
    fi
    ;;
esac
if [ "${langfuse_on:-no}" = yes ] && [ -z "${SDLC_WORKER_LANGFUSE_URL:-}" ] &&
  ! grep -Eq '^SDLC_WORKER_LANGFUSE_URL=.+' "$env_file"; then
  SDLC_WORKER_LANGFUSE_URL=http://langfuse-web:3000
  export SDLC_WORKER_LANGFUSE_URL
fi

# The index of project documents (X04 PR 3a, design/ADR-M89): with the profile knowledge, or when
# knowledge-db's volume exists, the worker builds indexes there, unless the URL is set elsewhere.
case " $* " in
  *" knowledge "*) knowledge_on=yes ;;
  *)
    project="$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$env_file" | tail -n 1)"
    if [ -n "$(docker volume ls -q \
      --filter "label=com.docker.compose.project=${project:-deploy}" \
      --filter label=com.docker.compose.volume=knowledge-db-data 2>/dev/null || true)" ]; then
      knowledge_on=yes
    fi
    ;;
esac
if [ "${knowledge_on:-no}" = yes ] && [ -z "${SDLC_WORKER_KNOWLEDGE_DB_URL:-}" ] &&
  ! grep -Eq '^SDLC_WORKER_KNOWLEDGE_DB_URL=.+' "$env_file"; then
  SDLC_WORKER_KNOWLEDGE_DB_URL=postgresql://knowledge@knowledge-db:5432/knowledge
  export SDLC_WORKER_KNOWLEDGE_DB_URL
fi

# OpenBao's TLS certificates (A10, design/ADR-M63): warn 30 days before they end; never block.
if ! SDLC_ENV_FILE="$env_file" "$deploy_dir/openbao/tls.sh" check >/dev/null 2>&1; then
  SDLC_ENV_FILE="$env_file" "$deploy_dir/openbao/tls.sh" check >&2 || true
  echo "up: warning: OpenBao's TLS certificate is missing or ends soon (runbook T11 section 3c)" >&2
fi

# Team access (V09, design/ADR-M67): the profile access starts only with its settings checked
# (bind address, host name, the network `access`, the trusted proxy, the public origin, the
# certificate); a certificate ending within 30 days only warns.
case " $* " in
  *" access "*)
    "$deploy_dir/access/check-settings.sh" "$env_file" "$@" ||
      { echo "up: the profile access is not ready; nothing started (README \"Team access\")" >&2; exit 1; }
    ;;
esac

# Published images (V04, V15, design/ADR-M94 §2.4): on a release checkout, the images of the
# release's images.lock (an asset of its GitHub Release, or SDLC_IMAGES_LOCK) pinned by digest
# (overlay docker-compose.images.yml); everywhere else they are built locally from the checkout.
# SDLC_IMAGES=published|local overrides it (scripts/images.sh).
images_mode="$("$deploy_dir/scripts/images.sh" mode)"
if [ "$images_mode" = published ]; then
  for line in $("$deploy_dir/scripts/images.sh" export); do
    export "${line?}"
  done
  echo "up: using the published images of v$SDLC_IMAGES_VERSION (the images.lock of its GitHub Release)" >&2
fi

# The runner on its own Engine (O01, design/ADR-M91 §2.3): with SDLC_RUNNER_LINK_ADDR in the env
# file, the overlay docker-compose.runner-link.yml publishes the runner's services on that address
# only. The runner then runs on the runner host: the profile sandbox would start a second runner
# with the same instance label (R062), so it is refused; runner-link keeps the registry.
link_addr="$(sed -n 's/^SDLC_RUNNER_LINK_ADDR=//p' "$env_file" | tail -n 1)"
if [ -n "$link_addr" ]; then
  case " $* " in
    *" sandbox "*)
      echo "up: SDLC_RUNNER_LINK_ADDR is set: the runner runs on the runner host; use the profile runner-link, not sandbox (README \"The runner on its own Docker Engine\")" >&2
      exit 1
      ;;
  esac
fi

set -- $(for p in "$@"; do printf -- '--profile %s ' "$p"; done)
compose() {
  if [ "$images_mode" = published ]; then
    set -- -f "$deploy_dir/docker-compose.images.yml" --env-file "$env_file" "$@"
  else
    set -- --env-file "$env_file" "$@"
  fi
  if [ -n "$link_addr" ]; then
    set -- -f "$deploy_dir/docker-compose.runner-link.yml" "$@"
  fi
  docker compose -f "$deploy_dir/docker-compose.yml" "$@"
}

services="$(compose "$@" config --services)"
long_running=""
jobs=""
for s in $services; do
  case " $JOBS " in
    *" $s "*) jobs="$jobs $s" ;;
    *) long_running="$long_running $s" ;;
  esac
done

compose "$@" up -d
# shellcheck disable=SC2086
compose "$@" up -d --wait --wait-timeout "${SDLC_WAIT_TIMEOUT:-300}" $long_running

# Jobs have finished by now when a long-running service depends on them; otherwise poll.
failed=0
for job in $jobs; do
  tries=0
  while :; do
    line="$(compose "$@" ps -a --format '{{.State}} {{.ExitCode}}' "$job")" || {
      echo "up: cannot read the state of job $job (docker compose ps failed)" >&2
      exit 1
    }
    case "$line" in exited*) break ;; esac
    tries=$((tries + 1))
    if [ "$tries" -ge "${SDLC_WAIT_TIMEOUT:-300}" ]; then line="timeout"; break; fi
    sleep 1
  done
  if [ "$line" != "exited 0" ]; then
    echo "up: job $job did not complete (${line:-no container}); see: docker compose logs $job" >&2
    failed=1
  fi
done
[ "$failed" -eq 0 ] || exit 1
echo "up: all services healthy, all jobs completed"
