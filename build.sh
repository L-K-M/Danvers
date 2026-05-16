#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
stage_dir="$(mktemp -d)"

cleanup() {
  rm -rf "$stage_dir"
}
trap cleanup EXIT

mkdir -p \
  "$stage_dir/icons" \
  "$stage_dir/src/content" \
  "$stage_dir/src/options"

cp "$project_dir/manifest.json" "$stage_dir/"
cp "$project_dir/README.md" "$stage_dir/"
cp "$project_dir/LICENSE" "$stage_dir/"
cp "$project_dir/icons/icon-48.svg" "$stage_dir/icons/"
cp "$project_dir/icons/icon-96.svg" "$stage_dir/icons/"
cp "$project_dir/src/background.js" "$stage_dir/src/"
cp "$project_dir/src/content/overlay.css" "$stage_dir/src/content/"
cp "$project_dir/src/content/overlay.js" "$stage_dir/src/content/"
cp "$project_dir/src/options/options.css" "$stage_dir/src/options/"
cp "$project_dir/src/options/options.html" "$stage_dir/src/options/"
cp "$project_dir/src/options/options.js" "$stage_dir/src/options/"

web-ext build \
  --source-dir "$stage_dir" \
  --artifacts-dir "$project_dir/web-ext-artifacts" \
  --overwrite-dest

# https://addons.mozilla.org/en-US/developers/addon/api/key/

web-ext sign \
  --source-dir "$stage_dir" \
  --artifacts-dir "$project_dir/web-ext-artifacts" \
  --api-key "" \
  --api-secret "" \
  --channel "unlisted"
