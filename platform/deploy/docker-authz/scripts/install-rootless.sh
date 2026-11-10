#!/bin/sh
# Install the Docker AuthZ plugin on a rootless Engine (H07, ADR-M105, T11).
# Wrapper around enable.sh with a systemd user service.
set -eu
export SDLC_DOCKER_AUTHZ_SYSTEMD=1
exec "$(cd "$(dirname "$0")" && pwd)/enable.sh" "$@"
