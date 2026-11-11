#!/bin/sh
# Certificates of the mutual TLS link between the platform server and a separate GPU host (task
# L01 PR 2, design/ADR-M71 §4.3). Runs on a host with OpenSSL 3 and, for `reload`, Docker.
# Procedure: runbook T11 section 5d.2.
#
# Two folders, each with the CA's certificate and never a CA key:
#   <folder>/platform/   ca.pem, client.pem, client-key.pem  -> SDLC_VLLM_LINK_TLS_DIR (platform)
#   <folder>/gpu-host/   ca.pem, server.pem, server-key.pem  -> SDLC_GPU_LINK_TLS_DIR (GPU host)
#
# Environment:
#   SDLC_GPU_LINK_CLIENT_CN  the client certificate's common name (default: sdlc-vllm-link)
#   SDLC_ENV_FILE            the platform's env file, for `reload platform`
#                            (default: platform/deploy/.env)
#   SDLC_GPU_HOST_ENV_FILE   the GPU host's env file, for `reload gpu-host`
#                            (default: platform/deploy/gpu-host/.env)
set -eu

deploy_dir="$(cd "$(dirname "$0")/.." && pwd)"
repo_dir="$(cd "$deploy_dir" && cd ../.. && pwd)"

ISSUE_DAYS=365 # 1 year, like OpenBao's and the access proxy's (QUESTIONS #20, #406)
DEV_DAYS=825   # throw-away CA and certificates; macOS refuses TLS certificates that last longer
WARN_DAYS=30   # the operator renews 30 days before the end (runbook T11 section 5d.2)
CLIENT_CN="${SDLC_GPU_LINK_CLIENT_CN:-sdlc-vllm-link}"

usage() {
  cat <<'EOF'
Usage: platform/deploy/gpu-link/tls.sh <command> [argument...]

Commands:
  dev <gpu-host-name> <folder>
                 A test or developer machine: make a throw-away CA, the GPU host's server
                 certificate and the link's client certificate in <folder>/gpu-host and
                 <folder>/platform, and delete the CA key at once. <folder> must be empty or new.
  issue <ca-folder> <gpu-host-name> <folder>
                 A server: issue both certificates (1 year) with the internal CA of <ca-folder>
                 (openbao/tls.sh ca) into <folder>/gpu-host and <folder>/platform, outside the
                 repository. Also the renewal.
  check <folder> [gpu-host-name]
                 Check a folder of either side: the chain, the key, the purpose, the name
                 (the GPU host's name for server.pem, SDLC_GPU_LINK_CLIENT_CN for client.pem) and
                 that nothing ends within 30 days. Exit 1 on any problem.
  reload platform|gpu-host
                 Copy the files of that side into its volume again and make nginx read them
                 (SIGHUP), without a restart.

Runbook: handbook/03-templates/T11-openbao-runbook.md, section 5d.2
EOF
}

say() { echo "gpu-link-tls: $*"; }
fail() {
  echo "gpu-link-tls: $*" >&2
  exit 1
}

[ "$#" -ge 1 ] || {
  usage >&2
  exit 2
}
command="$1"
shift
case "$command" in
  -h | --help | help)
    usage
    exit 0
    ;;
  dev | issue | check | reload) ;;
  *)
    usage >&2
    exit 2
    ;;
esac

need_openssl() {
  command -v openssl >/dev/null 2>&1 || fail "openssl (OpenSSL 3 or later) is required"
  case "$(openssl version 2>/dev/null)" in
    'OpenSSL '[3-9]*) ;;
    *) fail "OpenSSL 3 or later is required, not LibreSSL (macOS: brew install openssl@3, then put it first in PATH)" ;;
  esac
}

# host_name <name>: a DNS name, never an IP address (the link verifies the name).
host_name() {
  [ -n "$1" ] || fail "the GPU host's name is missing"
  printf '%s' "$1" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$' ||
    fail "the GPU host's name must be a DNS name: $1"
  printf '%s' "$1" | grep -Eq '^[0-9.]+$' && fail "the GPU host's name must be a name, not an IP address: $1"
  printf '%s' "$1"
}

client_cn() {
  printf '%s' "$CLIENT_CN" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$' ||
    fail "SDLC_GPU_LINK_CLIENT_CN must be letters, digits, dots and hyphens: $CLIENT_CN"
  printf '%s' "$CLIENT_CN"
}

inside_repo() {
  case "$1/" in "$repo_dir"/*) return 0 ;; *) return 1 ;; esac
}

# abs <folder>: the absolute path of a folder that may not exist yet (its parent must exist).
abs() {
  parent="$(cd "$(dirname "$1")" 2>/dev/null && pwd)" || fail "the parent folder of $1 does not exist"
  printf '%s/%s' "$parent" "$(basename "$1")"
}

# empty_or_new <folder>: refuse a folder that holds anything (never overwrite certificates).
empty_or_new() {
  if [ -e "$1" ]; then
    [ -d "$1" ] || fail "$1 is not a folder"
    [ -z "$(ls -A "$1")" ] || fail "$1 is not empty; nothing changed (renewal: issue into a new folder, then copy)"
  fi
}

# leaf <ca-folder> <work> <name> <cn> <days> <purpose> <san or empty>
leaf() {
  openssl ecparam -name prime256v1 -genkey -noout -out "$2/$3-key.pem" 2>/dev/null
  openssl req -new -key "$2/$3-key.pem" -subj "/CN=$4" -out "$2/$3.csr" 2>/dev/null
  {
    printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n'
    printf 'extendedKeyUsage=%s\n' "$6"
    [ -z "$7" ] || printf 'subjectAltName=%s\n' "$7"
  } >"$2/$3.cnf"
  openssl x509 -req -in "$2/$3.csr" -CA "$1/ca.pem" -CAkey "$1/ca-key.pem" -CAcreateserial \
    -CAserial "$2/ca.srl" -sha256 -days "$5" -extfile "$2/$3.cnf" -out "$2/$3.pem" 2>/dev/null
}

# install_side <work> <out> <kind>: ca.pem, <kind>.pem, <kind>-key.pem into <out>, keys mode 600.
install_side() {
  mkdir -p "$2"
  chmod 700 "$2"
  cp "$1/../ca.pem" "$2/ca.pem"
  cp "$1/$3.pem" "$2/$3.pem"
  (umask 077 && cp "$1/$3-key.pem" "$2/$3-key.pem")
  chmod 644 "$2/ca.pem" "$2/$3.pem"
  chmod 600 "$2/$3-key.pem"
}

# make_all <ca-folder> <host> <out> <days>: both sides, checked before they are installed.
make_all() {
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  mkdir "$work/s" "$work/c"
  cp "$1/ca.pem" "$work/ca.pem"
  leaf "$1" "$work/s" server "$2" "$4" serverAuth "DNS:$2"
  leaf "$1" "$work/c" client "$(client_cn)" "$4" clientAuth ""
  install_side "$work/s" "$work/out/gpu-host" server
  install_side "$work/c" "$work/out/platform" client
  verify "$work/out/gpu-host" "$2" || fail "the new server certificate does not verify"
  verify "$work/out/platform" "" || fail "the new client certificate does not verify"
  mkdir -p "$3"
  chmod 700 "$3"
  cp -Rp "$work/out/gpu-host" "$work/out/platform" "$3/"
  rm -rf "$work"
  trap - EXIT
}

# kind <folder>: server or client, from the files in the folder.
kind() {
  if [ -e "$1/server.pem" ]; then
    printf server
  elif [ -e "$1/client.pem" ]; then
    printf client
  else
    echo "gpu-link-tls: $1 holds neither server.pem nor client.pem" >&2
    return 1
  fi
}

# verify <folder> <host or empty>: chain, key, purpose and name; prints the first problem.
verify() {
  k="$(kind "$1")" || return 1
  if [ -e "$1/ca-key.pem" ]; then
    echo "gpu-link-tls: $1 holds a CA key: never put a CA key next to the link's files" >&2
    return 1
  fi
  for vf in ca.pem "$k.pem" "$k-key.pem"; do
    [ -s "$1/$vf" ] || {
      echo "gpu-link-tls: $vf is missing in $1" >&2
      return 1
    }
  done
  purpose=sslserver
  [ "$k" = client ] && purpose=sslclient
  openssl verify -CAfile "$1/ca.pem" -purpose "$purpose" "$1/$k.pem" >/dev/null 2>&1 || {
    echo "gpu-link-tls: $k.pem is not signed by ca.pem for $([ "$k" = client ] && echo 'client' || echo 'server') use" >&2
    return 1
  }
  cert_key="$(openssl x509 -in "$1/$k.pem" -noout -pubkey 2>/dev/null | openssl sha256)"
  key_key="$(openssl pkey -in "$1/$k-key.pem" -pubout 2>/dev/null | openssl sha256)"
  [ "$cert_key" = "$key_key" ] || {
    echo "gpu-link-tls: $k-key.pem does not belong to $k.pem" >&2
    return 1
  }
  if [ "$k" = server ]; then
    if [ -n "$2" ]; then
      openssl x509 -in "$1/server.pem" -noout -checkhost "$2" 2>/dev/null | grep -q 'does match' || {
        echo "gpu-link-tls: server.pem does not name $2" >&2
        return 1
      }
    fi
  else
    subject="$(openssl x509 -in "$1/client.pem" -noout -subject -nameopt RFC2253 2>/dev/null)"
    printf '%s\n' "${subject#subject=}" | grep -Eq "(^|,)CN=$(client_cn)(,|\$)" || {
      echo "gpu-link-tls: client.pem does not hold CN=$(client_cn) (SDLC_GPU_LINK_CLIENT_CN)" >&2
      return 1
    }
  fi
}

# show <label> <file>: the end date; returns 1 when missing, invalid or ending within WARN_DAYS.
show() {
  if [ ! -s "$2" ]; then
    echo "gpu-link-tls: $1: missing ($2)" >&2
    return 1
  fi
  end="$(openssl x509 -in "$2" -noout -enddate 2>/dev/null)" || {
    echo "gpu-link-tls: $1: not a certificate ($2)" >&2
    return 1
  }
  if openssl x509 -in "$2" -noout -checkend $((WARN_DAYS * 86400)) >/dev/null 2>&1; then
    say "$1: ${end#notAfter=}"
  else
    echo "gpu-link-tls: $1: ${end#notAfter=}: ends within $WARN_DAYS days or has ended; renew it (runbook T11 section 5d.2)" >&2
    return 1
  fi
}

cmd_dev() {
  need_openssl
  [ "$#" -eq 2 ] || fail "usage: gpu-link/tls.sh dev <gpu-host-name> <folder>"
  h="$(host_name "$1")"
  out="$(abs "$2")"
  empty_or_new "$out"
  ca="$(mktemp -d)"
  openssl ecparam -name prime256v1 -genkey -noout -out "$ca/ca-key.pem" 2>/dev/null
  openssl req -x509 -new -key "$ca/ca-key.pem" -sha256 -days "$DEV_DAYS" \
    -subj '/CN=Throw-away GPU link CA (test only)' \
    -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' \
    -addext 'keyUsage=critical,keyCertSign,cRLSign' -out "$ca/ca.pem" 2>/dev/null
  status=0
  (make_all "$ca" "$h" "$out" "$DEV_DAYS") || status=$?
  rm -rf "$ca"
  [ "$status" -eq 0 ] || exit "$status"
  say "made a throw-away CA and both certificates in $out/gpu-host and $out/platform (the CA key is deleted)"
}

cmd_issue() {
  need_openssl
  [ "$#" -eq 3 ] || fail "usage: gpu-link/tls.sh issue <ca-folder> <gpu-host-name> <folder>"
  ca_dir="$(cd "$1" && pwd)"
  [ -s "$ca_dir/ca-key.pem" ] && [ -s "$ca_dir/ca.pem" ] || fail "$ca_dir holds no CA (openbao/tls.sh ca)"
  h="$(host_name "$2")"
  out="$(abs "$3")"
  inside_repo "$out" && fail "the certificate folder must be outside the repository: $out"
  case "$out/" in "$ca_dir"/*) fail "the certificate folder must not be inside the CA folder" ;; esac
  empty_or_new "$out"
  make_all "$ca_dir" "$h" "$out" "$ISSUE_DAYS"
  say "issued both certificates (1 year) in $out/gpu-host (to the GPU host) and $out/platform"
}

cmd_check() {
  need_openssl
  [ "$#" -ge 1 ] && [ "$#" -le 2 ] || fail "usage: gpu-link/tls.sh check <folder> [gpu-host-name]"
  [ -d "$1" ] || fail "$1 is not a folder"
  h=""
  [ "$#" -eq 2 ] && h="$(host_name "$2")"
  k="$(kind "$1")" || exit 1
  status=0
  show 'CA' "$1/ca.pem" || status=1
  show "$k certificate" "$1/$k.pem" || status=1
  verify "$1" "$h" || status=1
  [ "$status" -eq 0 ] && say "$1: the $k side is valid"
  return "$status"
}

cmd_reload() {
  command -v docker >/dev/null 2>&1 || fail "docker is required"
  [ "$#" -eq 1 ] || fail "usage: gpu-link/tls.sh reload platform|gpu-host"
  case "$1" in
    platform)
      f="${SDLC_ENV_FILE:-$deploy_dir/.env}"
      [ -f "$f" ] || fail "$f not found"
      compose() { docker compose -f "$deploy_dir/docker-compose.yml" --env-file "$f" --profile models-remote "$@"; }
      compose run --rm --no-deps vllm-link-tls-init >/dev/null
      compose kill -s SIGHUP vllm-link >/dev/null
      ;;
    gpu-host)
      f="${SDLC_GPU_HOST_ENV_FILE:-$deploy_dir/gpu-host/.env}"
      [ -f "$f" ] || fail "$f not found"
      compose() { docker compose -f "$deploy_dir/gpu-host/docker-compose.yml" --env-file "$f" "$@"; }
      compose run --rm --no-deps vllm-gateway-tls-init >/dev/null
      compose kill -s SIGHUP vllm-gateway >/dev/null
      ;;
    *) fail "reload takes platform or gpu-host" ;;
  esac
  say "nginx on the $1 side reads the new certificate"
}

"cmd_$command" "$@"
