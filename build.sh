#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
artifacts_dir="$project_dir/web-ext-artifacts"
stage_dir="$(mktemp -d "${TMPDIR:-/tmp}/danvers-build.XXXXXX")"
package_entries=(
  manifest.json
  README.md
  LICENSE
  icons
  src
)
sign_extension=false

cleanup() {
  rm -rf "$stage_dir"
}
trap cleanup EXIT

if ! command -v web-ext >/dev/null 2>&1; then
  printf 'Error: web-ext is required. Install it with: npm install --global web-ext\n' >&2
  exit 1
fi

if [[ -n "${WEB_EXT_API_KEY:-}" || -n "${WEB_EXT_API_SECRET:-}" ]]; then
  if [[ -z "${WEB_EXT_API_KEY:-}" || -z "${WEB_EXT_API_SECRET:-}" ]]; then
    printf 'Error: signing requires both WEB_EXT_API_KEY and WEB_EXT_API_SECRET.\n' >&2
    exit 1
  fi
  sign_extension=true
fi

mkdir -p "$artifacts_dir"

for entry in "${package_entries[@]}"; do
  cp -R "$project_dir/$entry" "$stage_dir/"
done

web-ext build \
  --source-dir "$stage_dir" \
  --artifacts-dir "$artifacts_dir" \
  --overwrite-dest

if [[ "$sign_extension" != true ]]; then
  printf 'Unsigned build complete. Set WEB_EXT_API_KEY and WEB_EXT_API_SECRET to sign.\n'
  exit 0
fi

web-ext sign \
  --source-dir "$stage_dir" \
  --artifacts-dir "$artifacts_dir" \
  --api-key "$WEB_EXT_API_KEY" \
  --api-secret "$WEB_EXT_API_SECRET" \
  --channel "unlisted"
