#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
results_directory="${JARVIS_E2E_RESULTS_DIR:-$repo_root/artifacts/test-reports/phase6-e2e}"
mkdir -p "$results_directory"

dotnet test "$repo_root/tests/e2e/Jarvis.E2E.Tests.csproj" \
  --configuration Release --no-restore \
  --logger "trx;LogFileName=phase6-e2e-smoke.trx" \
  --results-directory "$results_directory"

node "$repo_root/tests/e2e/verify-scenarios.mjs" \
  "$repo_root/tests/e2e/scenarios.json" \
  "$results_directory/phase6-e2e-smoke.trx"

# Keep the focused backend suites as additional regression evidence; the eight
# catalog entries above are independently executable and checked against TRX.
dotnet test "$repo_root/tests/backend/Jarvis.Api.IntegrationTests/Jarvis.Api.IntegrationTests.csproj" \
  --configuration Release --no-restore \
  --filter "FullyQualifiedName~ConversationApiTests|FullyQualifiedName~RealtimeApiTests|FullyQualifiedName~Phase5RealtimeContextTests|FullyQualifiedName~TaskApiTests|FullyQualifiedName~FakeWorkerTests|FullyQualifiedName~NotificationApiTests|FullyQualifiedName~SignalRTests|FullyQualifiedName~OutboxTests|FullyQualifiedName~Phase4ApiTests" \
  --logger "trx;LogFileName=phase6-backend-scenarios.trx" \
  --results-directory "$results_directory"

dotnet test "$repo_root/tests/backend/Jarvis.DeviceNode.Tests/Jarvis.DeviceNode.Tests.csproj" \
  --configuration Release --no-restore \
  --filter "FullyQualifiedName~DeviceNodeTests" \
  --logger "trx;LogFileName=phase6-device-node.trx" \
  --results-directory "$results_directory"

echo "Phase 6 E2E smoke reports: $results_directory"
