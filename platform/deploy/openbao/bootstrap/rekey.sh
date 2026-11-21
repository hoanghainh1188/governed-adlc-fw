#!/bin/sh
# Makes a new set of key shares from the current ones (task A10 PR 3a, runbook T11 section 8.3).
# Runs INSIDE the openbao container. Called by platform/deploy/openbao/bootstrap.sh rekey.
#
# Usage:
#   rekey.sh start <shares> <threshold> <pgp-key-count>
#     stdin: first <pgp-key-count> lines, one PGP public key each (base64 of the binary key, not
#            secret); then one CURRENT key share per line (as many as the current threshold).
#     stdout: the verification nonce (not secret), then the new key shares, one per line, once.
#            With PGP keys each share is encrypted for its holder, in the order of the keys.
#   rekey.sh verify <verification nonce>
#     stdin: one NEW key share per line, in clear (as many as the new threshold).
#   rekey.sh state
#     stdout: "open" while a rekey is started or waits for its verification, else "none".
#   rekey.sh drop
#     Drops a rekey that is started or waits for its verification, then reads the state again.
#     stdout: "dropped" (one was open, none is now) or "none" (none was open). It fails when a
#     rekey is still open or the state cannot be read.
#
# The rekey asks for a verification (require_verification): the new shares replace the old ones
# only after "verify" got enough of them back. Until then, and after "cancel", the old shares
# stay valid, so a share that was copied wrongly or cannot be decrypted locks nobody out.
#
# Uses the key-share endpoints sys/rekey/* (no token needed), which only the key-holder listener
# 127.0.0.1:8210 accepts (openbao.hcl). "bao operator rekey" is not used: it asks for each share
# at its own prompt and needs a terminal. Shares reach bao on stdin ("key=-"), never as
# command-line arguments. Nothing is written to disk. The root key and the stored data do not
# change.
set -eu

export BAO_ADDR=http://127.0.0.1:8210
unset BAO_TOKEN

fail() {
  echo "rekey: $*" >&2
  exit 1
}
cancel() { bao delete sys/rekey/init >/dev/null 2>&1 || true; }
# Prints "open" while a rekey is started or waits for its verification, else "none".
state() {
  status="$(bao read -format=json sys/rekey/init 2>/dev/null)" || fail "cannot read the rekey status"
  case "$status" in
    *'"started": true'* | *'"verification_nonce": "'[!\"]*) echo open ;;
    *'"started": false'*) echo none ;;
    *) fail "unexpected rekey status" ;;
  esac
}
drop() {
  before="$(state)"
  [ "$before" = open ] || {
    echo none
    return 0
  }
  cancel
  [ "$(state)" = none ] || fail "the rekey is still open"
  echo dropped
}

start() {
  [ "$#" -eq 3 ] || fail "usage: rekey.sh start SHARES THRESHOLD PGP-KEY-COUNT"
  shares="$1"
  threshold="$2"
  pgp_count="$3"

  [ "$(state)" = none ] ||
    fail "a rekey is already in progress; drop it first: bootstrap.sh rekey --cancel"

  # The request is JSON: OpenBao wants numbers for the share counts ("bao write key=value" sends
  # strings). The values are digits and base64 text only.
  case "$shares$threshold" in *[!0-9]*) fail "the share counts must be numbers" ;; esac
  pgp_keys=""
  i=0
  while [ "$i" -lt "$pgp_count" ]; do
    IFS= read -r key || fail "a PGP public key is missing"
    case "$key" in "" | *[!A-Za-z0-9+/=]*) fail "a PGP public key is not base64" ;; esac
    pgp_keys="${pgp_keys:+$pgp_keys,}\"$key\""
    i=$((i + 1))
  done

  request="{\"secret_shares\":$shares,\"secret_threshold\":$threshold,\"require_verification\":true"
  [ -z "$pgp_keys" ] || request="$request,\"pgp_keys\":[$pgp_keys]"
  # Cancel the attempt if anything below fails, so no half-finished attempt stays open.
  trap cancel EXIT
  nonce="$(printf '%s}' "$request" | bao write -field=nonce sys/rekey/init - 2>/dev/null)" ||
    fail "could not start the rekey (is every PGP file a public key?)"
  [ -n "$nonce" ] || fail "could not start the rekey"

  out=""
  complete=no
  while IFS= read -r share; do
    [ -n "$share" ] || continue
    out="$(printf '%s' "$share" | bao write -format=json sys/rekey/update key=- nonce="$nonce" 2>/dev/null)" ||
      fail "a key share was rejected"
    case "$out" in
      *'"complete": true'*)
        complete=yes
        break
        ;;
    esac
  done
  [ "$complete" = yes ] || fail "not enough key shares"

  verification="$(printf '%s\n' "$out" | sed -n 's/^ *"verification_nonce": "\([^"]*\)".*/\1/p')"
  [ -n "$verification" ] || fail "OpenBao did not ask for a verification"
  new="$(printf '%s\n' "$out" | awk '
    /"keys_base64": *\[/ { inside = 1; next }
    inside && /\]/ { exit }
    inside { gsub(/[", \t]/, ""); if ($0 != "") print }')"
  [ "$(printf '%s\n' "$new" | grep -c .)" -eq "$shares" ] || fail "could not read the new key shares"

  # From here the host decides: "verify" or "cancel".
  trap - EXIT
  printf '%s\n%s\n' "$verification" "$new"
}

verify() {
  [ "$#" -eq 1 ] || fail "usage: rekey.sh verify VERIFICATION-NONCE"
  while IFS= read -r share; do
    [ -n "$share" ] || continue
    out="$(printf '%s' "$share" | bao write -format=json sys/rekey/verify key=- nonce="$1" 2>/dev/null)" ||
      fail "a new key share was not accepted"
    case "$out" in
      *'"complete": true'*)
        echo verified
        return 0
        ;;
    esac
  done
  fail "not enough new key shares"
}

[ "$#" -ge 1 ] || fail "usage: rekey.sh start|verify|drop|state"
mode="$1"
shift
case "$mode" in
  start) start "$@" ;;
  verify) verify "$@" ;;
  drop) drop ;;
  state) state ;;
  *) fail "usage: rekey.sh start|verify|drop|state" ;;
esac
