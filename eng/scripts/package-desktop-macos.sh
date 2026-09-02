#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
desktop_root="$repo_root/src/clients/desktop"
release_root="$repo_root/artifacts/releases"
install_root=""
archive_root=""
app_pid=""
smoke_bearer="desktop-smoke-not-a-real-secret-0001"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "package-desktop-macos.sh requires macOS; no unsigned macOS artifact was produced." >&2
  exit 2
fi

stop_app() {
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
  app_pid=""
}

cleanup() {
  result_code=$?
  set +e
  stop_app
  if [[ -n "$install_root" ]]; then
    rm -rf "$install_root"
  fi
  if [[ -n "$archive_root" ]]; then
    rm -rf "$archive_root"
  fi
  exit "$result_code"
}
trap cleanup EXIT INT TERM

assert_secure_smoke_credential() {
  local credential_directory="$1"
  local credential_path="$credential_directory/local-api-bearer.bin"
  if [[ ! -d "$credential_directory" || "$(stat -f '%Lp' "$credential_directory")" != "700" ]]; then
    echo "Desktop did not create an owner-only credential directory." >&2
    exit 1
  fi
  if [[ ! -f "$credential_path" || "$(stat -f '%Lp' "$credential_path")" != "600" ]]; then
    echo "Desktop did not persist an owner-only encrypted backend bearer." >&2
    exit 1
  fi
  if LC_ALL=C grep -aFq "$smoke_bearer" "$credential_path"; then
    echo "Desktop persisted the backend bearer as plaintext." >&2
    exit 1
  fi
}

assert_smoke_does_not_echo_bearer() {
  local path="$1"
  if [[ -f "$path" ]] && LC_ALL=C grep -aFq "$smoke_bearer" "$path"; then
    echo "Desktop smoke output unexpectedly contained the backend bearer." >&2
    exit 1
  fi
}

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
if [[ "$(stat -f '%Lp' "$user_data_root")" != "700" ]]; then
  echo "Desktop smoke userData is not owner-only." >&2
  exit 1
fi
cp -R "$app_source" "$installed_app"

JARVIS_DESKTOP_SMOKE_MARKER="$marker_path" \
JARVIS_DESKTOP_SMOKE_ROOT="$install_root" \
JARVIS_LOCAL_BEARER="$smoke_bearer" \
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
marker_bearer="$(jq -r '.backendBearerConfigured // false' "$marker_path")"
marker_wake_bridge="$(jq -r '.wakeBridgeAvailable // false' "$marker_path")"
marker_wake_state="$(jq -r '.wakeState // empty' "$marker_path")"
if [[ "$marker_event" != "renderer.ready" \
  || "$marker_pid" != "$app_pid" \
  || "$marker_bearer" != "true" \
  || "$marker_wake_bridge" != "true" \
  || "$marker_wake_state" != "standby" ]]; then
  echo "Electron smoke marker did not prove the installed process mounted the renderer." >&2
  exit 1
fi
if [[ "$(stat -f '%Lp' "$marker_path")" != "600" ]]; then
  echo "Desktop smoke marker is not owner-only." >&2
  exit 1
fi
assert_smoke_does_not_echo_bearer "$marker_path"
assert_smoke_does_not_echo_bearer "$install_root/electron.stdout.log"
assert_smoke_does_not_echo_bearer "$install_root/electron.stderr.log"

credential_path="$user_data_root/credentials/local-api-bearer.bin"
credential_directory="$user_data_root/credentials"
assert_secure_smoke_credential "$credential_directory"

stop_app
persisted_marker_path="$install_root/renderer-ready-from-keychain.json"
JARVIS_DESKTOP_SMOKE_MARKER="$persisted_marker_path" \
JARVIS_DESKTOP_SMOKE_ROOT="$install_root" \
  "$installed_app/Contents/MacOS/Jarvis" --disable-gpu \
  --user-data-dir="$user_data_root" \
  >"$install_root/electron-keychain.stdout.log" 2>"$install_root/electron-keychain.stderr.log" &
app_pid=$!

persisted_marker_ready=0
for _ in {1..80}; do
  if [[ -s "$persisted_marker_path" ]] && kill -0 "$app_pid" 2>/dev/null; then
    persisted_marker_ready=1
    break
  fi
  if ! kill -0 "$app_pid" 2>/dev/null; then
    break
  fi
  sleep 0.25
done
if [[ "$persisted_marker_ready" -ne 1 ]]; then
  echo "Installed Jarvis.app did not restart with the persisted backend bearer." >&2
  tail -80 "$install_root/electron-keychain.stderr.log" >&2 || true
  exit 1
fi

persisted_marker_event="$(jq -r '.event // empty' "$persisted_marker_path")"
persisted_marker_pid="$(jq -r '.pid // empty' "$persisted_marker_path")"
persisted_marker_bearer="$(jq -r '.backendBearerConfigured // false' "$persisted_marker_path")"
persisted_marker_wake_bridge="$(jq -r '.wakeBridgeAvailable // false' "$persisted_marker_path")"
persisted_marker_wake_state="$(jq -r '.wakeState // empty' "$persisted_marker_path")"
if [[ "$persisted_marker_event" != "renderer.ready" \
  || "$persisted_marker_pid" != "$app_pid" \
  || "$persisted_marker_bearer" != "true" \
  || "$persisted_marker_wake_bridge" != "true" \
  || "$persisted_marker_wake_state" != "standby" ]]; then
  echo "Desktop restart did not load the persisted backend bearer." >&2
  exit 1
fi
if [[ "$(stat -f '%Lp' "$persisted_marker_path")" != "600" ]]; then
  echo "Desktop restart smoke marker is not owner-only." >&2
  exit 1
fi
assert_smoke_does_not_echo_bearer "$persisted_marker_path"
assert_smoke_does_not_echo_bearer "$install_root/electron-keychain.stdout.log"
assert_smoke_does_not_echo_bearer "$install_root/electron-keychain.stderr.log"
assert_secure_smoke_credential "$credential_directory"
echo "Desktop install/start smoke passed: Jarvis.app persisted and reloaded its Keychain-backed backend bearer."

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
