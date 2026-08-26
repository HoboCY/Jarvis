#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
artifact_root="$repo_root/artifacts/services"
configuration="${JARVIS_BUILD_CONFIGURATION:-Release}"
publish_parent="${TMPDIR:-/tmp}/jarvis-phase6-publish"
if [[ -e "$publish_parent" ]]; then
  echo "A previous deterministic publish is still using $publish_parent; refusing to overlap publishes." >&2
  exit 1
fi
mkdir "$publish_parent"
publish_root="$publish_parent/source"

cleanup() {
  rm -rf "$publish_parent"
}
trap cleanup EXIT

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "publish-macos-arm64.sh requires macOS; use CI macOS or an explicit cross-publish environment." >&2
  exit 2
fi

lock_snapshot() {
  while IFS= read -r lock_file; do
    shasum -a 256 "$repo_root/$lock_file"
  done < <(git -C "$repo_root" ls-files '*packages.lock.json' | sort)
}

lock_snapshot_before="$(lock_snapshot)"

# Restore in an isolated source tree. A runtime-specific restore updates only
# the copied lock files, so publishing never rewrites tracked repository
# locks. The second restore is the release gate that proves the generated lock
# files are complete and reproducible.
mkdir -p "$publish_root/src" "$publish_root/eng"
rsync -a --exclude bin --exclude obj --exclude packages.lock.json "$repo_root/src/backend" "$publish_root/src/"
for root_file in Directory.Build.props Directory.Packages.props NuGet.config global.json; do
  cp "$repo_root/$root_file" "$publish_root/$root_file"
done
cp "$repo_root/eng/versions.json" "$publish_root/eng/versions.json"

pushd "$publish_root" >/dev/null
api_project="src/backend/Jarvis.Api/Jarvis.Api.csproj"
device_project="src/backend/Jarvis.DeviceNode/Jarvis.DeviceNode.csproj"
dotnet restore "$api_project" --runtime osx-arm64 --force-evaluate
dotnet restore "$api_project" --runtime osx-arm64 --locked-mode
dotnet restore "$device_project" --runtime osx-arm64 --force-evaluate
dotnet restore "$device_project" --runtime osx-arm64 --locked-mode

api_output="$artifact_root/api"
device_output="$artifact_root/device-node"
rm -rf "$api_output" "$device_output"
mkdir -p "$api_output" "$device_output"
dotnet publish "$api_project" \
  --configuration "$configuration" --runtime osx-arm64 --self-contained true --no-restore \
  -p:PublishSingleFile=false -p:DebugType=None -o "$api_output"
dotnet publish "$device_project" \
  --configuration "$configuration" --runtime osx-arm64 --self-contained true --no-restore \
  -p:PublishSingleFile=false -p:DebugType=None -o "$device_output"
popd >/dev/null

lock_snapshot_after="$(lock_snapshot)"
if [[ "$lock_snapshot_before" != "$lock_snapshot_after" ]]; then
  echo "Publish changed a tracked packages.lock.json; isolated restore is broken." >&2
  diff -u <(printf '%s\n' "$lock_snapshot_before") <(printf '%s\n' "$lock_snapshot_after") >&2 || true
  exit 1
fi

api_bundle="$artifact_root/Jarvis.Api-darwin-arm64.tar.gz"
device_bundle="$artifact_root/Jarvis.DeviceNode-darwin-arm64.tar.gz"
node "$repo_root/eng/scripts/deterministic-archive.mjs" tar.gz "$artifact_root/api" "$api_bundle"
node "$repo_root/eng/scripts/deterministic-archive.mjs" tar.gz "$artifact_root/device-node" "$device_bundle"

node "$repo_root/eng/scripts/create-service-manifest.mjs"

echo "Published API and Device Node darwin-arm64 artifacts under $artifact_root."
