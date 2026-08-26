# Phase 6 E2E smoke entry

`run-e2e.sh` is the executable entry. `Phase6E2ESmokeTests` exposes eight named,
independently executable scenarios in `scenarios.json`: typed/realtime
conversation persistence, cross-modal context, interruption and continuation,
background task completion/notification pull, offline notification delivery,
Codex JSONL approval, persistent Device Node/Codex execution recovery, and
backend/session rotation context recovery. Each scenario uses the public API
and TestServer/SQLite seams; the approval case also starts a temporary fake
Codex JSONL child process. The runner verifies that every catalog entry appears
as an executed TRX test instead of merely mapping a test name.

The performance assertions measure typed-message P95 (<=300ms), TaskId
acceptance (<=1s), and notification publish/pull (<=2s) directly. The provider
boundary remains controlled fake input; these tests do not claim a live OpenAI
or production Codex guarantee.

The performance assertion is a warmed local control-plane budget only. TRX
reports are written to `artifacts/test-reports/phase6-e2e` by default.
