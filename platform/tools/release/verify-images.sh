#!/usr/bin/env bash
# Verifies the release images before anything is released (tasks V12 and V15, RELEASING.md,
# ADR-M94 §2.6). Used by release.yml, npm-publish.yml and `pnpm images verify`, so they can never
# disagree.
#
#   verify-images.sh <file with one image reference per line> <tag vX.Y.Z>
#
# Every reference (ghcr.io/…@sha256:…, from release-check.mjs lock --images-out) must carry a
# cosign signature and a GitHub build provenance attestation whose certificate names exactly
# release-images.yml at refs/tags/<tag>: release.yml calls it on the tag, and a called workflow
# signs with its own identity at the caller's ref. Releases v0.6.0 and before were signed on
# refs/heads/main; their own checkout keeps that check. Needs cosign 3.x and gh (GH_TOKEN with
# attestations: read in a workflow). Prints no secret.
set -euo pipefail

file="${1:?usage: verify-images.sh <images file> <tag vX.Y.Z>}"
tag="${2:?usage: verify-images.sh <images file> <tag vX.Y.Z>}"
[ "$#" -eq 2 ] || { echo "usage: verify-images.sh <images file> <tag vX.Y.Z>" >&2; exit 2; }
if ! [[ "$tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo "verify-images: the tag must be vX.Y.Z, got '$tag'" >&2
  exit 2
fi

SIGNER_IDENTITY="https://github.com/hoanghainh1188/governed-adlc-fw/.github/workflows/release-images.yml@refs/tags/$tag"
SIGNER_ISSUER='https://token.actions.githubusercontent.com'
REPO='hoanghainh1188/governed-adlc-fw'

count=0
while read -r ref; do
  [ -n "$ref" ] || continue
  echo "::group::$ref"
  cosign verify --certificate-identity "$SIGNER_IDENTITY" \
    --certificate-oidc-issuer "$SIGNER_ISSUER" "$ref" > /dev/null
  gh attestation verify "oci://$ref" --repo "$REPO" \
    --cert-identity "$SIGNER_IDENTITY" --cert-oidc-issuer "$SIGNER_ISSUER" > /dev/null
  echo "::endgroup::"
  count=$((count + 1))
done < "$file"
if [ "$count" != 7 ]; then
  echo "::error::expected seven images, verified $count"
  exit 1
fi
echo "verify-images: seven images signed and attested by release-images.yml at $tag"
