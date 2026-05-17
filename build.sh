#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
parent_dir="$(cd "$project_dir/.." && pwd)"
artifacts_dir="$project_dir/web-ext-artifacts"
credentials_file="${WEB_EXT_CREDENTIALS_FILE:-$parent_dir/web-ext-credentials.env}"
stage_dir="$(mktemp -d "${TMPDIR:-/tmp}/danvers-build.XXXXXX")"
package_entries=(
  manifest.json
  README.md
  LICENSE
  icons
  src
)
web_ext="$project_dir/node_modules/.bin/web-ext"

cleanup() {
  rm -rf "$stage_dir"
}
trap cleanup EXIT

if [[ -f "$credentials_file" ]]; then
  set -a
  # shellcheck source=/dev/null
  . "$credentials_file"
  set +a
fi

sign_extension=false

if [[ ! -x "$web_ext" ]]; then
  if ! command -v web-ext >/dev/null 2>&1; then
    printf 'Error: web-ext is required. Install it with: npm install --global web-ext\n' >&2
    exit 1
  fi

  web_ext="web-ext"
fi

if [[ -n "${WEB_EXT_API_KEY:-}" || -n "${WEB_EXT_API_SECRET:-}" ]]; then
  if [[ -z "${WEB_EXT_API_KEY:-}" || -z "${WEB_EXT_API_SECRET:-}" ]]; then
    printf 'Error: signing requires both WEB_EXT_API_KEY and WEB_EXT_API_SECRET in %s.\n' "$credentials_file" >&2
    exit 1
  fi
  sign_extension=true
fi

mkdir -p "$artifacts_dir"

for entry in "${package_entries[@]}"; do
  cp -R "$project_dir/$entry" "$stage_dir/"
done

find "$stage_dir" \( -name .DS_Store -o -name Thumbs.db \) -delete

"$web_ext" build \
  --source-dir "$stage_dir" \
  --artifacts-dir "$artifacts_dir" \
  --overwrite-dest

if [[ "$sign_extension" != true ]]; then
  printf 'Unsigned build complete. Set WEB_EXT_API_KEY and WEB_EXT_API_SECRET in %s to sign.\n' "$credentials_file"
  exit 0
fi

"$web_ext" sign \
  --source-dir "$stage_dir" \
  --artifacts-dir "$artifacts_dir" \
  --api-key "$WEB_EXT_API_KEY" \
  --api-secret "$WEB_EXT_API_SECRET" \
  --channel "unlisted"
