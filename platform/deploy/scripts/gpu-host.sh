#!/bin/sh
# vLLM on a separate GPU host (task L01 PR 2, design/ADR-M71 §4.1): starts and stops the GPU host's
# Compose project. Runs on the GPU host. Deploy README "Self-hosted model on a separate GPU host".
#
# Usage: platform/deploy/scripts/gpu-host.sh env     # once: gpu-host/.env
#        platform/deploy/scripts/gpu-host.sh pull    # once: the weights into the volume vllm-models
#        platform/deploy/scripts/gpu-host.sh up      # vllm and the gateway
#        platform/deploy/scripts/gpu-host.sh down
#        platform/deploy/scripts/gpu-host.sh ps
#
# Environment:
#   SDLC_GPU_HOST_ENV_FILE  env file (default: platform/deploy/gpu-host/.env)
#   SDLC_WAIT_TIMEOUT       seconds to wait for health (default: 1200: loading weights is slow)
set -eu

deploy_dir="$(cd "$(dirname "$0")/.." && pwd)"
host_dir="$deploy_dir/gpu-host"
env_file="${SDLC_GPU_HOST_ENV_FILE:-$host_dir/.env}"

fail() {
  echo "gpu-host: $*" >&2
  exit 1
}

command="${1:-}"
[ -n "$command" ] || fail "usage: gpu-host.sh env | pull | up | down | ps"
shift
[ "$#" -eq 0 ] || fail "$command takes no argument"

if [ "$command" = env ]; then
  [ -e "$env_file" ] && fail "$env_file already exists; not overwriting"
  cp "$host_dir/.env.example" "$env_file"
  chmod 600 "$env_file"
  echo "gpu-host: $env_file written; set SDLC_GPU_LINK_ADDR and SDLC_GPU_LINK_TLS_DIR"
  exit 0
fi

[ -f "$env_file" ] || fail "$env_file not found; run: pnpm gpu-host:env"
value() { sed -n "s/^$1=//p" "$env_file" | tail -n 1; }

# The GPU host never runs a platform service: refuse an Engine that holds the platform's data
# (ADR-M71 §4.1). On the platform server, use the profile models-local instead.
project="$(value COMPOSE_PROJECT_NAME)"
if [ -n "$(docker volume ls -q --filter "label=com.docker.compose.project=${project:-sdlc}" \
  --filter label=com.docker.compose.volume=postgres-data 2>/dev/null || true)" ]; then
  fail "this Docker Engine holds the platform's data (volume postgres-data): on the platform server use the profile models-local (ADR-M71)"
fi

compose() { docker compose -f "$host_dir/docker-compose.yml" --env-file "$env_file" "$@"; }

case "$command" in
  pull) compose --profile pull run --rm vllm-pull ;;
  up)
    [ -n "$(value SDLC_GPU_LINK_ADDR)" ] || fail "SDLC_GPU_LINK_ADDR is empty in $env_file"
    tls_dir="$(value SDLC_GPU_LINK_TLS_DIR)"
    [ -n "$tls_dir" ] || fail "SDLC_GPU_LINK_TLS_DIR is empty in $env_file (gpu-link/tls.sh; runbook T11 section 5d.2)"
    # A certificate that ends within 30 days only warns.
    "$deploy_dir/gpu-link/tls.sh" check "$tls_dir" >/dev/null 2>&1 || {
      "$deploy_dir/gpu-link/tls.sh" check "$tls_dir" >&2 || true
      echo "gpu-host: warning: the gateway's certificate is missing, invalid or ends soon (runbook T11 section 5d.2)" >&2
    }
    compose up -d --wait --wait-timeout "${SDLC_WAIT_TIMEOUT:-1200}" vllm vllm-gateway
    echo "gpu-host: vllm and the gateway are healthy"
    ;;
  down) compose --profile pull down ;;
  ps) compose ps -a ;;
  *) fail "unknown command: $command" ;;
esac
