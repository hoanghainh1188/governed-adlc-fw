#!/bin/sh
# Checks the team access settings before up.sh starts the profile `access` (V09, design/ADR-M67).
# Prints every problem; exit 1 when one blocks, 0 otherwise (warnings only). Reads no secret.
#
# Usage: access/check-settings.sh <env-file> <profile>...
# A value set in the environment wins over the env file, as in Compose.
set -eu

deploy_dir="$(cd "$(dirname "$0")/.." && pwd)"
env_file="$1"
shift
profiles=" $* "

problem=0
block() {
  echo "up: access: $*" >&2
  problem=1
}
warn() { echo "up: access: warning: $*" >&2; }

# setting <name> <default>: the environment's value, else the env file's, else the default.
setting() {
  if eval "[ -n \"\${$1+x}\" ]"; then
    eval "printf '%s' \"\$$1\""
    return
  fi
  v="$(sed -n "s/^$1=//p" "$env_file" | tail -n 1)"
  printf '%s' "${v:-$2}"
}

# ip_int <a.b.c.d>: the address as a number; empty when it is not an IPv4 address.
ip_int() {
  printf '%s\n' "$1" | awk -F. 'NF == 4 {
    for (i = 1; i <= 4; i++) if ($i !~ /^[0-9]+$/ || $i > 255) exit
    print (($1 * 256 + $2) * 256 + $3) * 256 + $4 }'
}

# cidr <a.b.c.d/n>: "first last" addresses as numbers; empty when invalid.
cidr() {
  case "$1" in */*) ;; *) return 0 ;; esac
  base="$(ip_int "${1%/*}")"
  bits="${1#*/}"
  printf '%s' "$bits" | grep -Eq '^[0-9]+$' || return 0
  [ -n "$base" ] && [ "$bits" -ge 8 ] && [ "$bits" -le 30 ] || return 0
  awk -v b="$base" -v n="$bits" 'BEGIN {
    size = 2 ^ (32 - n); first = b - (b % size); print first, first + size - 1 }'
}

case "$profiles" in *" platform "*) ;; *) block "start the profile platform in the same call (up.sh ... platform access)" ;; esac

bind="$(setting SDLC_ACCESS_BIND_ADDR '')"
if [ -z "$bind" ]; then
  block "set SDLC_ACCESS_BIND_ADDR to the server's LAN address (README \"Team access\")"
elif [ -z "$(ip_int "$bind")" ]; then
  block "SDLC_ACCESS_BIND_ADDR is not an IPv4 address: $bind"
elif [ "$bind" = 0.0.0.0 ]; then
  warn "SDLC_ACCESS_BIND_ADDR=0.0.0.0 publishes the proxy on every address of this machine; prefer the LAN address"
fi

host="$(setting SDLC_ACCESS_HOSTNAME '')"
[ -n "$host" ] || block "set SDLC_ACCESS_HOSTNAME to the name people open (a DNS name, never an IP address)"
port="$(setting SDLC_ACCESS_HOST_PORT 8443)"

# The network `access` (ADR-M67 §2.5, §2.6).
subnet="$(setting SDLC_ACCESS_NETWORK_SUBNET 172.30.1.0/29)"
range="$(setting SDLC_ACCESS_NETWORK_IP_RANGE 172.30.1.0/30)"
proxy="$(setting SDLC_ACCESS_PROXY_IP 172.30.1.6)"
sdlc_subnet="$(setting SDLC_NETWORK_SUBNET 172.30.0.0/24)"
s="$(cidr "$subnet")"
r="$(cidr "$range")"
n="$(cidr "$sdlc_subnet")"
p="$(ip_int "$proxy")"
if [ -z "$s" ] || [ -z "$r" ] || [ -z "$p" ]; then
  block "SDLC_ACCESS_NETWORK_SUBNET, SDLC_ACCESS_NETWORK_IP_RANGE and SDLC_ACCESS_PROXY_IP must be IPv4 networks and an address"
else
  set -- $s $r $n
  s1=$1 s2=$2 r1=$3 r2=$4
  if [ "$p" -le "$s1" ] || [ "$p" -ge "$s2" ]; then
    block "SDLC_ACCESS_PROXY_IP $proxy is not a host address of SDLC_ACCESS_NETWORK_SUBNET $subnet"
  elif [ "$p" -eq $((s1 + 1)) ]; then
    block "SDLC_ACCESS_PROXY_IP $proxy is the gateway of $subnet"
  elif [ "$p" -ge "$r1" ] && [ "$p" -le "$r2" ]; then
    block "SDLC_ACCESS_PROXY_IP $proxy is inside the allocation range $range: Docker could give it to the api"
  fi
  if [ "$r1" -lt "$s1" ] || [ "$r2" -gt "$s2" ]; then
    block "SDLC_ACCESS_NETWORK_IP_RANGE $range is not inside $subnet"
  fi
  if [ "$#" -eq 6 ] && [ "$s1" -le "$6" ] && [ "$5" -le "$s2" ]; then
    block "SDLC_ACCESS_NETWORK_SUBNET $subnet overlaps SDLC_NETWORK_SUBNET $sdlc_subnet"
  fi
fi

trusted="$(setting SDLC_API_TRUSTED_PROXY '')"
[ "$trusted" = "$proxy" ] ||
  block "set SDLC_API_TRUSTED_PROXY=$proxy (the proxy's address), so the api's per-address limits count each client"

signin="$(setting SDLC_API_WEB_SIGNIN off)"
origin="$(setting SDLC_API_PUBLIC_ORIGIN '')"
if [ -n "$host" ]; then
  expected="https://$host"
  [ "$port" = 443 ] || expected="$expected:$port"
  if [ -n "$origin" ] && [ "$origin" != "$expected" ]; then
    block "SDLC_API_PUBLIC_ORIGIN must be $expected with the profile access (one public origin, ADR-M67 §2.8)"
  elif [ "$signin" = github ] && [ -z "$origin" ]; then
    block "set SDLC_API_PUBLIC_ORIGIN=$expected for the GitHub sign-in"
  fi
fi

# GitHub webhooks (O08, ADR-M112 §2.1-§2.2): their own listener, only for the edge's address.
# The allow value goes into the nginx configuration, so only an address or a network passes.
allow_ok() {
  printf '%s' "$1" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}(/[0-9]{1,2})?$' || return 1
  [ -n "$(ip_int "${1%/*}")" ] || return 1
  case "$1" in */*) [ "${1#*/}" -le 32 ] ;; esac
}
wh_bind="$(setting SDLC_ACCESS_WEBHOOK_BIND_ADDR '')"
wh_port="$(setting SDLC_ACCESS_WEBHOOK_HOST_PORT 8444)"
wh_allow="$(setting SDLC_ACCESS_WEBHOOK_ALLOW_CIDR '')"
webhooks="$(setting SDLC_API_GITHUB_WEBHOOKS off)"
if [ -n "$wh_bind" ]; then
  if [ -z "$(ip_int "$wh_bind")" ]; then
    block "SDLC_ACCESS_WEBHOOK_BIND_ADDR is not an IPv4 address: $wh_bind"
  elif [ "$wh_port" = "$port" ]; then
    block "SDLC_ACCESS_WEBHOOK_HOST_PORT must differ from SDLC_ACCESS_HOST_PORT ($port): webhooks never use the LAN port"
  fi
  if [ -z "$wh_allow" ]; then
    block "set SDLC_ACCESS_WEBHOOK_ALLOW_CIDR to the address of the edge that forwards GitHub's deliveries (README \"GitHub webhooks\")"
  elif ! allow_ok "$wh_allow"; then
    block "SDLC_ACCESS_WEBHOOK_ALLOW_CIDR is not one IPv4 address or network: $wh_allow"
  elif [ "${wh_allow%/*}" = 0.0.0.0 ] && [ "${wh_allow#*/}" = 0 ]; then
    warn "SDLC_ACCESS_WEBHOOK_ALLOW_CIDR=0.0.0.0/0 admits every address to the webhook listener; prefer the edge's address"
  fi
  [ "$webhooks" = on ] ||
    warn "the webhook listener is set, but SDLC_API_GITHUB_WEBHOOKS is off: every delivery answers 404"
elif [ "$webhooks" = on ]; then
  warn "SDLC_API_GITHUB_WEBHOOKS=on, but SDLC_ACCESS_WEBHOOK_BIND_ADDR is empty: no delivery can reach the api through the proxy"
fi

# The certificate: missing or wrong blocks; ending within 30 days warns.
tls_dir="$(setting SDLC_ACCESS_TLS_DIR '')"
if [ -z "$tls_dir" ]; then
  block "set SDLC_ACCESS_TLS_DIR (test machine: pnpm access:tls dev; server: runbook T11 section 3d)"
elif [ -n "$host" ]; then
  if ! out="$(SDLC_ENV_FILE="$env_file" SDLC_ACCESS_TLS_DIR="$tls_dir" SDLC_ACCESS_HOSTNAME="$host" \
    SDLC_ACCESS_IPS="$(setting SDLC_ACCESS_IPS '')" "$deploy_dir/access/tls.sh" check 2>&1)"; then
    case "$out" in
      *"ends within"*) warn "the proxy's certificate ends soon (runbook T11 section 3d): $out" ;;
      *) block "the proxy's certificate cannot be used: $out" ;;
    esac
  fi
fi

exit "$problem"
