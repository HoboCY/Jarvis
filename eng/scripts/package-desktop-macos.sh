#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
desktop_root="$repo_root/src/clients/desktop"
release_root="$repo_root/artifacts/releases"
install_root=""
archive_root=""
app_pid=""
workspace_backups=()

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
  restore_workspace_packages
  exit "$result_code"
}
trap cleanup EXIT INT TERM

prepare_workspace_packages() {
  local link target source backup copy
  while IFS= read -r link; do
    [[ -n "$link" ]] || continue
    if [[ ! -d "$link" ]]; then
      continue
    fi
    target="$(readlink "$link")"
    source="$repo_root/node_modules/${link#"$desktop_root/node_modules/"}"
    if [[ ! -d "$source" ]]; then
      source="$(cd "$(dirname "$link")" && cd "$(dirname "$target")" && pwd)/$(basename "$target")"
    fi
    if [[ ! -d "$source" ]]; then
      continue
    fi
    backup="${link}.phase6-original.$$"
    copy="${link}.phase6-copy.$$"
    mv "$link" "$backup"
    mkdir "$copy"
    cp -R "$source/." "$copy/"
    rm -rf "$copy/node_modules"
    mv "$copy" "$link"
    workspace_backups+=("$link|$backup")
  done < <(node --input-type=module - "$desktop_root" <<'NODE'
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

const desktopRoot = process.argv[2];
const nodeModules = join(desktopRoot, "node_modules");
const desktopPackage = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8"));
const queue = [...Object.keys(desktopPackage.dependencies ?? {}), "electron"];
const seen = new Set();

while (queue.length > 0) {
  const packageName = queue.shift();
  if (seen.has(packageName)) {
    continue;
  }
  seen.add(packageName);
  const packagePath = join(nodeModules, packageName);
  try {
    if (lstatSync(packagePath).isSymbolicLink()) {
      process.stdout.write(`${packagePath}\n`);
    }
    const packageJson = JSON.parse(readFileSync(join(packagePath, "package.json"), "utf8"));
    queue.push(...Object.keys(packageJson.dependencies ?? {}));
    queue.push(...Object.keys(packageJson.optionalDependencies ?? {}));
  } catch {
    // A dependency may be resolved by a nested package or be platform-only.
  }
}
NODE
  )
}

restore_workspace_packages() {
  local entry link backup
  for entry in "${workspace_backups[@]-}"; do
    [[ -n "$entry" ]] || continue
    link="${entry%%|*}"
    backup="${entry#*|}"
    rm -rf "$link"
    mv "$backup" "$link"
  done
  workspace_backups=()
}

prepare_workspace_packages
pnpm --filter @jarvis/desktop make:mac
restore_workspace_packages
app_source="$(find "$desktop_root/out" -maxdepth 3 -type d -name '*.app' -print | sort | head -n 1)"
if [[ -z "$app_source" || ! -x "$app_source/Contents/MacOS/Jarvis" ]]; then
  echo "Electron Forge did not produce an executable macOS arm64 .app." >&2
  exit 1
fi

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
marker_path="$install_root/app-when-ready.json"
cp -R "$app_source" "$installed_app"

JARVIS_DESKTOP_SMOKE_MARKER="$marker_path" \
JARVIS_DESKTOP_SMOKE_ROOT="$install_root" \
  "$installed_app/Contents/MacOS/Jarvis" --disable-gpu \
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
  echo "Installed Jarvis.app did not reach app.whenReady while its process was alive." >&2
  tail -80 "$install_root/electron.stderr.log" >&2 || true
  exit 1
fi

# Keep the installed process alive long enough for the rest of the
# app.whenReady callback (including tray construction) to complete.
sleep 1
if ! kill -0 "$app_pid" 2>/dev/null; then
  echo "Installed Jarvis.app exited after app.whenReady." >&2
  tail -80 "$install_root/electron.stderr.log" >&2 || true
  exit 1
fi

marker_event="$(jq -r '.event // empty' "$marker_path")"
marker_pid="$(jq -r '.pid // empty' "$marker_path")"
if [[ "$marker_event" != "app.whenReady" || "$marker_pid" != "$app_pid" ]]; then
  echo "Electron smoke marker did not prove the installed process reached app.whenReady." >&2
  exit 1
fi
echo "Desktop install/start smoke passed: Jarvis.app pid $app_pid reached app.whenReady."

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
