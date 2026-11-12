#!/bin/sh
# Published or locally built platform images (task V04, design/ADR-M66; ADR-M94 §2.4, task V15).
#
# Usage: platform/deploy/scripts/images.sh mode        # prints `published` or `local`
#        platform/deploy/scripts/images.sh get <NAME>  # prints SDLC_IMAGE_<NAME> of the lock file
#        platform/deploy/scripts/images.sh export      # prints the lock file's NAME=value lines
#        platform/deploy/scripts/images.sh verify      # cosign and gh check of the seven images
#
# `published` only on a release checkout: a Git checkout whose HEAD is exactly the tag
# v<version of the root package.json>, with no change to a tracked file. Everything else (main, a
# branch, a changed file, a source archive) builds the images locally.
#
# The lock file of a release is an asset of its GitHub Release (an immutable release: the asset
# never changes). The tagged commit holds no lock file. The script reads, in this order:
#   1. the file named by SDLC_IMAGES_LOCK (a server without access to github.com);
#   2. platform/deploy/.images/vX.Y.Z.lock (ignored by Git), downloaded once over HTTPS from
#      https://github.com/hoanghainh1188/governed-adlc-fw/releases/download/vX.Y.Z/images.lock
#      (a public repository: no token).
# Every lock file must be complete: SDLC_IMAGES_VERSION equal to the root package.json and the seven
# images pinned by digest on the one registry path. On a release checkout a lock file that is
# missing or not complete stops the script with an error: it never builds silently instead.
# Tags v0.6.0 and before hold their lock file in the commit and keep their own copy of this script.
#
# Environment:
#   SDLC_IMAGES       `published` or `local` overrides the choice; `published` is the way to use
#                     the images of a release's source archive
#   SDLC_IMAGES_LOCK  the lock file to use instead of the download
set -eu

NAMES="API WORKER RUNNER OTEL_COLLECTOR SANDBOX_NODE24 TOOL_PROJECT_DOCS TOOL_CODE_INDEX"
PREFIX="ghcr.io/hoanghainh1188/governed-adlc-fw"
RELEASES="https://github.com/hoanghainh1188/governed-adlc-fw/releases/download"

root="$(cd "$(dirname "$0")/../../.." && pwd)"

die() { echo "images: $*" >&2; exit 1; }
value() { sed -n "s/^$1=//p" "$2" | tail -n 1; }

# The version of the root package.json (the first "version" key).
version="$(awk -F'"' '/"version"[[:space:]]*:/ { print $4; exit }' "$root/package.json" 2>/dev/null || true)"
printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' ||
  die "no version X.Y.Z in $root/package.json"
cached="$root/platform/deploy/.images/v$version.lock"
hint="set SDLC_IMAGES_LOCK=<the images.lock of the GitHub Release v$version>, or SDLC_IMAGES=local to build the images here"

# The image name on GHCR of a lock entry.
image_of() {
  case "$1" in
    SANDBOX_NODE24) echo sandbox-node24 ;;
    TOOL_PROJECT_DOCS) echo tool-project-docs ;;
    TOOL_CODE_INDEX) echo tool-code-index ;;
    OTEL_COLLECTOR) echo sdlc-otel-collector ;;
    *) echo "sdlc-$(echo "$1" | tr '[:upper:]' '[:lower:]')" ;;
  esac
}

# 0 when the file is for this version and pins every image by digest under the one registry path.
lock_complete() {
  [ -f "$1" ] || return 1
  [ "$(value SDLC_IMAGES_VERSION "$1")" = "$version" ] || return 1
  for n in $NAMES; do
    printf '%s' "$(value "SDLC_IMAGE_$n" "$1")" |
      grep -Eq "^$PREFIX/$(image_of "$n")@sha256:[0-9a-f]{64}\$" || return 1
  done
}

release_checkout() {
  [ -e "$root/.git" ] && command -v git >/dev/null 2>&1 || return 1
  tag="$(git -C "$root" describe --exact-match --tags HEAD 2>/dev/null || true)"
  [ "$tag" = "v$version" ] || return 1
  [ -z "$(git -C "$root" status --porcelain --untracked-files=no)" ]
}

# Prints the path of a complete lock file of this version; downloads it once when needed.
lock_file() {
  if [ -n "${SDLC_IMAGES_LOCK:-}" ]; then
    lock_complete "$SDLC_IMAGES_LOCK" ||
      die "SDLC_IMAGES_LOCK=$SDLC_IMAGES_LOCK is not a complete lock file for v$version"
    echo "$SDLC_IMAGES_LOCK"
    return
  fi
  if ! lock_complete "$cached"; then
    command -v curl >/dev/null 2>&1 || die "curl is needed to download images.lock; $hint"
    mkdir -p "$(dirname "$cached")"
    part="$cached.part.$$"
    if ! curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$part" \
      "$RELEASES/v$version/images.lock"; then
      rm -f "$part"
      die "could not download images.lock of the GitHub Release v$version; $hint"
    fi
    if ! lock_complete "$part"; then
      rm -f "$part"
      die "the images.lock of the GitHub Release v$version is not complete; $hint"
    fi
    mv "$part" "$cached" # written only when complete
  fi
  echo "$cached"
}

mode() {
  case "${SDLC_IMAGES:-}" in
    local) echo local; return ;;
    published) lock_file >/dev/null; echo published; return ;;
    '') ;;
    *) die "SDLC_IMAGES must be published or local, not '$SDLC_IMAGES'" ;;
  esac
  if release_checkout; then
    lock_file >/dev/null
    echo published
  else
    echo local
  fi
}

case "${1:-}" in
  mode) [ "$#" -eq 1 ] || die "usage: $0 mode"; mode ;;
  get)
    [ "$#" -eq 2 ] || die "usage: $0 get <NAME>"
    case " $NAMES " in *" $2 "*) ;; *) die "unknown image $2 (one of: $NAMES)" ;; esac
    lock="$(lock_file)"
    value "SDLC_IMAGE_$2" "$lock"
    ;;
  export)
    [ "$#" -eq 1 ] || die "usage: $0 export"
    lock="$(lock_file)"
    echo "SDLC_IMAGES_VERSION=$version"
    for n in $NAMES; do echo "SDLC_IMAGE_$n=$(value "SDLC_IMAGE_$n" "$lock")"; done
    ;;
  verify)
    # Optional (ADR-M94 §2.4): the check of release.yml, with the person's cosign and gh.
    [ "$#" -eq 1 ] || die "usage: $0 verify"
    if ! command -v cosign >/dev/null 2>&1 || ! command -v gh >/dev/null 2>&1; then
      die "verify needs cosign and gh (signed in) on PATH"
    fi
    lock="$(lock_file)"
    refs="$(mktemp)"
    trap 'rm -f "$refs"' EXIT
    for n in $NAMES; do value "SDLC_IMAGE_$n" "$lock"; done > "$refs"
    bash "$root/platform/tools/release/verify-images.sh" "$refs" "v$version"
    ;;
  *) echo "usage: $0 mode | get <NAME> | export | verify" >&2; exit 2 ;;
esac
