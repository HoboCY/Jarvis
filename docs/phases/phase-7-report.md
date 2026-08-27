# Phase 7 实施报告

## 结果

Phase 7 的后端配对/移动会话、Mobile React Native workspace、原生 WebRTC
边界、音频与 AppState 生命周期、Conversation 同步、任务/通知/审批中心、
Desktop 配对入口、OpenAPI/EF/secret/CI 门禁已实现。所有 access token 只在
Mobile 进程内存中保存；refresh token 只经 `react-native-keychain` 保存；后端
只持久化 pairing/refresh 哈希。以下验证均在提交前工作树完成。

## 关键设计

- `MobileBearer` 与 `LocalBearer` 分离；pairing create 仅本机 bearer，exchange
  匿名且限流，refresh 单飞、轮换、重放失败。只有 revoke 成功持久化并返回 200
  后，access/refresh 才均失效；SQLite 锁冲突在有界重试耗尽时返回 503，保留凭据
  以便重试，不伪称已撤销。
- `GET /api/v1/devices` 只返回安全投影。Realtime client-secret 的
  `deviceId` 是配对响应中的 Mobile Device；Desktop Device 只用于
  `localFiles` task 的 `preferredDeviceId`。
- `ReactNativeWebRTCTransport` 直接通过 `/v1/realtime/calls` 完成 SDP，未使用
  browser `OpenAIRealtimeWebRTC` 或 `registerGlobals()`；音频 track、data
  channel、peer 与失败清理都幂等；连接只有收到 `session.updated` ACK 后才
  报告 connected，并对 ACK 等待设置 5 秒上限。
- 音频使用锁定的 `react-native-incall-manager` `4.2.1` 跨平台通话 API；
  requested policy（system/speaker）与 native event/query 得到的 observed route
  分开，无法可靠观测时 UI 显示 unknown，不把策略调用成功伪报为硬件路由。
- `VoiceSessionCoordinator` 以 AppState foreground epoch 约束权限、通话音频、
  WebRTC 和 bridge 的每个异步 checkpoint；迟到的 native 资源会被 adopt/清理。
- Mobile typed/voice 共用一个 conversation，先持久化 typed 再 interrupt/text-only；
  connected/ended 和 normalized text/transcript ingest 进入持久 Conversation。
- SignalR 仅作前台低延迟提示，重连通过 HTTP 补拉未读通知、非终态 task 和
  pending approval，并按 event/entity version 去重。
- Control Plane URL 可在 Mobile 配置并通过 Keychain 持久化；物理手机不默认访问
  自己的 `127.0.0.1`。Desktop 有实际 IPC + renderer 配对码入口。
- workspace lockfile 通过显式 override 固定已修复的 `@babel/core 7.29.7`、
  `esbuild 0.25.0`、`tar 7.5.22`、`tmp 0.2.7`。Metro 当前仍传递引入
  `image-size`、Electron Forge 当前仍传递引入 `extract-zip`；官方 advisory
  对这两者均没有可用修复，三条对应 CVE 在 `auditConfig.ignoreCves` 中逐条记录，
  不使用无条件忽略未来漏洞的配置。

## 改动范围

- Backend：Mobile domain/application store、EF entities/migration、MobileBearer、
  pairing/session endpoints、safe device list、Realtime Mobile ownership、
  rate limits、OpenAPI。
- TypeScript：`@openai/agents-realtime` shared agent；API/contract exports；
  `src/clients/mobile` RN 0.87 Android/iOS workspace、Metro/Babel、Keychain、
  WebRTC/audio/lifecycle/feed/conversation adapters 和 UI；Desktop pairing IPC/UI。
- Verification/operations：mobile native static gate、CI Metro release bundle steps、
  mobile runbook、domain/API integration tests、secret/OpenAPI/EF checks。

## RED/GREEN 证据

- 首个 RED：
  `dotnet test tests/backend/Jarvis.Api.IntegrationTests/Jarvis.Api.IntegrationTests.csproj --no-restore --filter FullyQualifiedName~Phase7MobilePairingTests.Local_user_can_create_a_single_use_mobile_pairing_code`
  在未实现 endpoint 时返回 `404 NotFound`（预期 `201 Created`）。
- 首个 pairing GREEN：同一测试实现后通过；后续
  `dotnet test ... --no-build --filter FullyQualifiedName~Phase7MobilePairingTests`
  通过 9/9，其中包含真实 SQLite 下 pairing exchange、refresh rotation 和
  revoke/refresh 并发无 500 的断言。
- Mobile request-builder RED：新增 seam 测试在文件不存在时 `MODULE_NOT_FOUND`；
  实现后通过。该切片同时覆盖 Mobile-only voice bootstrap 与
  local-files Desktop prerequisite。
- Metro RED/GREEN：初次 bundle 因 CommonJS/Metro config、workspace Babel helper
  和 Agents SDK namespace/static-class syntax 先后失败；修正 config/resolver/plugins
  后 Android 与 iOS release Metro bundle 均成功。
- OpenAPI drift RED/GREEN：在 endpoint schema 更新后首次检查检测到旧生成文件并
  以 changed-file 失败；保留生成结果后再次运行，OpenAPI 与 TypeScript 文件
  byte-for-byte 检查通过。
- Follow-up WebRTC RED/GREEN：先证明 transport 在 `session.updated` ACK 前仍为
  connecting，并分别以 delayed `getUserMedia`、SDP、data-channel-open 和
  already-closed channel 测试 close race；实现 ACK listener-before-update、5 秒
  bounded wait 与统一 cleanup 后，相关 transport 测试通过 10/10。
- Follow-up audio/lifecycle RED/GREEN：音频 boundary、foreground coordinator、
  logout coordinator 和分页 seam 初始分别以缺失模块/单页实现失败；实现 native
  manager boundary、epoch cancellation、revoke-first teardown 与 cursor loop 后，
  相关新增 seam 测试均通过。
- Follow-up SQLite RED/GREEN：重复运行 revoke/refresh race 时曾观察到
  after-revoke refresh 返回 `OK`（revoke 在乐观并发冲突后未重新落库）；为 revoke
  增加最多 3 次、5/10ms 有界重试并重新读取后，Phase 7 pairing 测试通过 9/9，
  该 race 独立重复 10/10 通过。新增真实外部 SQLite 写锁测试先在首个实现中于
  `BeginTransaction` 等待超过 30 秒并被中止（RED）；为 SQLite connection
  internal command 配置 1 秒超时后，锁持有 revoke 在 3 次有界尝试后返回 503，
  释放锁后保留 refresh 可继续 refresh，重试 revoke 返回 200，锁测试 GREEN 1/1。
- Follow-up mobile logout RED/GREEN：临时 503/网络失败原先会清理错误的本地凭据
  或无法重试；新增 terminal 401/404、retryable 503、network failure 与 retry
  seam 测试，实现 revoke-first teardown、保留 Keychain refresh、清理 voice/
  SignalR/feed 后，session/logout/voice 聚焦测试通过 16/16，移动端总测试通过 49/49。

## 验证命令与结果

已在当前工作树实际运行（Node 25.0.0 / pnpm 10.24.0；项目要求 Node 24.19.0，
因此 pnpm 输出 engine warning，但所有命令均以预期退出码完成）：

```text
dotnet restore Jarvis.sln --locked-mode -> passed
dotnet build Jarvis.sln --no-restore --configuration Release -> passed, 0 warnings, 0 errors
dotnet test Jarvis.sln --no-restore --configuration Release --logger 'console;verbosity=minimal' -> passed, 217/217
dotnet test ... --filter FullyQualifiedName~Phase7MobilePairingTests -> passed, 9/9
dotnet test ... --filter FullyQualifiedName~Phase7MobilePairingTests.RevokeAndRefreshRaceNeverAllowsRefreshAfterRevocation -> passed, 10/10 repeated runs
pnpm install --frozen-lockfile -> passed
pnpm typecheck -> passed (contracts, realtime-agent, api-client, Desktop, Mobile)
pnpm lint -> passed
pnpm test -> passed, 130 individual tests (contracts 4, realtime-agent 12,
  api-client 3, Mobile 49, Desktop 57 TS tests + 5 build/package tests)
pnpm build -> passed (all 5 TS workspaces)
pnpm --filter @jarvis/mobile bundle:android -> passed
pnpm --filter @jarvis/mobile bundle:ios -> passed
pnpm check:mobile-native-config -- --require-bundles -> passed with Android/iOS bundles
pnpm --filter @jarvis/mobile exec react-native config -> passed; native module config
  listed `react-native-incall-manager` iOS Podspec and Android package/sourceDir
pnpm check:openapi -> passed, generated files unchanged byte-for-byte
pnpm check:codex-schema -> passed, 275 files and all declared unions
pnpm check:codex-schema-canonical -> passed, 275 files
pnpm test:codex-schema-canonical -> passed, 2/2
pnpm check:secrets -> passed
pnpm test:secret-scan -> passed, 1/1
pnpm test:service-manifest -> passed, 14/14
pnpm check:package-audit -> passed, 3 high advisories explicitly ignored as unfixable
dotnet ef migrations has-pending-model-changes --project src/backend/Jarvis.Infrastructure/Jarvis.Infrastructure.csproj --startup-project src/backend/Jarvis.Api/Jarvis.Api.csproj --context Jarvis.Infrastructure.Data.JarvisDbContext -> passed, no pending model changes
dotnet format Jarvis.sln --verify-no-changes -> passed
git diff --check -> passed
```

其中 package audit 使用官方 npm registry；仓库用户级 registry 是 npmmirror，
其 audit endpoint 不存在。`package.json` 的 `check:package-audit` 固定官方 registry，
CI 已加入该 gate，以及 mobile typecheck/test、Android/iOS Metro bundle 和
`check:mobile-native-config -- --require-bundles`。

## 未验证 live gates

当前开发机没有完整 Xcode、CocoaPods、JDK 或 Android SDK，因此没有假装通过
`Gradle assembleDebug`、`xcodebuild` 或物理设备测试。真实 iOS/Android 麦克风、
扬声器/耳机切换、前后台恢复、真实 OpenAI Realtime 账号、证书和公共 HTTPS
部署仍需具备工具链、设备和凭据后执行。`react-native-incall-manager` 在 iOS
仍有与 react-native-webrtc `AVAudioSession` singleton 的已知集成限制，且本地
无法由 fake boundary 证明物理 route；fake native boundary、TestServer/SQLite
和 Metro bundle 只证明应用代码边界，不替代这些 live gates。

CI 已新增仅在 `main` push 运行的 Android JDK 17/SDK 37 `assembleDebug` 和
macOS 15/CocoaPods iOS Simulator `xcodebuild` 门禁。工作流定义本身不是通过证据；
只有 GitHub Actions 对相应提交的真实成功 run 才能关闭两个 native build gate，
且仍不能替代 iOS/Android 物理设备和真实 OpenAI 音频验收。
