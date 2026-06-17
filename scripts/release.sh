#!/usr/bin/env bash
# Cuts a release: bumps the version, commits, tags "v<version>", and with --push
# pushes branch + tag — which triggers .github/workflows/release.yml to package the
# extension (npm run package → dist/danvers-karakeep.xpi) and publish the GitHub
# Release. CI packages the *committed* sources — the .xpi's version is whatever the
# committed manifest.json says — and only *names* the Release from the tag; it does
# NOT derive the extension version from the tag. So the committed version and the tag
# must agree, or you'd ship a release named "v1.5.0" containing a 0.2.10 extension.
# This bumps the version everywhere it's declared (manifest.json + package.json,
# which track each other; there is no lockfile) so they always match.
#
#   scripts/release.sh 1.3.0          # bump version everywhere + README, commit, tag v1.3.0
#   scripts/release.sh 1.3.0 --push   # …also push the commit + tag (CI then publishes)
#   scripts/release.sh                # tag the current version as-is
#
# Usage: scripts/release.sh [X.Y.Z] [--push]
# Shared engine: https://github.com/L-K-M/release-tool (this stub only sets config).
set -euo pipefail

export RELEASE_APP_NAME="Danvers"
export RELEASE_KIND="webext"
export RELEASE_CI_NOTE="CI (release.yml) will now package dist/danvers-karakeep.xpi and publish the GitHub Release for <tag>."
export RELEASE_INVOKED_AS="scripts/release.sh"

BIN="${LKM_RELEASE_BIN:-lkm-release}"
command -v "$BIN" >/dev/null 2>&1 || {
  echo "error: lkm-release not found — clone https://github.com/L-K-M/release-tool and run ./install.sh" >&2
  exit 1
}
exec "$BIN" "$@"
