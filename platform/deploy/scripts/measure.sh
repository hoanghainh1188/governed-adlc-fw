#!/bin/sh
# Resource measurement of a running deployment (task A10 AC4, PR 3a): memory and CPU of every
# container of the Compose project, sampled for a while, and the disk its images and volumes use.
#
# Read only: it runs `docker info`, `docker ps`, `docker stats --no-stream`, `docker image inspect`,
# `docker volume ls` and `docker system df -v`, nothing else. It prints numbers and the names of services, images
# and volumes; never an env value, a log line or a container's environment. The output is a
# Markdown table for the deploy README ("Resource estimate") and the pull request.
#
# Usage: platform/deploy/scripts/measure.sh [--env <file>] [--samples <n>] [--interval <seconds>]
#                                           [--all]
#   --env       Compose env file (default: SDLC_ENV_FILE, else platform/deploy/.env); only its
#               COMPOSE_PROJECT_NAME is read.
#   --samples   How many samples (default 12).
#   --interval  Seconds between two samples (default 5).
#   --all       Every container of this Docker Engine, not only the project's: for the runner's
#               own Engine, where the sandboxes are not Compose services.
set -eu

deploy_dir="$(cd "$(dirname "$0")/.." && pwd)"
env_file="${SDLC_ENV_FILE:-$deploy_dir/.env}"
samples=12
interval=5
all=no

fail() {
  echo "measure: $*" >&2
  exit 1
}
number() {
  case "$2" in "" | *[!0-9]*) fail "$1 needs a whole number" ;; esac
  [ "$2" -ge 1 ] || fail "$1 needs a number of at least 1"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --env)
      [ "$#" -ge 2 ] || fail "--env needs a file"
      env_file="$2"
      shift 2
      ;;
    --samples)
      [ "$#" -ge 2 ] || fail "--samples needs a number"
      number --samples "$2"
      samples="$2"
      shift 2
      ;;
    --interval)
      [ "$#" -ge 2 ] || fail "--interval needs a number"
      number --interval "$2"
      interval="$2"
      shift 2
      ;;
    --all)
      all=yes
      shift
      ;;
    -h | --help)
      sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) fail "unknown option: $1" ;;
  esac
done

command -v docker >/dev/null 2>&1 || fail "docker is required"

project=""
if [ "$all" = no ]; then
  [ -f "$env_file" ] || fail "$env_file not found (or use --all on the runner's own Engine)"
  project="$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$env_file" | tail -n 1)"
  [ -n "$project" ] || fail "COMPOSE_PROJECT_NAME is not set in $env_file"
  case "$project" in *[!A-Za-z0-9_-]*) fail "COMPOSE_PROJECT_NAME has an unexpected character" ;; esac
fi

# "<container ID> <service or container name> <image>" per line.
containers() {
  if [ "$all" = yes ]; then
    docker ps --no-trunc --format '{{.ID}} {{.Names}} {{.Image}}'
  else
    docker ps --no-trunc --filter "label=com.docker.compose.project=$project" \
      --format '{{.ID}} {{.Label "com.docker.compose.service"}} {{.Image}}'
  fi
}

list="$(containers | sort -k 2,2)" || fail "docker ps failed"
[ -n "$list" ] || fail "no running container found; start the profiles to measure first"

host="$(docker info --format '{{.NCPU}} {{.MemTotal}} {{.ServerVersion}}')" || fail "docker info failed"

# One sample: "<container ID> <cpu %> <memory in use>" per line. The IDs are given, so a container
# of another project is never read.
raw=""
i=1
while [ "$i" -le "$samples" ]; do
  # shellcheck disable=SC2046 # the container IDs are separate arguments
  sample="$(docker stats --no-stream --no-trunc --format '{{.ID}} {{.CPUPerc}} {{.MemUsage}}' \
    $(printf '%s\n' "$list" | awk '{ print $1 }'))" ||
    fail "docker stats failed (did a container stop? start it and run this again)"
  raw="$raw$sample
"
  [ "$i" -eq "$samples" ] || sleep "$interval"
  i=$((i + 1))
done

echo "## Resource measurement"
echo
printf '%s\n' "$host" | awk -v samples="$samples" -v interval="$interval" '{
  printf "- Host: %d CPUs, %.1f GiB RAM, Docker Engine %s\n", $1, $2 / 1073741824, $3
  printf "- %d samples, %d s apart\n", samples, interval
}'
echo
echo "| Service | Memory, mean (MiB) | Memory, peak (MiB) | CPU, mean (% of one core) | CPU, peak (%) |"
echo "|---|---|---|---|---|"
{
  printf '%s\n' "$list" | awk '{ print "N", $1, $2 }'
  printf '%s' "$raw" | awk 'NF >= 3 { print "S", $1, $2, $3 }'
} | awk '
  function mib(text,    value) {
    value = text + 0
    if (text ~ /GiB$/) return value * 1024
    if (text ~ /MiB$/) return value
    if (text ~ /KiB$/) return value / 1024
    if (text ~ /GB$/) return value * 1000 * 1000 * 1000 / 1048576
    if (text ~ /MB$/) return value * 1000 * 1000 / 1048576
    if (text ~ /kB$/) return value * 1000 / 1048576
    return value / 1048576
  }
  $1 == "N" { name[$2] = $3; order[++count] = $2; next }
  $1 == "S" && ($2 in name) {
    cpu = $3 + 0
    mem = mib($4)
    n[$2]++
    cpu_sum[$2] += cpu
    mem_sum[$2] += mem
    if (cpu > cpu_peak[$2]) cpu_peak[$2] = cpu
    if (mem > mem_peak[$2]) mem_peak[$2] = mem
    round = n[$2]
    cpu_round[round] += cpu
    mem_round[round] += mem
    if (round > rounds) rounds = round
  }
  END {
    for (i = 1; i <= count; i++) {
      id = order[i]
      if (n[id] == 0) continue
      printf "| `%s` | %.0f | %.0f | %.1f | %.1f |\n", name[id], mem_sum[id] / n[id], mem_peak[id], cpu_sum[id] / n[id], cpu_peak[id]
    }
    for (r = 1; r <= rounds; r++) {
      cpu_total += cpu_round[r]
      mem_total += mem_round[r]
      if (cpu_round[r] > cpu_top) cpu_top = cpu_round[r]
      if (mem_round[r] > mem_top) mem_top = mem_round[r]
    }
    if (rounds > 0)
      printf "| **All** | **%.0f** | **%.0f** | **%.1f** | **%.1f** |\n", mem_total / rounds, mem_top, cpu_total / rounds, cpu_top
  }'

echo
echo "| Images in use | Size (GB) |"
echo "|---|---|"
image_total=0
for image in $(printf '%s\n' "$list" | awk '{ print $3 }' | sort -u); do
  size="$(docker image inspect --format '{{.Size}}' "$image" 2>/dev/null)" || continue
  # Without the registry and the digest: the name and the tag are enough to read the table.
  short="$(printf '%s' "$image" | sed 's/@sha256:.*//; s|.*/||')"
  awk -v name="$short" -v size="$size" 'BEGIN { printf "| `%s` | %.2f |\n", name, size / 1e9 }'
  image_total="$(awk -v a="$image_total" -v b="$size" 'BEGIN { printf "%.0f", a + b }')"
done
awk -v size="$image_total" 'BEGIN { printf "| **All** (shared layers counted in each image) | **%.2f** |\n", size / 1e9 }'

echo
echo "| Volume | Size |"
echo "|---|---|"
volumes="$(docker system df -v --format '{{range .Volumes}}{{println .Name .Size}}{{end}}')" ||
  fail "docker system df failed"
# The project's own volumes by their label, so a project whose name only starts the same is
# never counted.
own=""
if [ "$all" = no ]; then
  own="$(docker volume ls --filter "label=com.docker.compose.project=$project" --format '{{.Name}}')" ||
    fail "docker volume ls failed"
fi
{
  printf '%s\n' "$own" | awk 'NF { print "O", $1 }'
  printf '%s\n' "$volumes" | sort | awk 'NF >= 2 { print "V", $1, $2 }'
} | awk -v all="$all" '
  $1 == "O" { mine[$2] = 1; next }
  $1 == "V" && (all == "yes" || ($2 in mine)) { printf "| `%s` | %s |\n", $2, $3; found = 1 }
  END { if (!found) print "| (none) | |" }'
