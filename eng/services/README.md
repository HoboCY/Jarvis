# macOS launchd services

## Local API configuration

`Jarvis.Api` uses the ASP.NET Core Secret Manager for local development. Store
only secrets and developer-specific values there; non-secret defaults live in
`src/backend/Jarvis.Api/appsettings.json`.

```sh
dotnet user-secrets set --project src/backend/Jarvis.Api "Authentication:BearerToken" "<random-token-at-least-32-characters>"
dotnet user-secrets set --project src/backend/Jarvis.Api "OpenAI:ApiKey" "<openai-or-azure-openai-api-key>"
dotnet user-secrets set --project src/backend/Jarvis.Api "OpenAI:RealtimeModel" "<enabled-realtime-model>"
dotnet user-secrets set --project src/backend/Jarvis.Api "OpenAI:SafetyIdentifierSalt" "<random-local-salt>"
dotnet user-secrets set --project src/backend/Jarvis.Api "DeepSeek:ApiKey" "<deepseek-api-key>"

DOTNET_ENVIRONMENT=Development dotnet run --project src/backend/Jarvis.Api --urls http://127.0.0.1:5004
```

Secret Manager loads `secrets.json` only when the API runs in the Development
environment. Environment variables and command-line arguments remain supported
and take precedence. The Desktop and Renderer do not read the API secret store.

For the first packaged Desktop launch, provide the same bearer once:

```sh
JARVIS_LOCAL_BEARER="<same-bearer-as-Authentication:BearerToken>" \
  src/clients/desktop/out/Jarvis-darwin-arm64/Jarvis.app/Contents/MacOS/Jarvis
```

Jarvis validates the value, uses Electron `safeStorage` to encrypt it with
macOS Keychain-backed protection, and writes only the ciphertext to the current
user's Jarvis data directory with owner-only permissions. Quit an already
running Jarvis instance before this one-time launch. Later launches can be made
normally from Finder without `JARVIS_LOCAL_BEARER`. Supplying the environment
variable again always overrides and replaces the stored value, which is also
the rotation procedure after changing `Authentication:BearerToken` in User
Secrets. An invalid environment override fails closed instead of falling back
to an older stored token.

Production `appsettings.Production.json` and the launchd service configuration
continue to work unchanged.

Desktop Realtime uses the bundled sherpa-onnx WenetSpeech model for local
Chinese wake-word detection. It requires no account, network request, API key,
or User Secret. The required `WakeWord:Enabled=true` and
`WakeWord:Keyword=贾维斯` settings live in
`src/backend/Jarvis.Api/appsettings.json`; a Mobile bootstrap response does not
include the Desktop wake-word configuration.

After a Desktop Realtime connection is established, its outgoing WebRTC track
starts disabled. While the UI says `等待唤醒词 贾维斯`, microphone audio is
processed only locally by sherpa-onnx and is not sent to OpenAI. Saying
`贾维斯` enables one voice turn; after the assistant's response completes the
track is disabled again. Typed input remains available in standby. Disconnect,
failed connection, and rotation cleanup stop only the application-owned
microphone tracks.

The API and Device Node are independent launchd services. Their templates hold
only bounded paths, the loopback API port, and non-secret environment values;
bearers never appear in a plist, launchd argument, or log. API configuration is
written by `writeApiConfiguration` as an owner-only (`0600`) production JSON
file. It contains the required local bearer/OpenAI Realtime validation values,
the selected `Responses` provider settings, and a database path outside the
repository. When `Responses:Provider` is `DeepSeek`, the writer also requires
and stores the owner-only `DeepSeek:ApiKey` and `DeepSeek:BaseUrl` values; its
default daily and summary model is `deepseek-v4-flash` (OpenAI defaults remain
`gpt-4.1-mini`).

Device pairing is one-time: register with the local bearer, then persist the
returned `{deviceId, deviceCredential}` identity in the selected secure store.
Production macOS configuration leaves `DeviceNode:CredentialFilePath` unset and
uses `MacOsKeychainDeviceNodeIdentityStore`; its synchronous Security.framework
calls disable user interaction, so an operation that would require UI fails
closed with `errSecInteractionNotAllowed`, and grant the Keychain item only to
the current dedicated Device Node apphost, never to the generic
`/usr/bin/security` CLI or shared `dotnet` host. The isolated launchd smoke uses
the explicit `OwnerOnlyFileDeviceNodeIdentityStore` seam instead: its identity
file and runtime JSON are `0600` under a unique temporary root. This avoids
interactive Keychain ACL consent on unsigned CI binaries. The file seam is
owner-only protection, not equivalent to a hardware-backed or Keychain-backed
secret, and must not be used as a production credential store.

Every Device Node also requires an independent `DeviceNode:CodexHome`. The
runtime configuration writer creates it with mode `0700`; it must not be the
user's `~/.codex`, and no existing user Codex files are copied into it. Before
a production service is started, log in to the isolated home explicitly with
`CODEX_HOME=<path> codex login`, where `<path>` is the configured
`DeviceNode:CodexHome`.

Use `eng/scripts/publish-macos-arm64.sh` to create self-contained darwin-arm64
API and Device Node `tar.gz` bundles (the service manifest hashes these
bundles, including their apphost, .NET runtime, DLLs, runtime configuration,
and native SQLite library; the target host does not need a separate .NET
runtime) and
`eng/scripts/package-desktop-macos.sh` for the unsigned Electron Forge arm64
package. `eng/scripts/launchd-smoke-macos.sh`
creates unique labels and a unique temporary root, starts API health/readiness,
unpacks those bundles into its isolated runtime directories, pairs a temporary
Device Node, verifies a persisted heartbeat, restarts the API against the same
SQLite database, restarts only that Device Node label, verifies a new launchd
process and later heartbeat, then boots out both labels and removes its exact
temporary files. Run it on macOS; non-macOS hosts must use the installer tests
(the smoke script exits as skipped there).

For manual operations, call `eng/scripts/install-launchd-service.mjs` with an
explicit unique `--root`, `--label`, executable, and working directory. The
label must be `com.hobocy.jarvis.*`; uninstall boots out only that label and
removes only its plist. Never point these commands at `/` or an existing
production label.
