# Phase 9B live harness

This directory contains the bounded live acceptance foundation. It owns
preflight, provider configuration selection, isolated runtime creation,
owned-process supervision, budget observation, evidence validation, and the
interactive JSONL control boundary. It does not claim that the Desktop
scenarios have been completed.

## Commands

Run the offline preflight with the pinned Codex executable supplied by the
caller:

```sh
PHASE9B_CODEX_PATH=/absolute/path/to/pinned/codex \
pnpm phase9b:preflight -- --no-provider-call
```

The command writes one bounded JSON object. A successful offline preflight has
exit status `0`, even though its aggregate status is `UNVERIFIED` while no
provider probe was requested. `UNVERIFIED` means that platform, pinned
toolchain, and credential presence checks completed; it does not prove
provider access. Missing credentials, an unsupported platform, or a toolchain
failure returns a `BLOCKED_*` status and exit status `1`. The default mode is
offline. Provider access is only enabled by an explicit caller-owned probe;
provider-call mode also requires the explicit
`RESOLVED_NO_REUSABLE_CREDENTIAL_EXPOSURE` security status before the probe
boundary. An omitted or unresolved status returns
`BLOCKED_SECURITY_REMEDIATION` without invoking the probe. The contract test
command never invokes a provider.

The interactive runner is a long-lived JSONL process:

```sh
PATH=/absolute/path/to/pinned/node/bin:$PATH \
PHASE9B_CODEX_PATH=/absolute/path/to/pinned/codex \
PHASE9B_CODEX_HOME=/absolute/path/to/isolated/login-home \
PHASE9B_PROVIDER_CONFIG_FILE=/absolute/path/to/private/provider-source.json \
PHASE9B_PROVIDER_PREFLIGHT_CALLS=2 \
PHASE9B_API_PATH=/absolute/path/to/Jarvis.Api \
PHASE9B_DEVICE_NODE_PATH=/absolute/path/to/Jarvis.DeviceNode \
PHASE9B_DESKTOP_APP_PATH=/absolute/path/to/Jarvis.app \
PHASE9B_SECURITY_REMEDIATION_STATUS=RESOLVED_NO_REUSABLE_CREDENTIAL_EXPOSURE \
pnpm phase9b:live
```

On macOS, set `PHASE9B_USE_LAUNCHD=1` to load the API and Device Node through
two run-unique launchd labels. The harness writes owner-only plists and log
files beneath the run root, proves each label points to its own plist, waits
for API readiness and the exact newly bootstrapped Device Node identity to be
online, and bootouts only those proven-owned jobs. Desktop remains a foreground
owned process under the same run. Without this explicit flag, API, Device
Node, and Desktop use the direct owned-process adapter and the result remains
`installation.status=UNVERIFIED`.

The only accepted commands are:

```json
{"command":"prepare"}
{"command":"start"}
{"command":"observe"}
{"command":"observe","conversationId":"00000000-0000-4000-8000-000000000000"}
{"command":"stop","service":"deviceNode"}
{"command":"restart","service":"deviceNode"}
{"command":"finish"}
```

Each command is a bounded object. Extra fields, scripts, arbitrary paths,
provider payloads, and caller-supplied status values are rejected. `prepare`
returns a safe run id and bounded readiness and budget metadata; private paths,
including the nonce fixture path, remain trusted process internals and are
never serialized. It never returns the nonce or a bearer. `start` starts only
owned processes and arms the durable admission ledger plus the SQLite budget
observer. `observe`
reads authenticated health, device, conversation, and database facts. The
`stop` and `restart` commands accept only `api`, `deviceNode`, or `desktop`;
Desktop restart omits the bootstrap bearer and uses its existing encrypted
store. Required normal Desktop close actions still use the product UI.
`finish` is idempotent and stops
owned process groups before removing the owner-marked runtime root. SIGINT,
SIGTERM, and the hard runtime timeout use the same cleanup path.

Future Desktop automation must use `desktop-automation.mjs`. Stage 1 provides
the adapter contract and offline fixture seam; it is not an attached Desktop
live driver, and it does not add product controls. Its page adapter has only
`readTestId(testId)` and `clickTestId(testId)` operations. The fixed
state ids are `phase9b-app-status`, `phase9b-realtime-status`,
`phase9b-realtime-remote-track-count`, `phase9b-conversation-id`,
`phase9b-message-count`, `phase9b-task-count`, `phase9b-notification-count`,
`phase9b-approval-count`, `phase9b-device-status`,
`phase9b-codex-task-status`, `phase9b-user-input-status`,
`phase9b-approval-status`, `phase9b-signalr-status`, and
`phase9b-artifact-sha256`. The fixed action ids cover connect/disconnect
Realtime, send fixture, pause/resume SignalR, load conversation, answer input,
approve, deny, restart Device Node, and quit: `phase9b-connect-realtime`,
`phase9b-disconnect-realtime`, `phase9b-send-fixture`,
`phase9b-pause-signalr`, `phase9b-resume-signalr`,
`phase9b-load-conversation`, `phase9b-answer-input`, `phase9b-approve`,
`phase9b-deny`, `phase9b-restart-device-node`, and `phase9b-quit`. The adapter exports only bounded
states and enums, counts, UUIDs, booleans, error codes, and SHA-256 values;
caller selectors, evaluation, scripts, DOM or accessibility text, clipboard,
Keychain data, screenshots, URLs, credentials, private text, and absolute
paths are rejected. `runLive` sanitizes the driver result before it reaches
evidence, and an explicit
`RESOLVED_NO_REUSABLE_CREDENTIAL_EXPOSURE` status is required before a complete
scenario set can become `PASS`.
When this status is omitted or unresolved, `prepare` and any live scenario
driver stop with `BLOCKED_SECURITY_REMEDIATION` before starting owned services
or entering a driver boundary.

The interactive CLI reports bounded observations; it does not fabricate A-J
scenario outcomes or automatically export a completed evidence bundle. The
operator must collect verified scenario metadata before `finish`, write it
through `writeLiveEvidence` from `evidence.mjs`, and validate the resulting
bundle. The optional Desktop `realtime-track-check.json` contains only
connection state and remote track counts. It must be copied, secret-scanned,
and included by relative path, byte count, and SHA in the evidence manifest
before runtime cleanup. A file left only in the runtime root is not retained
acceptance evidence.

Validate a completed evidence bundle with:

```sh
pnpm phase9b:validate-live-evidence /absolute/path/to/evidence-bundle
```

The validator prints only the schema status and run id. Evidence paths must be
under the caller's owner-only live-artifact root and are validated against the
strict allowlist; raw credentials, headers, provider bodies, prompts,
transcripts, audio, environment dumps, and arbitrary caller objects are not
accepted.

## Codex restart protocol probe

`codex-restart-probe.mjs` is a separate, bounded protocol experiment for pinned
Codex `0.146.0`. Its offline contracts run through
`pnpm test:phase9b-live-contract`; they do not authenticate or invoke Codex.
The real entry requires the resolved security status, passed Desktop/probe
offline gates, the pinned binary, and newly created owner-only authentication
metadata supplied as `PHASE9B_CODEX_AUTH_METADATA`. The metadata is claimed
once and must never refer to an earlier login or runtime.

Use the reviewed private-capture login and execution controller. It suppresses
all raw login/App Server output and validates the probe's bounded projection
before retaining evidence. Do not run or inspect authentication through generic
UI/DOM/accessibility capture. The experiment allows one task, one App Server
restart, one answer and at most one continuation. Recovery classification has a
ten-second bound; observed runtime errors remain failures. Only a real completed
reissue or verified continuation establishes recovery support. Offline fixtures
and generated protocol schemas do not establish that support.

Failed probes may include `rejectedMessage` with a fixed message-kind enum and
a method enum from the pinned schema; unknown methods become `UNKNOWN`.
This identifies the message rejected by parsing or validation, not necessarily
an unsupported method. Interpret it together with `errorCode`; no payload,
arbitrary method text, or raw error is retained. Successful probes reject this field.

## Configuration and isolation

For Phase 9B-R, the user-designated Provider configuration file is the approved
source. Supply its absolute path through `PHASE9B_PROVIDER_CONFIG_FILE` in the
private controller environment, never as a command-line argument or in evidence.
The interactive runner requires this explicit source and ignores ambient
Provider overrides. Targeted and final live execution must wait for all offline gates. The standalone Codex probe
uses separate fresh Codex authentication and does not read Provider keys.

The credential loader reads `UserSecretsId` from
`src/backend/Jarvis.Api/Jarvis.Api.csproj`, then reads the BOM-safe Secret
Manager file at `~/.microsoft/usersecrets/<id>/secrets.json`. It selects only
the approved Azure OpenAI Realtime and DeepSeek Responses fields. ASP.NET
double-underscore environment overrides remain available to standalone loader
callers, but are disabled by the interactive runner. Unrelated database, local bearer, profile, and daily credentials are
not copied, and `OPENAI_API_KEY` is not required.

Provider policy accepts HTTPS Azure OpenAI endpoints on the official supported
domains and `https://api.deepseek.com/` for DeepSeek. Authentication mode and
model ids are explicit; an invalid endpoint or missing model blocks the run
without substitution or fallback.

Every run gets a fresh owner-marked temporary root, loopback port, local API
bearer, safety salt, SQLite path, Desktop profile, allowed root, and Codex
home. Provider keys stay in trusted memory: the API production configuration
contains only `ProviderKeySource:Path`, and API startup selects `OpenAI:ApiKey`
and `DeepSeek:ApiKey` from that original file into an in-memory configuration
provider before registering services. Invalid or missing selected keys stop
startup with a fixed error and no source details. No Provider keys are written
to runtime JSON, launchd plists, child environment overrides, or artifacts.
Fresh local runtime values use private 0600 JSON beneath a 0700 run root.
The external Codex login home may be
atomically adopted after owner and pinned-helper validation; the normal global
Codex home is never copied. Version probing also uses a disposable isolated
`CODEX_HOME` so `codex --version` cannot touch the daily profile.

For Phase 9B-R, prepare authentication with a separately reviewed launcher that
captures login stdout and stderr privately. It must create a new owner-only
runtime root containing distinct `HOME`, `CODEX_HOME`, `TMPDIR`, and allowed
root directories, verify the pinned executable, and explicitly select
`cli_auth_credentials_store=file`. Use a minimal child environment. Do not run
an uncaptured `codex login` command in an automation terminal, inspect the
login UI, print an OAuth URL or callback, or copy an existing authentication
cache. The launcher may open the validated official login URL privately in
the browser for the user's normal login interaction.

Authentication readiness consists only of successful process status and
metadata checks on the new file store: a regular `auth.json` owned by the
current user with mode 0600. Never read or hash its contents. Login failure
must stop owned processes and remove the newly created runtime. These launcher
requirements are outside the interactive CLI; the CLI is not a safe collector
for arbitrary login output.

The restart protocol probe consumes its own fresh login environment once.
Targeted and final A-J runs each require a different new login environment,
Desktop profile, database, device identity, bearer, allowed root, and runtime
root. Only the two App Server processes within the one bounded restart probe
may share that probe's home. A consumed probe or previous live runtime must
never be adopted by a later run.

The interactive harness's external-home adoption also requires the regular
owner-only `.phase9b-owned` marker with exactly
`{"purpose":"isolated-normal-codex-login","dailyHomeCopied":false}` as its
JSON fields. This marker is an ownership check, not proof that old credentials
are safe to reuse. The caller must prepare it only for the newly authenticated
home intended for that one live run; the normal daily profile is never an
eligible source.

## Budgets and current acceptance boundary

The hard limits are 12 provider requests, 4 Realtime connections, 2 Realtime
tool-call attempts, 5 Codex tasks, and 2 retries. The provider preflight count
is seeded explicitly (for example, `PHASE9B_PROVIDER_PREFLIGHT_CALLS=2`) in
the durable per-run admission ledger. Startup performs a capacity check for
the packaged Desktop path; it does not reserve requests that have not happened.
Each provider request, Realtime connection, delegation, Codex task, and retry
must reserve its kind in that ledger immediately before its wire or process
boundary. The ledger's `limits`/`used` snapshot is the authoritative budget
report and survives runtime process restarts within the run. SQLite remains a
separate observed-facts source: its counts are checked against ledger
reservations and reported with their source names, but never increment or
replace the ledger counts.

The default direct-process `start` path reports
`installation.status=UNVERIFIED` with `reason=LAUNCHD_NOT_WIRED`; the explicit
launchd flag reports `installation.status=PASS` only after the owned API and
Device Node jobs are loaded and the exact Device Node identity is online. The
live runner still reports `LIVE_PARTIAL` when a Desktop scenario driver is
unavailable.
The live Device Node enables Codex's explicit user-input and permission
request features for the acceptance scenarios. Its host capability envelope
allows file writes only below the single per-run allowed root; command
execution and network access remain disabled.
Consequently no A-J scenario is promoted to `PASS` by an empty or partial
scenario set. DeepSeek does not support the background retrieve/cancel
subscenarios, so those remain explicitly unsupported and never become `PASS`.

The contract suite is offline and safe for ordinary CI:

```sh
pnpm test:phase9b-live-contract
```

For the isolation contract alone, use the pinned Node executable supplied by
the run:

```sh
/absolute/path/to/pinned/node \
  --test eng/live/phase9b/isolation.test.mjs
```
