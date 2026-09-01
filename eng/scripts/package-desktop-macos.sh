#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
desktop_root="$repo_root/src/clients/desktop"
release_root="$repo_root/artifacts/releases"
install_root=""
archive_root=""
app_pid=""

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "package-desktop-macos.sh requires macOS; no unsigned macOS artifact was produced." >&2
  exit 2
fi

cleanup() {
  result_code=$?
  set +e
  if [[ -n "$app_pid" ]] && kill -0 "$app_pid" 2>/dev/null; then
    kill -TERM "$app_pid" 2>/dev/null || true
    for _ in {1..20}; do
      if ! kill -0 "$app_pid" 2>/dev/null; then
        break
      fi
      sleep 0.25
    done
    if kill -0 "$app_pid" 2>/dev/null; then
      kill -KILL "$app_pid" 2>/dev/null || true
    fi
    wait "$app_pid" 2>/dev/null || true
  fi
  if [[ -n "$install_root" ]]; then
    rm -rf "$install_root"
  fi
  if [[ -n "$archive_root" ]]; then
    rm -rf "$archive_root"
  fi
  exit "$result_code"
}
trap cleanup EXIT INT TERM
pnpm --filter @jarvis/desktop make:mac
app_source="$(find "$desktop_root/out" -maxdepth 3 -type d -name '*.app' -print | sort | head -n 1)"
if [[ -z "$app_source" || ! -x "$app_source/Contents/MacOS/Jarvis" ]]; then
  echo "Electron Forge did not produce an executable macOS arm64 .app." >&2
  exit 1
fi
node "$desktop_root/scripts/assert-package.mjs" "$app_source/Contents/Resources/app.asar"

forge_artifact="$(find "$desktop_root/out/make" -type f \( -name '*.zip' -o -name '*.dmg' \) -print | sort | tail -n 1)"
if [[ -z "$forge_artifact" ]]; then
  echo "Electron Forge did not produce a macOS arm64 package." >&2
  exit 1
fi
archive_root="$(mktemp -d "${TMPDIR:-/tmp}/jarvis-phase6-desktop-archive.XXXXXX")"
cp -R "$app_source" "$archive_root/Jarvis.app"
deterministic_artifact="${forge_artifact}.deterministic.$$"
node "$repo_root/eng/scripts/deterministic-archive.mjs" zip "$archive_root" "$deterministic_artifact"
mv "$deterministic_artifact" "$forge_artifact"
rm -rf "$archive_root"
archive_root=""

install_root="$(mktemp -d "${TMPDIR:-/tmp}/jarvis-phase6-desktop-install.XXXXXX")"
installed_app="$install_root/Jarvis.app"
user_data_root="$install_root/user-data"
marker_path="$install_root/renderer-ready.json"
mkdir -m 700 "$user_data_root"
cp -R "$app_source" "$installed_app"

JARVIS_DESKTOP_SMOKE_MARKER="$marker_path" \
JARVIS_DESKTOP_SMOKE_ROOT="$install_root" \
JARVIS_LOCAL_BEARER="desktop-smoke-not-a-real-secret-0001" \
  "$installed_app/Contents/MacOS/Jarvis" --disable-gpu \
  --user-data-dir="$user_data_root" \
  >"$install_root/electron.stdout.log" 2>"$install_root/electron.stderr.log" &
app_pid=$!

marker_ready=0
for _ in {1..80}; do
  if [[ -s "$marker_path" ]] && kill -0 "$app_pid" 2>/dev/null; then
    marker_ready=1
    break
  fi
  if ! kill -0 "$app_pid" 2>/dev/null; then
    break
  fi
  sleep 0.25
done
if [[ "$marker_ready" -ne 1 ]]; then
  echo "Installed Jarvis.app did not mount the renderer while its process was alive." >&2
  tail -80 "$install_root/electron.stderr.log" >&2 || true
  exit 1
fi

# Keep the installed process alive long enough to verify the renderer marker.
sleep 1
if ! kill -0 "$app_pid" 2>/dev/null; then
  echo "Installed Jarvis.app exited after renderer.ready." >&2
  tail -80 "$install_root/electron.stderr.log" >&2 || true
  exit 1
fi

marker_event="$(jq -r '.event // empty' "$marker_path")"
marker_pid="$(jq -r '.pid // empty' "$marker_path")"
if [[ "$marker_event" != "renderer.ready" || "$marker_pid" != "$app_pid" ]]; then
  echo "Electron smoke marker did not prove the installed process mounted the renderer." >&2
  exit 1
fi
echo "Desktop install/start smoke passed: Jarvis.app pid $app_pid mounted the renderer."

artifact="$forge_artifact"
if [[ -z "$artifact" ]]; then
  echo "Electron Forge did not produce a macOS arm64 package." >&2
  exit 1
fi

mkdir -p "$release_root"
node "$repo_root/eng/scripts/create-release-manifest.mjs" \
  --output "$release_root/version-manifest.json" \
  --version "$(node -p "require('$desktop_root/package.json').version")" \
  --artifact "$artifact" \
  --kind "electron-mac-arm64-unsigned-test"
echo "Created unsigned test release manifest at $release_root/version-manifest.json."
