# Jarvis Mobile

Jarvis Mobile is a React Native 0.87 client for iOS and Android. It shares the
Control Plane Conversation, task, notification, approval and SignalR contracts
with Desktop, but owns its native WebRTC and call-audio lifecycle.

## Local setup

The repository pins Node `24.19.0` and pnpm `10.24.0`.

```sh
pnpm install --frozen-lockfile
pnpm --filter @jarvis/mobile typecheck
pnpm --filter @jarvis/mobile test
pnpm --filter @jarvis/mobile bundle:android
pnpm --filter @jarvis/mobile bundle:ios
```

An Android Studio/JDK/Android SDK installation is required for
`pnpm --filter @jarvis/mobile android`. Xcode and CocoaPods are required for
`pnpm --filter @jarvis/mobile ios`. The Metro commands only validate the
JavaScript bundle and do not replace those native build or device checks.

## Pairing and endpoint configuration

1. In the Desktop app, open **Mobile 配对** and select **生成手机配对码**.
2. Enter the one-time code in Mobile before it expires.
3. On first launch, enter the Control Plane base URL and save it. A physical
   phone must use a reachable HTTPS hostname or address; the phone's own
   `127.0.0.1` is not the Desktop host. Loopback HTTP is accepted only for
   simulator/emulator development.
4. Mobile exchanges the code anonymously, stores only its rotated refresh
   credential in `react-native-keychain`, and keeps the access token in memory.
   The endpoint URL is persisted separately in the same encrypted credential
   boundary.

The pairing code is single-use and short-lived. The Desktop bearer creates it;
the mobile bearer cannot create another pairing. The device list only returns
safe device projections. Select a Desktop device in Mobile when submitting a
`localFiles` task; Realtime client-secret bootstrap always uses the paired
Mobile device identity and does not require a Desktop device to be online.

## Voice, text and recovery

Mobile sends the ephemeral Realtime client secret directly to
`https://api.openai.com/v1/realtime/calls` through the app-owned
`ReactNativeWebRTCTransport`. It never ships a standard OpenAI key, stores raw
audio, or proxies audio through C#. The native adapter requests microphone
permission, starts/stops the cross-platform `react-native-incall-manager`
call-audio session and applies speaker/system policy through its native API.
The UI shows that requested policy separately from the observed route. Only
native headset/noisy events or the wired-headset query update observed state;
when the platform does not expose a reliable route (including Bluetooth or the
iOS auto-route limitation), the UI intentionally shows `unknown` rather than
claiming the policy was applied. AppState transitions close the microphone,
Realtime transport and SignalR connection when leaving the foreground.

Typed messages and voice events use the same persisted `conversationId`. A
typed message is accepted by the backend before the active voice response is
interrupted and a text-only response is requested. Realtime connected/ended
markers and normalized text/transcript events are persisted; audio is not.

SignalR is a foreground hint only. On initial foreground and reconnect, Mobile
pulls unread notifications, all non-terminal tasks and pending approvals over
HTTP. Event IDs and entity versions are deduplicated. The task, notification
and approval sections expose cancellation, read/dismiss, approve-once and deny
actions explicitly.

## Safety gates

```sh
pnpm check:mobile-native-config -- --require-bundles
pnpm check:secrets
pnpm test:secret-scan
```

The mobile gate checks pinned dependencies, React Native package conditions,
native microphone/network permissions, HTTPS/cleartext policy, the custom
transport boundary, source/bundle key patterns, and forbidden browser
transport/global registration or Node built-ins. The SDK's shared export may
contain an unused browser transport symbol in the vendor bundle; the gate
rejects invocation/global registration, while Mobile always injects its own
transport.

Native Gradle/Xcode builds, physical-device audio routing, and a real OpenAI
account remain live gates when the required toolchains and devices are
available. `react-native-incall-manager` has a known iOS audio-session
singleton interaction with `react-native-webrtc`; iOS route selection is
limited to its auto policy until that native integration is validated. Metro
bundles and fake native-boundary tests are not substitutes for those checks.
