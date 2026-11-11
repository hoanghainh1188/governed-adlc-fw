#!/bin/sh
# Runs the database integration tests (task A06, design/ADR-M09 section 2.6).
#
# Usage: platform/deploy/scripts/test-db.sh [vitest arguments]
#
# - SDLC_TEST_DATABASE_URL set: uses that server. It must be a superuser URL of a server whose
#   roles come from platform/deploy/postgres/init (for example the Compose core profile).
# - Otherwise: starts a throw-away PostgreSQL container (same image as Compose, same init script,
#   random passwords, port bound to 127.0.0.1) and removes it afterwards.
# - SDLC_TEST_DB_DOCKER_HOST: Engine for that throw-away container (H07). When the default
#   DOCKER_HOST is a runner Engine with the AuthZ denylist (refuseBinds / refusePortBindings),
#   point this at another Engine (the machine's Docker) so postgres can still use -v and -p.
# Each test file creates and drops its own database, so the server is never modified otherwise.
set -eu

repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
deploy_dir="$repo_root/platform/deploy"
# SDLC_TEST_DB_DIR: another test folder that needs the database (for example the runner live tests).
tests="${SDLC_TEST_DB_DIR:-platform/tests/integration/db}"

# Docker client for the throw-away DB only (sandboxes keep using DOCKER_HOST).
db_docker() {
  if [ -n "${SDLC_TEST_DB_DOCKER_HOST:-}" ]; then
    DOCKER_HOST="$SDLC_TEST_DB_DOCKER_HOST" docker "$@"
  else
    docker "$@"
  fi
}

run_tests() {
  cd "$repo_root"
  SDLC_REQUIRE_DB=1 pnpm exec vitest run --config vitest.integration.config.ts "$tests" "$@"
}

if [ -n "${SDLC_TEST_DATABASE_URL:-}" ]; then
  run_tests "$@"
  exit
fi

command -v docker >/dev/null 2>&1 || { echo "test-db: docker is required (or set SDLC_TEST_DATABASE_URL)" >&2; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo "test-db: openssl is required" >&2; exit 1; }

# One source for the image: the postgres service of the compose file. Matches the exact line
# `    image: postgres:<tag>` (4 spaces, nothing after the tag); fails loudly if that format changes.
image="$(sed -n 's/^    image: \(postgres:[^ ]*\)$/\1/p' "$deploy_dir/docker-compose.yml" | head -n 1)"
[ -n "$image" ] || { echo "test-db: postgres image not found in docker-compose.yml" >&2; exit 1; }

name="sdlc-test-db-$$"
superuser_password="$(openssl rand -hex 24)"
cleanup() { db_docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

db_docker run -d --name "$name" \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD="$superuser_password" \
  -e PLATFORM_DB_PASSWORD="$(openssl rand -hex 24)" \
  -e PLATFORM_APP_DB_PASSWORD="$(openssl rand -hex 24)" \
  -e TEMPORAL_DB_PASSWORD="$(openssl rand -hex 24)" \
  -e LITELLM_DB_PASSWORD="$(openssl rand -hex 24)" \
  -e LANGFUSE_DB_PASSWORD="$(openssl rand -hex 24)" \
  -v "$deploy_dir/postgres/init:/docker-entrypoint-initdb.d:ro" \
  -p 127.0.0.1::5432 \
  "$image" >/dev/null

# The init scripts run on a temporary server without TCP; wait for the final server on TCP.
timeout="${SDLC_TEST_DB_TIMEOUT:-120}"
waited=0
until db_docker exec "$name" pg_isready -q -h 127.0.0.1 -U postgres -d postgres; do
  if [ "$(db_docker inspect -f '{{.State.Running}}' "$name")" != true ] || [ "$waited" -ge "$timeout" ]; then
    echo "test-db: PostgreSQL did not become ready" >&2
    db_docker logs "$name" >&2 || true
    exit 1
  fi
  sleep 1
  waited=$((waited + 1))
done

port="$(db_docker port "$name" 5432/tcp | head -n 1 | sed 's/.*://')"
SDLC_TEST_DATABASE_URL="postgres://postgres:$superuser_password@127.0.0.1:$port/postgres" \
  run_tests "$@"
