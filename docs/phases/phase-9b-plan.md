# Phase 9B — Desktop live acceptance

## Scope and approved provider change

The user requested execution of the Phase 9B instructions in the ChatGPT conversation
`分析Jarvis项目`, then confirmed on 2026-09-06 that acceptance should use the existing
Azure OpenAI Realtime and DeepSeek Responses configuration. This replaces the original
official-OpenAI-only provider requirement. It does not turn missing live evidence into a pass.

Provider credentials come from the API project's existing ASP.NET Core User Secrets.
Only provider settings are selected for the isolated run; the daily database, local bearer,
Desktop profile and Codex home are not reused. Environment overrides retain their existing
precedence. Credential values and any value derived from a credential are excluded from
reports and command output.

| Component | Selected configuration | Acceptance boundary |
| --- | --- | --- |
| Realtime | Azure OpenAI, `gpt-realtime-2.1-mini`, `alloy`, `ApiKey` authentication | Real client-secret issuance and Desktop WebRTC; deployment access must be observed |
| Responses | DeepSeek, `deepseek-v4-flash` | Real synchronous create, persisted task result and notification |
| Background Responses | Unsupported by this provider | Retrieve-after-restart and provider-side cancellation are excluded, never reported PASS |
| Local executor | Codex App Server `0.146.0` | Independent home, real protocol and provider authentication, unchanged capability enforcement |

Azure's current GA endpoints are `/openai/v1/realtime/client_secrets` and
`/openai/v1/realtime/calls`. [Microsoft documentation](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio-webrtc).
DeepSeek's Responses interface is stateless and does not support background execution or
stored-response retrieval. [DeepSeek documentation](https://api-docs.deepseek.com/guides/responses_api/).

## Baseline

- PR [#7](https://github.com/HoboCY/Jarvis/pull/7) was merged with the expected head
  `12598a6998ca6b51c8bfac1918f8c7e6ad102143`.
- The merge commit and this branch's starting point are
  `5df7533141107585cfbaa90a9c40d78a7b0b959a`.
- Main [Run #29](https://github.com/HoboCY/Jarvis/actions/runs/33941226361) completed
  successfully for that merge commit: all ten jobs succeeded and all seven expected
  artifacts are present and unexpired, verified again on 2026-09-06.
- The summary ZIP metadata reports digest
  `2aae67b54521da2cac661d0acf940d342b1c5dcbd6224d19420b6839e1bfbaa0`.
  Its download currently returns HTTP 403. The generating job's successful status and
  inputs are available; direct inspection of the archived JSON remains unverified.
- Work uses branch `codex/phase9b-desktop-golden-path` in a separate worktree.
  The original worktree and its untracked Phase 9A result summary are preserved.

## Scenario acceptance

| Scenario | Required observable result |
| --- | --- |
| A — isolated installation | Packaged Desktop, self-contained API and Device Node installed under unique launchd labels; authenticated readiness, pairing and online heartbeat. An owner-only identity file is a test seam; production Keychain remains UNVERIFIED |
| B — Realtime | A conversation created through Desktop; typed input, actual WebRTC connection and provider session event; persisted normalized events, audio-track evidence and session rotation |
| C — delegated Responses | A real Realtime `delegate_task` call routes a nonce task to DeepSeek; exactly one terminal result and durable notification are visible in Desktop |
| D — restart and cancellation | Original background retrieve/cancel checks are unsupported. Applicable local task cancellation and completed-result persistence are recorded separately |
| E — local read task | Real Codex reads a fixed nonce fixture inside one allowed root; fixture manifest remains unchanged |
| F — user input | Actual Codex user-input request is persisted, displayed and answered through Desktop; original execution resumes without duplicate effects |
| G — deny | Actual write approval is denied through Desktop; no output file or repeated write attempt |
| H — approve once | One explicit approval permits the nonce output; repeated decisions are idempotent and the approval cannot be reused by another request |
| I — Device Node restart | A pending interaction survives a Device Node restart, preserving task/execution identity and bounded effects |
| J — cold start | After Desktop/API restart, HTTP reads reconstruct the same conversation, tasks, interactions, notifications and artifacts from persistence |

A scenario is PASS only when the real observable behavior occurs. A mock, scripted JSONL
executor, direct database write, manually fabricated provider event or API-only substitute
does not establish the Desktop live path. Hardware acoustics and human audibility remain
outside this phase even when a remote audio track is observed.

For H, the expected text payload is fixed before task creation: the run nonce encoded as
UTF-8, followed by exactly one LF line terminator. The live task receives this fixed payload
and must request permission before using the file editing tool. Acceptance compares the
actual file byte for byte with that predetermined payload and validates the persisted
artifact manifest. E keeps writeFiles, runCommands and network capabilities disabled.

## Implementation and validation

Explicit `phase9b:preflight` and `phase9b:live` commands own this workflow. Default tests,
builds and CI remain offline. Public contract tests cover configuration selection, missing
credentials without network access, endpoint validation, budgets, timeouts, strict evidence,
temporary-root ownership and cleanup. Any required product fix receives a failing regression
test at an existing public seam before the minimal implementation.

Before paid calls, validate the locked toolchain and build/test gates. Use Node `24.19.0`,
pnpm `10.24.0`, .NET SDK `10.0.100`, Electron `44.0.0`, and the pinned Codex binary with
SHA-256 `ae1d3ffe6d48aec6a4dc3f50e7eb8e0d11962485a6a9406c5a7012139383da02`.
The isolated pinned tools do not replace the user's global installations.

The local gates include locked restores, Release build/tests, format verification, dependency
audits, migration check, workspace typecheck/lint/headless/build, OpenAPI identity and Codex
schema checks, secret-scan fixtures, service-manifest contracts, the built renderer scenario,
offline E2E and the new live contracts. Run focused checks after changes; record actual
commands and results in the acceptance report.

## Runtime and evidence controls

- Use a unique owner-only temporary runtime root with fresh local bearer, safety salt,
  isolated DB, profile, Codex home, allowed files and dynamically allocated loopback ports.
- Keep credentials in the trusted parent or an owner-only temporary production configuration;
  no credentials in arguments, plists, Renderer state, logs or committed files.
- Do not print the generated local bearer, salt, device bootstrap credential or test nonce.
  Use a run-specific Desktop application name to isolate its safeStorage Keychain entry.
- Limit paid provider requests to 12, Realtime connections to 4, delegation attempts to 2,
  and Codex tasks to 5. Enforce bounded scenario and whole-run timeouts. Stop on exhaustion.
- Record bounded statuses, counts, durations, versions, code SHAs and Jarvis UUIDs. Hash
  external provider/Codex identifiers; record output length and SHA only. Exclude raw
  prompts, transcripts, provider responses, JSONL, DBs, audio and absolute user paths.
- The optional Desktop observation entry point reads the public WebRTC receiver surface
  after connection. It records only the internal Realtime session UUID, connection state,
  and remote/live audio-track counts. Main validates the live profile and exact renderer
  sender, then atomically stores at most four records in the owned runtime root. Ordinary
  launches do not register this IPC entry point or expose its preload bridge.
- Write validated evidence and a relative-path artifact manifest atomically under ignored
  `artifacts/live/phase9b/<run-id>/`, with directory mode `0700` and file mode `0600`.
- Cleanup only owned processes, services and temporary data. Scan for known secrets without
  printing them. Cleanup failure or secret leakage prevents PASS.

## Delivery and rollback

The acceptance report distinguishes verified, unsupported, blocked and unverified scenarios.
Review the final diff independently for standards and specification fit. Push only scoped
commits and open a PR against main with the `full-matrix` label; do not merge it automatically.
Remote CI success must refer to the final PR head SHA; live evidence remains bound to its
installed candidate SHA. Phase 9C does not begin in this task.

Harness commands, budget admission and Desktop audio observation are opt-in and require
an isolated owned run. Product fixes also affect ordinary startup, Codex completion and
cancellation, lease renewal, default device selection and approval request identity.

The `20260906075325_Phase9BApprovalRequestScope` migration changes approval uniqueness
from `(DeviceId, RequestId)` to `(DeviceId, ExecutionId, RequestId)`. Up accepts existing
rows because the old constraint is stronger. Once separate executions reuse a native
request ID, Down cannot restore the old unique index losslessly. Rollback requires a
pre-upgrade database backup or an explicit plan for conflicting data; never silently delete
user rows. Reverting binaries alone is insufficient after applying this migration.

Remove owned temporary runtime data and revert scoped code only when appropriate for the
persisted schema. Daily services, credentials and unrelated user content remain outside
the cleanup scope. The acceptance report records actual cleanup and any security failure.
