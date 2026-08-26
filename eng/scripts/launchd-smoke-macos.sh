#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "launchd-smoke-macos.sh requires macOS; skipped on $(uname -s)."
  exit 0
fi

if [[ "${JARVIS_SKIP_LAUNCHD_SMOKE:-0}" == "1" ]]; then
  echo "launchd smoke skipped because JARVIS_SKIP_LAUNCHD_SMOKE=1."
  exit 0
fi

service_root="$(mktemp -d "${TMPDIR:-/tmp}/jarvis-phase6-launchd.XXXXXX")"
api_label="com.hobocy.jarvis.phase6.api.$$.${RANDOM}"
device_label="com.hobocy.jarvis.phase6.device.$$.${RANDOM}"
api_port="$((40000 + (RANDOM % 1000)))"
api_url="http://127.0.0.1:${api_port}"
api_runtime="$service_root/api-runtime"
device_runtime="$service_root/device-runtime"
api_executable="$api_runtime/Jarvis.Api"
device_executable="$device_runtime/Jarvis.DeviceNode"
api_bundle="$repo_root/artifacts/services/Jarvis.Api-darwin-arm64.tar.gz"
device_bundle="$repo_root/artifacts/services/Jarvis.DeviceNode-darwin-arm64.tar.gz"
api_database="$service_root/data/${api_label}/jarvis.db"
credential_file="$device_runtime/device-identity.json"
device_codex_home="$device_runtime/codex-home"
api_installed=0
device_installed=0
device_id=""
notification_id=""
stage="initializing"

cleanup() {
  result_code=$?
  set +e
  if [[ "$result_code" -ne 0 ]]; then
    echo "launchd smoke failed at stage: $stage; service logs follow:" >&2
    echo "--- launchd status" >&2
    launchctl print "gui/$(id -u)/$api_label" 2>&1 | rg 'state =|pid =|last exit code' >&2 || true
    launchctl print "gui/$(id -u)/$device_label" 2>&1 | rg 'state =|pid =|last exit code' >&2 || true
    if [[ -f "$api_database" ]]; then
      echo "--- persisted smoke device row" >&2
      sqlite3 "$api_database" "SELECT Id, Status, LastSeenAtMs FROM Devices WHERE Id = '$device_id';" >&2 || true
    fi
    echo "--- isolated Device runtime files" >&2
    find "$device_runtime" -maxdepth 1 -type f -exec ls -l {} \; >&2 || true
    for log_file in \
      "$service_root/logs/$api_label/stdout.log" \
      "$service_root/logs/$api_label/stderr.log" \
      "$service_root/logs/$device_label/stdout.log" \
      "$service_root/logs/$device_label/stderr.log"; do
      if [[ -f "$log_file" ]]; then
        echo "--- $log_file" >&2
        tail -80 "$log_file" >&2
      fi
    done
  fi
  if [[ "$device_installed" -eq 1 ]]; then
    node "$repo_root/eng/scripts/install-launchd-service.mjs" uninstall \
      --root "$service_root" --label "$device_label" >/dev/null 2>&1 || true
  fi
  if [[ "$api_installed" -eq 1 ]]; then
    node "$repo_root/eng/scripts/install-launchd-service.mjs" uninstall \
      --root "$service_root" --label "$api_label" >/dev/null 2>&1 || true
  fi
  rm -rf "$service_root"
  exit "$result_code"
}
trap cleanup EXIT INT TERM

mkdir -p "$api_runtime" "$device_runtime"
device_runtime="$(cd "$device_runtime" && pwd -P)"
device_codex_home="$device_runtime/codex-home"

stage="publish"
echo "Publishing darwin-arm64 service binaries..."
JARVIS_RELEASE_VERSION="${JARVIS_RELEASE_VERSION:-phase6-smoke}" \
  "$repo_root/eng/scripts/publish-macos-arm64.sh" >/dev/null
if [[ ! -f "$api_bundle" || ! -f "$device_bundle" ]]; then
  echo "Publish did not produce complete API and Device Node bundles." >&2
  exit 1
fi
tar -xzf "$api_bundle" -C "$api_runtime"
tar -xzf "$device_bundle" -C "$device_runtime"
chmod 700 "$api_executable" "$device_executable"

api_config_json="$(node --input-type=module - "$api_runtime" "$api_database" <<'NODE'
import crypto from "node:crypto";
import { writeApiConfiguration } from "./eng/scripts/secure-service-config.mjs";

const directory = process.argv[2];
const databasePath = process.argv[3];
const bearerToken = crypto.randomBytes(32).toString("base64url");
await writeApiConfiguration({
  directory,
  bearerToken,
  openAiApiKey: "phase6-local-smoke-provider-key",
  openAiBaseUrl: "http://127.0.0.1:65535/",
  databasePath,
  fakeWorkerEnabled: true,
  fakeWorkerDelayMs: 10
});
process.stdout.write(JSON.stringify({ bearerToken }));
NODE
)"
api_bearer="$(jq -r '.bearerToken' <<<"$api_config_json")"

stage="install API"
echo "Installing isolated API launchd service ($api_label)..."
node "$repo_root/eng/scripts/install-launchd-service.mjs" install \
  --kind api --root "$service_root" --label "$api_label" \
  --executable "$api_executable" --working-directory "$api_runtime" \
  --api-port "$api_port" >/dev/null
api_installed=1

wait_for_http() {
  local path="$1"
  local header="${2:-}"
  local attempt
  for attempt in {1..40}; do
    if [[ -n "$header" ]] && curl --fail --silent --show-error \
      -H "$header" "$api_url$path" >/dev/null 2>&1; then
      return 0
    elif [[ -z "$header" ]] && curl --fail --silent --show-error \
      "$api_url$path" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

stage="API health"
wait_for_http "/health/live" "Authorization: Bearer $api_bearer"
curl --fail --silent --show-error \
  -H "Authorization: Bearer $api_bearer" \
  "$api_url/health/ready" >/dev/null
echo "API health live/ready passed on $api_url."

stage="register device"
registration="$(curl --fail --silent --show-error \
  -X POST "$api_url/api/v1/devices/register" \
  -H "Authorization: Bearer $api_bearer" \
  -H "Idempotency-Key: phase6-launchd-registration-$RANDOM" \
  -H "Content-Type: application/json" \
  -d '{"name":"Phase 6 launchd smoke device","deviceType":"desktop","platform":"macos","capabilities":[],"allowedRoots":[]}')"
device_id="$(jq -r '.deviceId' <<<"$registration")"
device_credential="$(jq -r '.deviceCredential' <<<"$registration")"
if [[ ! "$device_id" =~ ^[0-9a-fA-F-]{36}$ || -z "$device_credential" || "$device_credential" == "null" ]]; then
  echo "Device registration returned an invalid one-time identity." >&2
  exit 1
fi

stage="create notification task"
conversation="$(curl --fail --silent --show-error \
  -X POST "$api_url/api/v1/conversations" \
  -H "Authorization: Bearer $api_bearer" \
  -H "Idempotency-Key: phase6-launchd-conversation-$RANDOM" \
  -H "Content-Type: application/json" \
  -d '{"title":"Phase 6 launchd smoke"}')"
conversation_id="$(jq -r '.id' <<<"$conversation")"
task="$(curl --fail --silent --show-error \
  -X POST "$api_url/api/v1/tasks" \
  -H "Authorization: Bearer $api_bearer" \
  -H "Idempotency-Key: phase6-launchd-task-$RANDOM" \
  -H "Content-Type: application/json" \
  -d "{\"conversationId\":\"$conversation_id\",\"sourceMessageIds\":[],\"goal\":\"persist a launchd smoke notification\",\"expectedOutput\":\"done\",\"requiredCapabilities\":[]}")"
task_id="$(jq -r '.taskId' <<<"$task")"
if [[ ! "$conversation_id" =~ ^[0-9a-fA-F-]{36}$ || ! "$task_id" =~ ^[0-9a-fA-F-]{36}$ ]]; then
  echo "Smoke task acceptance returned invalid identifiers." >&2
  exit 1
fi

stage="wait notification"
notification_id=""
for attempt in {1..40}; do
  notifications="$(curl --fail --silent --show-error \
    -H "Authorization: Bearer $api_bearer" "$api_url/api/v1/notifications?status=unread")"
  notification_id="$(jq -r --arg task_id "$task_id" '.items[]? | select(.taskId == $task_id) | .id' <<<"$notifications" | head -1)"
  if [[ "$notification_id" =~ ^[0-9a-fA-F-]{36}$ ]]; then
    break
  fi
  sleep 0.25
done
if [[ ! "$notification_id" =~ ^[0-9a-fA-F-]{36}$ ]]; then
  echo "Fake worker did not persist the smoke notification." >&2
  exit 1
fi

stage="write isolated Device identity"
node --input-type=module - "$credential_file" "$device_id" "$device_credential" <<'NODE'
import { writeSecureJsonFile } from "./eng/scripts/secure-service-config.mjs";

await writeSecureJsonFile(process.argv[2], {
  deviceId: process.argv[3],
  deviceCredential: process.argv[4]
});
NODE

node --input-type=module - "$device_runtime" "$api_url" "$device_id" "$credential_file" "$device_codex_home" <<'NODE'
import { writeDeviceRuntimeConfiguration } from "./eng/scripts/secure-service-config.mjs";

await writeDeviceRuntimeConfiguration({
  directory: process.argv[2],
  apiBaseUrl: process.argv[3],
  deviceId: process.argv[4],
  credentialFilePath: process.argv[5],
  codexHome: process.argv[6]
});
NODE
if [[ "$(stat -f '%Lp' "$device_codex_home")" != "700" ]]; then
  echo "Device Node Codex home is not owner-only (expected mode 0700)." >&2
  exit 1
fi

stage="install Device Node"
echo "Installing isolated Device Node launchd service ($device_label)..."
node "$repo_root/eng/scripts/install-launchd-service.mjs" install \
  --kind device-node --root "$service_root" --label "$device_label" \
  --executable "$device_executable" --working-directory "$device_runtime" \
  --api-port "$api_port" >/dev/null
device_installed=1

wait_for_heartbeat() {
  local attempt
  local last_seen
  for attempt in {1..40}; do
    last_seen="$(sqlite3 "$api_database" "SELECT MAX(LastSeenAtMs) FROM Devices WHERE LastSeenAtMs IS NOT NULL;" 2>/dev/null || true)"
    if [[ "$last_seen" =~ ^[0-9]+$ && "$last_seen" -gt 0 ]]; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

wait_for_heartbeat_after() {
  local previous="$1"
  local attempt
  local last_seen
  for attempt in {1..40}; do
    last_seen="$(sqlite3 "$api_database" "SELECT MAX(LastSeenAtMs) FROM Devices WHERE LastSeenAtMs IS NOT NULL;" 2>/dev/null || true)"
    if [[ "$last_seen" =~ ^[0-9]+$ && "$last_seen" -gt "$previous" ]]; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

stage="wait first heartbeat"
wait_for_heartbeat
heartbeat_before="$(sqlite3 "$api_database" "SELECT LastSeenAtMs FROM Devices WHERE Id = '$device_id';")"
if [[ ! "$heartbeat_before" =~ ^[0-9]+$ ]]; then
  heartbeat_before="$(sqlite3 "$api_database" "SELECT MAX(LastSeenAtMs) FROM Devices WHERE LastSeenAtMs IS NOT NULL;")"
fi
echo "Device heartbeat persisted at $heartbeat_before."

stage="restart API"
echo "Restarting isolated API launchd service to exercise SQLite recovery..."
node "$repo_root/eng/scripts/install-launchd-service.mjs" uninstall \
  --root "$service_root" --label "$api_label" >/dev/null
api_installed=0
node "$repo_root/eng/scripts/install-launchd-service.mjs" install \
  --kind api --root "$service_root" --label "$api_label" \
  --executable "$api_executable" --working-directory "$api_runtime" \
  --api-port "$api_port" >/dev/null
api_installed=1
wait_for_http "/health/live" "Authorization: Bearer $api_bearer"
diagnostics_after_api_restart="$(curl --fail --silent --show-error \
  -H "Authorization: Bearer $api_bearer" "$api_url/api/v1/diagnostics")"
online_devices="$(jq -r '.work.onlineDevices' <<<"$diagnostics_after_api_restart")"
notification_after_api_restart="$(curl --fail --silent --show-error \
  -H "Authorization: Bearer $api_bearer" "$api_url/api/v1/notifications?status=unread" \
  | jq -r --arg notification_id "$notification_id" '.items[]? | select(.id == $notification_id) | .id' | head -1)"
if [[ "$online_devices" -lt 1 || "$notification_after_api_restart" != "$notification_id" ]]; then
  echo "API restart did not retain device/notification facts." >&2
  exit 1
fi
echo "API restart retained SQLite device ($online_devices online) and notification $notification_id."

stage="restart Device Node"
device_status_before="$(node "$repo_root/eng/scripts/install-launchd-service.mjs" status \
  --root "$service_root" --label "$device_label")"
device_pid_before="$(sed -n 's/.*pid = \([0-9][0-9]*\).*/\1/p' <<<"$device_status_before" | head -1)"
node "$repo_root/eng/scripts/install-launchd-service.mjs" uninstall \
  --root "$service_root" --label "$device_label" >/dev/null
device_installed=0
node "$repo_root/eng/scripts/install-launchd-service.mjs" install \
  --kind device-node --root "$service_root" --label "$device_label" \
  --executable "$device_executable" --working-directory "$device_runtime" \
  --api-port "$api_port" >/dev/null
device_installed=1
wait_for_heartbeat_after "$heartbeat_before"
heartbeat_after="$(sqlite3 "$api_database" "SELECT LastSeenAtMs FROM Devices WHERE Id = '$device_id';")"
if [[ ! "$heartbeat_after" =~ ^[0-9]+$ ]]; then
  heartbeat_after="$(sqlite3 "$api_database" "SELECT MAX(LastSeenAtMs) FROM Devices WHERE LastSeenAtMs IS NOT NULL;")"
fi
device_status_after="$(node "$repo_root/eng/scripts/install-launchd-service.mjs" status \
  --root "$service_root" --label "$device_label")"
device_pid_after="$(sed -n 's/.*pid = \([0-9][0-9]*\).*/\1/p' <<<"$device_status_after" | head -1)"
stage="validate Device Node restart"
if [[ -n "$device_pid_before" && -n "$device_pid_after" && "$device_pid_before" == "$device_pid_after" ]]; then
  echo "Device Node restart did not produce a new launchd process." >&2
  exit 1
fi
if [[ "$heartbeat_after" -le "$heartbeat_before" ]]; then
  echo "Device heartbeat did not advance after restart." >&2
  exit 1
fi

curl --fail --silent --show-error \
  -H "Authorization: Bearer $device_credential" \
  "$api_url/api/v1/device-tasks/active" >/dev/null
echo "Device heartbeat, secure identity reload, restart, and authenticated control-plane probe passed."
