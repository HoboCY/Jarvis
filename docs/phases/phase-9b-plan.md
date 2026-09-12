# Phase 9B — Desktop live acceptance

## Phase 9B-R resumption — 2026-09-10

The controlling specification is PR #8 comment `5567414121`, with the user's
2026-09-10 security confirmation and execution-order clarification. Work remains
on `codex/phase9b-desktop-golden-path`; the verified starting HEAD is
`243d6db220ff2b00bcde4fc32df762d8cc7076f5`, based on
`5df7533141107585cfbaa90a9c40d78a7b0b959a`. PR #8 remains Draft and must not be
merged; no new PR or Phase 9C work is authorized.

Security remediation is `RESOLVED_NO_REUSABLE_CREDENTIAL_EXPOSURE`, based on the
user's explicit non-secret confirmation. The historical UI-output incident stays
recorded. There is no established Provider API Key exposure and no provider-key
rotation requirement. No exposed value or derived representation is reproduced.

Execution order:

1. Enforce restricted automation output and prove it with offline contracts.
2. Repair normal Realtime quit, safe automatic live rotation, SignalR reconnect
   HTTP catch-up, and selected-Conversation restoration before auto-connect.
3. Probe the pinned Codex `0.146.0` restart protocol and implement only proven
   recovery behavior, with bounded fail-closed handling where unsupported.
4. Complete offline regression, actual macOS packaging, and publish checks.
5. Only after the offline gates pass, execute a new isolated targeted gap run,
   freeze the candidate, and run the complete A–J acceptance from that exact SHA.

The 2026-09-12 checkpoint has verified independent browser authentication and
attempted the pinned native probe twice. Both stopped before `turn/start`:
the first failed during initialization because CLI dotted permission keys were
quoted; the second rejected `remoteControl/status/changed` during thread startup.
Neither reached a pending interaction, restart, answer, or continuation, so neither
establishes an A/B/C recovery result or a native protocol limitation.
Both process groups were cleaned up. Consumed authentication environments are
not reused; intervening expired logins were removed by the login controller.

The startup fixes now use the product's unquoted generated permission-profile
key and the pinned `optOutNotificationMethods` capability for the unrelated
remote-control status notification. An unauthenticated check using the actual
probe transport and pinned binary passed initialization, thread creation, exact
permission-profile ID confirmation, and cleanup without starting a Turn. This
is not behavioral proof of every filesystem/network rule; that remains a native
acceptance gap. The full
live-harness contracts pass 139/139. A fresh authenticated recovery probe remains
required. Targeted and final A–J runs have not started.

Every new live run requires a fresh CODEX_HOME, Desktop profile, database, bearer,
device identity, allowed root, owner marker, launchd labels, and run ID. Prior
runtime resources and logins must not be reused. Automation output remains limited
to approved state fields, enums, counts, UUIDs, booleans, bounded error codes, and
SHAs; OAuth URLs, tokens, credentials, private text, generic DOM/UI dumps, full
accessibility trees, and unrestricted screenshots remain prohibited.

The prior `LIVE_PARTIAL` run remains historical evidence only. No new live result
or final candidate is claimed by this resumption record. Provider boundaries,
hard budgets, migration rollback limits, and exact-SHA review/CI requirements in
the specification remain in force.

Initial offline verification on the resumption baseline:

- Restricted automation and evidence contracts passed 85/85 tests; lint passed.
  Independent Standards and Spec review found no remaining P1/P2 after fixing
  the real interactive CLI service-state projection and requiring the explicit
  resolved security status for every new PASS evidence record. These are offline
  contract results, not live Desktop acceptance.
- A subsequent emitting-boundary review found that the inherited process
  supervisor could still expose a length and digest derived from arbitrary raw
  process output. No actual credential exposure was established. The process
  output projection now contains only fixed observed/suppressed booleans. The
  direct writer and bundle validator also reject generic scenario output; the
  arbitrary-output summary producer/export was removed. Full live-harness
  contracts pass 90/90 and harness lint passes. Independent follow-up review of
  the remaining evidence boundary found no P1/P2 and re-ran the focused tests
  25/25 successfully. The user's resolved incident status is unchanged.
- Added exact-name Git ignore rules for `appsettings.secrets.json` and
  `secrets.json`. Filename/index checks confirm they are ignored and neither is
  tracked or staged; the corresponding example templates remain trackable.
  The original checkout remains on its existing Phase 9A branch; shared local
  Git exclude rules now protect both worktrees without changing that branch or
  its source files. Both indexes contain zero matching secrets files, and
  example templates remain trackable. No credential content was read.
- The restricted-output checkpoint is local commit
  `40ec81c2894474c4783cfd62f5bae6080c5ea6b7`; it is not a frozen live candidate.
- Desktop normal quit now waits for nonce-bound renderer acknowledgement and
  trusted bounded Main compensation; immutable terminal intents survive retries
  for every confirmed session. Rotation is single-flight and keeps the production
  50-minute default. Validated live controls operate the real SignalR connection,
  and Main persists selected Conversation metadata before startup auto-connect.
- Follow-up review closed the lifecycle findings for confirmed-but-unactivated
  sessions, selection request versus connection binding, connection action state,
  and Conversation-scoped task snapshots. Final independent local verification
  passed Desktop unit tests 222/222 and shared Realtime-agent tests 13/13. The
  built Electron renderer scenario passed with clean stderr, all owned processes
  gone, and its fresh profile removed. Actual App coverage includes pending A
  connection followed by manual B selection and a late A result, empty B task
  state with global notifications preserved, failed B load preserving A, and
  same-A reload. Further binding and terminal races are covered by unit contracts.
  An earlier missing-observation renderer failure remains recorded without a
  proven cause. These checks do not prove authenticated backend, SignalR/WebRTC,
  or live acceptance behavior. Final independent Standards and Spec review found
  no remaining P1/P2, including the actual App surface verification gap.
- The Stage 2 checkpoint is local commit
  `90e500be047d43c78086de79ee0ae3d0f5e2af80`, not a frozen live candidate.
- A later Live J scope check found a remaining artifact-restoration P1 in
  that Stage 2 checkpoint: task projection drops manifests and startup loads
  only nonterminal tasks, so completed-task artifacts are not restored in the
  renderer. A bounded read-only manifest scan through the existing task API and
  safe renderer projection are implemented in a supplement. Partial results
  remain bounded across repeated scans and have a visible incomplete-state
  notice. The initial full unit run was 227/228, with a shutdown timing assertion
  failing under concurrent checks (its isolated 21-test suite passed). That test
  now uses a controlled monotonic clock. Independent final verification passed
  230/230 Desktop tests, typecheck, lint, build, and the actual built renderer;
  the renderer waits for the complete restored-state predicate and all owned
  processes/profile were removed. These are offline proofs only.
- A separate Gap 3/Live J check confirmed that ordinary HTTP catch-up loses a
  terminal task without artifacts while restoring its notification. There is
  no alternate App task-restoration path. Reuse the existing bounded all-status
  scan to restore read-only terminal identities/statuses separately from ongoing
  tasks, with the same Conversation binding guards. The supplement is now
  accepted offline; the earlier lifecycle proofs retain their tested scope.
- The first terminal-restoration supplement passed 233/233 unit tests, but
  independent public-seam checks found stale all-status snapshots could remove
  terminal events and mixed snapshots could put one task in both sections.
  Initial fixes passed those two cases; another controlled check still lost a
  terminal event that arrived before refresh started. The snapshot/event merge
  now preserves entity versions across both projections. Review also found an
  initial connected event could scan tasks without a Conversation while stored
  selection was loading. Unbound task queries and event projections are now
  guarded. Complete empty snapshots clear stale event-origin tasks, while partial
  scans preserve bounded known results. All 52 feed contracts and five public-seam
  snapshot/event orderings pass.
- The final actual App scenario proves automatic selection restoration without
  manual Load and HTTP-only catch-up after an offline task completion, including
  notifications and a terminal task without artifacts. Other waiting/artifact
  tasks remain; equal connection revisions do not trigger another refresh.
  Independent verification of the seven frozen Desktop files passed 241/241
  unit tests, typecheck, lint, build and the built renderer scenario (9.49 s).
  Stderr was clean; owned process groups and temporary profile were removed;
  source hashes matched before and after. Independent Standards / Spec review
  found no remaining P1/P2. This closes the Desktop offline gate only, not native
  protocol, real backend or live acceptance.
- The initial Stage 3 probe checkpoint is RED: syntax passed, but independent
  contract execution passed only 1/7. Preliminary review found incorrect pending
  history classification, request-ID de-duplication across process generations,
  insufficient authentication-directory isolation, and missing new-Turn proof.
  Its actual CLI/transport cleanup, cancellation, output and budget boundaries
  also require integration tests. These are unexecuted harness defects, not
  evidence of credential exposure or a native Codex protocol limitation. The
  probe remains blocked from authentication/execution until its fixes and
  independent review pass; no native probe or new provider call has occurred.
- The subsequent pure probe boundary checkpoint passed all 11 tests and lint
  independently. Three later guard findings (duplicate continuation audit,
  additional history Turns, and resolved-notification generation) are now
  closed in a narrow independent review. The earlier complete-flow checkpoint
  was RED at 13/14 tests, with three lint errors and an unfinished CLI. Its fake
  completion and parser used an obsolete flat shape instead of the pinned
  nested `turn/completed` shape; status loss caused the observed failure.
- The typed-notification/history supplement passed all 14 tests and lint in an
  independent frozen-source run. It uses the pinned nested completion shape,
  handles normal notifications, and checks both strict history argument shapes
  with controlled options and flags. Its lifecycle review remains open.
  Separate real Node process fixtures reproduced two cleanup defects: signal
  exit was reported as failure, and an exited leader with a surviving descendant
  was falsely reported as a removed process group. The fixtures were cleaned up;
  they used no Codex authentication or provider. CLI cancellation, bounded writes,
  delayed reissue arbitration and complete process-group cleanup must pass before
  native execution. Synthetic history does not prove native recovery support.
  A callback-stalled fake transport also reproduced unbounded writes and
  unhandled response rejection on abort, fatal input, or close. The native
  `serverRequest/resolved` notification must be connected to the typed current
  process registry; pure registry tests alone do not establish that transport
  behavior. Completion item classification and completion-failure evidence remain
  part of this lifecycle gate.
  The write/cleanup supplement passed 20/20 contracts and lint independently,
  but remains unaccepted: fake children used static PIDs which could direct
  cleanup signals at an unowned host group. That version is not being rerun;
  there is no evidence of an actual unrelated termination or credential exposure.
  Fake lifecycle control must be isolated from production owned-group control.
  A separate real Node pipe check also confirmed successful write callbacks use
  null, which the probe incorrectly rejected. That owned child and fresh temporary
  directory were removed. A real owned Node JSONL round trip must validate the fix.
  The first stalled-write RED produced no statistics within the wrapper's
  120-second observation window, so its pass/fail counts are unknown. The next
  frozen correction independently passed 22/22, lint and source-hash checks.
  Injected spawn has no ambient group authority by default; real pipe/cleanup
  tests use owned Node children. Supplemental independent review closed both P1s
  and the Windows boundary P2.
  The next typed-item/resolved-notification slice first produced RED at 22/25,
  then passed 29/29 and lint independently with unchanged source hashes.
  Review found that an input followed by a fatal message in one stdout batch
  could cross the restart boundary, and that item envelopes were not checked
  against the current request's thread/turn. A separate public history check
  also reproduced safe-continuation approval for an explicitly incomplete
  items view. The corrected frozen slice passed 31/31 independently (1.17 s),
  lint, ownership checks and matching pre/post source hashes. Independent review
  closed all three findings. Normal native completion summaries remain legal
  and are distinct from incomplete recovery history. The fatal-flow regression
  directly asserts zero restarts and answers; continuation exclusion follows
  from exiting before the second process, not a separate count assertion.
  The CLI/decision supplement passed 40/40 in the worker's direct Node test
  invocation (21.02 s); its initial RED statistics are unknown. The complete
  `pnpm test:phase9b-live-contract` invocation then failed independently at
  105/130 (25 failures, 5.54 s), with all reported failure stack locations in
  the probe tests. Eng live lint passed (1.96 s), and all five frozen source
  hashes matched before and after. A later worker correction passed 47/47
  directly and 137/137 through `pnpm exec` with serial execution; the normal
  package-script entry still produced 104 passes, 32 failures and one cancellation.
  Those two entry points do not isolate concurrency. A metadata-only root check,
  exiting before test execution, confirmed that `pnpm run` expands PATH beyond
  the probe's 1024-character environment limit and produces INVALID_ENVIRONMENT;
  direct Node does not. The test process must explicitly bound its environment
  while preserving the production restriction. No PATH contents were emitted,
  and no authentication/native gate was enabled by the check.
  The test-only correction then passed 137/137 through the normal package entry
  in the worker run. Its independent full-suite result remains UNVERIFIED because
  the invocation did not return recoverable completion metadata; the independent
  five-file hashes, Eng lint and both syntax checks passed. Review narrowed the
  remaining work to confirmed continuation counts after a same-batch reissue,
  completed-with-error handling in B, and a real child-spawn/group-absence
  handshake for CLI signal tests. The final correction produced RED at 0/2 and
  then GREEN at 2/2. Root independently ran the normal package entry: 139/139
  passed in 70.56 s, with zero failures, cancellations or skips. Eng lint passed
  in 2.35 s, both syntax checks passed, and all five frozen files matched after
  execution. Independent review closed the three remaining findings. Both real
  Node CLI signal tests wait for a dynamic spawn handshake and independently
  verify that the captured owned process group is gone.
  Review also found lost terminal facts during first-process stop, ignored late
  reissues before continuation, resolved requests incorrectly classified as C,
  inaccurate continuation completion/count evidence, and a mismatch between the
  fixed task instruction and its validator. At that earlier checkpoint, the CLI
  signal test covered SIGTERM through an injected cleanup function and did not
  establish the actual probe finally/owned-lifecycle chain; SIGINT had code
  wiring evidence only. These
  findings were closed by the final offline contracts and review. Native
  protocol support remains unverified until the controlled real probe runs.
  Login requires private capture and separate fresh environments for the probe,
  targeted run, and final run.
- Locked .NET restore, tool restore, frozen pnpm install, and the pinned Codex
  schema/canonical checks passed. Node `24.19.0` and Codex `0.146.0` were obtained
  in a new tool-only directory and checked against their published/pinned hashes.
- The npm audit found current high-severity advisories in `extract-zip` and
  `js-yaml`; this gate has not passed. Fixes must not add audit suppressions.
- A filename-rule audit found service publish staging does not explicitly exclude
  local secrets or generated Production configuration. Exclusion and final
  output-inventory checks must pass before publishing. No actual secret/config
  contents were read and no exposure is established. Desktop ASAR packaging
  already enforces an exact positive entry list; retain and exercise that gate.
- The initial NuGet CLI vulnerability command timed out, including bounded
  retries. Diagnostic request metadata showed historical package-registration
  enumeration. Re-running `dotnet list Jarvis.sln package --vulnerable
  --include-transitive --no-restore --format json` with `--configfile` pointing to
  a temporary configuration that explicitly sets the official nuget.org
  `auditSources` completed in 9.3 seconds: 13 projects, no vulnerable packages.
  The package source remained the same official source; no advisory was
  suppressed. The initial timed-out invocations remain recorded as timeouts.
  A separate comparison of all 13 restored solution projects and 112 unique
  resolved packages against the official NuGet vulnerability catalog found no
  matches. It used NuGet's `VersionRange.Satisfies` implementation and a positive
  control detected the known `System.Text.Json` `8.0.0` advisories. This supplemental
  comparison independently corroborated the successful CLI audit. The catalog
  base SHA-256 was
  `e50e838b5b651f067a8756c33e2aca03a145e36fe6161b717bdf06ea03f083dc`.
- No provider request or new authenticated live run was made by these checks.

## Scope and approved provider change

The user requested execution of the Phase 9B instructions in the ChatGPT conversation
`分析Jarvis项目`, then confirmed on 2026-09-06 that acceptance should use the existing
Azure OpenAI Realtime and DeepSeek Responses configuration. This replaces the original
official-OpenAI-only provider requirement. It does not turn missing live evidence into a pass.

The user has now supplied the exact ASP.NET Core User Secrets source privately
in this task. Only the Azure OpenAI and DeepSeek fields needed by Phase 9B may be
selected. No provider-source content has been read in this resumption. The source
must not be replaced by a fallback or ambient environment values. Credential
contents must not be copied, summarized, hashed, logged, committed, or included in
arguments or evidence. The current interactive harness still materializes provider
keys in temporary production JSON; that path must be replaced and verified before
any provider configuration is loaded for a new live run. The daily database,
local bearer, Desktop profile, and Codex home are not reused.

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
- Keep provider credentials only in trusted process memory; the current user restriction
  forbids copying them into temporary production JSON. No credentials in arguments,
  plists, Renderer state, logs, evidence, or committed files.
- Do not print the generated local bearer, salt, device bootstrap credential or test nonce.
  Use a run-specific Desktop application name to isolate its safeStorage Keychain entry.
- Limit paid provider requests to 12, Realtime connections to 4, delegation attempts to 2,
  and Codex tasks to 5. Enforce bounded scenario and whole-run timeouts. Stop on exhaustion.
- Record bounded statuses, counts, durations, versions, code SHAs and Jarvis UUIDs. Hash
  only validated external provider/Codex identifiers and controlled artifacts. For arbitrary
  process output record only fixed observed/suppressed booleans, never its length or hash.
  Exclude raw prompts, transcripts, provider responses, JSONL, DBs, audio and absolute user paths.
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
commits to the existing branch and PR #8 with the `full-matrix` label; do not create another
PR or merge PR #8.
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
