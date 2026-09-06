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
the contract test command never invokes a provider.

The interactive runner is a long-lived JSONL process:

```sh
PATH=/absolute/path/to/pinned/node/bin:$PATH \
PHASE9B_CODEX_PATH=/absolute/path/to/pinned/codex \
PHASE9B_CODEX_HOME=/absolute/path/to/isolated/login-home \
PHASE9B_PROVIDER_PREFLIGHT_CALLS=2 \
PHASE9B_API_PATH=/absolute/path/to/Jarvis.Api \
PHASE9B_DEVICE_NODE_PATH=/absolute/path/to/Jarvis.DeviceNode \
PHASE9B_DESKTOP_APP_PATH=/absolute/path/to/Jarvis.app \
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
returns a safe run id and private paths, including the nonce fixture path; it
never returns the nonce or a bearer. `start` starts only owned processes and
arms the durable admission ledger plus the SQLite budget observer. `observe`
reads authenticated health, device, conversation, and database facts. The
`stop` and `restart` commands accept only `api`, `deviceNode`, or `desktop`;
Desktop restart omits the bootstrap bearer and uses its existing encrypted
store. Required normal Desktop close actions still use the product UI.
`finish` is idempotent and stops
owned process groups before removing the owner-marked runtime root. SIGINT,
SIGTERM, and the hard runtime timeout use the same cleanup path.

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

## Configuration and isolation

The credential loader reads `UserSecretsId` from
`src/backend/Jarvis.Api/Jarvis.Api.csproj`, then reads the BOM-safe Secret
Manager file at `~/.microsoft/usersecrets/<id>/secrets.json`. It selects only
the approved Azure OpenAI Realtime and DeepSeek Responses fields. ASP.NET
double-underscore environment overrides are accepted for those provider
fields. Unrelated database, local bearer, profile, and daily credentials are
not copied, and `OPENAI_API_KEY` is not required.

Provider policy accepts HTTPS Azure OpenAI endpoints on the official supported
domains and `https://api.deepseek.com/` for DeepSeek. Authentication mode and
model ids are explicit; an invalid endpoint or missing model blocks the run
without substitution or fallback.

Every run gets a fresh owner-marked temporary root, loopback port, local API
bearer, safety salt, SQLite path, Desktop profile, allowed root, and Codex
home. Secret-bearing values are retained in trusted process memory or private
0600 JSON beneath a 0700 run root. The external Codex login home may be
atomically adopted after owner and pinned-helper validation; the normal global
Codex home is never copied. Version probing also uses a disposable isolated
`CODEX_HOME` so `codex --version` cannot touch the daily profile.

To prepare a normal independent Codex login, create a new task-owned home in
the canonical OS temporary directory. The directory is created atomically by
`mkdtemp`; the owner marker is written to a 0600 temporary file, fsynced, and
atomically renamed to the exact marker name:

```sh
PHASE9B_NODE=/absolute/path/to/pinned/node
export PHASE9B_CODEX_HOME="$($PHASE9B_NODE --input-type=module <<'NODE'
import { chmod, mkdtemp, open, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = await realpath(tmpdir());
const home = await mkdtemp(join(base, "jarvis-phase9b-codex-login-"));
await chmod(home, 0o700);
const marker = join(home, ".phase9b-owned");
const temporary = join(home, `.${process.pid}.phase9b-owned.tmp`);
let handle;
try {
  handle = await open(temporary, "wx", 0o600);
  await handle.writeFile(
    '{"purpose":"isolated-normal-codex-login","dailyHomeCopied":false}\n',
    "utf8"
  );
  await handle.sync();
  await handle.close();
  handle = undefined;
  await chmod(temporary, 0o600);
  await rename(temporary, marker);
  process.stdout.write(home);
} catch (error) {
  await handle?.close().catch(() => {});
  await rm(temporary, { force: true }).catch(() => {});
  await rm(home, { recursive: true, force: true }).catch(() => {});
  throw error;
}
NODE
)"
```

Run the pinned Codex executable through the normal independent login flow with
that home, then pass the same path to the live CLI:

```sh
CODEX_HOME="$PHASE9B_CODEX_HOME" /absolute/path/to/pinned/codex login
PHASE9B_CODEX_PATH=/absolute/path/to/pinned/codex \
PHASE9B_CODEX_HOME="$PHASE9B_CODEX_HOME" \
pnpm phase9b:live
```

Use only this fresh task-owned home. Do not point `CODEX_HOME` at the daily
home, copy or link `~/.codex`, or copy `auth.json`; the harness rejects an
unmarked source and never adopts a normal profile implicitly. The marker must
remain a regular file owned by the current user with mode 0600 and exactly
`{"purpose":"isolated-normal-codex-login","dailyHomeCopied":false}` as its
JSON fields.

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
