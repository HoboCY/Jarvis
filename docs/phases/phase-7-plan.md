# Phase 7 计划：React Native Mobile、原生 Realtime 与安全设备配对

## 目标

在 Phase 6 已完成的 Control Plane、Conversation、Realtime、Task、Device Node、Approval、Notification 与 SignalR 基座上，交付一个 React Native + TypeScript 移动客户端。手机端与 Desktop 共享后端事实和逻辑 Conversation，但拥有独立的 Native WebRTC transport、麦克风/音频路由和前后台生命周期；音频仍由手机直接连接 OpenAI，不经过 C# 后端。

## 已确认环境与版本边界

- 采用当前稳定 React Native `0.87.0`、React `19.2.x`、`react-native-webrtc` `124.0.8` 与 OpenAI Agents SDK `@openai/agents-realtime` `0.17.0`，版本全部锁定。
- 使用 React Native Community CLI 的原生 iOS/Android 工程，不使用浏览器 `OpenAIRealtimeWebRTC`，也不以 Expo Go 作为运行环境。
- OpenAI 官方 React Native 示例要求应用自有 `RealtimeTransportLayer`、原生 WebRTC 和服务端签发的 ephemeral client secret；标准 OpenAI API Key 不进入移动应用。
- 当前开发机有 Node `25.0.0`、pnpm `10.24.0`，但仓库/CI 仍锁定 Node `24.19.0`。本机没有完整 Xcode、CocoaPods、JDK 或 Android SDK，因此可以完成 TypeScript、Metro bundle、原生配置静态门禁和 adapter 测试，但物理设备音频、iOS native build、Android native build 需在工具链可用后单独执行，不能用 fake seam 冒充。

## 本阶段范围

- 新增 `src/clients/mobile` React Native 应用、iOS/Android 原生工程、Metro/TypeScript/Jest 配置和 workspace/CI 脚本。
- 将共享 Realtime Agent 直接建立在具有 `react-native` package conditions 的 `@openai/agents-realtime` 上；Desktop 和 Mobile 继续共享 agent、工具、typed text-only、事件规范化与错误映射，transport 独立。
- 实现应用自有 `ReactNativeWebRTCTransport`：通过 `react-native-webrtc` 创建 PeerConnection、DataChannel、麦克风 track 和远端音频，使用 ephemeral secret 向 `/v1/realtime/calls` 提交 SDP；连接、发送、打断、mute、关闭和失败清理都可观察且幂等。
- 实现移动音频 adapter：请求麦克风权限，启动/停止通话音频会话，显示并响应耳机路由变化，允许用户选择系统自动路由或强制扬声器；原生 OS 仍拥有最终路由决定。
- 实现 `AppState` 生命周期：仅在前台连接 Realtime/SignalR；转入非活动/后台时关闭麦克风、Realtime 和 SignalR，不声明后台推送或后台常驻音频。
- 实现安全移动配对和会话：Desktop 本机已认证用户创建一次性配对码；Mobile 交换配对码后创建 `Mobile` Device，取得短期 access token 与一次性返回的 refresh token；access token 只驻内存，refresh token 只通过 `react-native-keychain` 存入 iOS Keychain/Android Keystore；刷新时旋转 refresh token，注销时撤销会话。
- 为 UI bearer 增加 mobile access-token 认证分支，同时保留现有 LocalBearer；配对创建仅允许 LocalBearer，普通 Conversation/Realtime/Task/Notification/Approval/ClientHub 接受同一用户的 LocalBearer 或 MobileBearer。
- 新增安全设备列表 API，只返回当前用户设备的安全投影，不返回 credential、allowed roots 或 token；Mobile 可选择在线/已配对 Desktop Device 作为 `preferredDeviceId`。
- 放宽现有 Realtime bootstrap 的设备类型校验，使同一 API 接受当前用户未禁用的 `Desktop` 或 `Mobile` Device；仍拒绝跨用户、Server、禁用或不存在设备。
- 实现 Mobile Conversation：创建/读取逻辑 Conversation、加载消息、使用同一 `conversationId` 启动语音和提交 typed message。文字发送先持久化，成功后打断活动音频并请求 text-only 响应。
- 实现任务中心：列出非终态任务、创建/取消后台任务、选择 Desktop Device 委派 Codex 工作、显示进度/结果；Realtime tools 仍只调用认证 C# API。
- 实现通知与审批中心：前台连接 `ClientHub`，按 `NotificationId`/event id 去重；连接或重连后权威拉取未读通知、非终态任务和待审批，允许显式批准一次或拒绝并回执 delivered/read/dismiss。
- 更新 OpenAPI、生成 TypeScript contract/API client、EF migration、secret scan、CI、移动运行说明和 `docs/phases/phase-7-report.md`。

## 明确不在本阶段

- APNs、FCM、系统通知、后台 push、后台持续 SignalR、后台录音或唤醒词。
- 原始音频持久化、音频经 Control Plane 代理、前端直接调用 Codex/本地文件/命令。
- 多租户注册、用户名/密码、第三方 OAuth、公共互联网控制面部署、证书签发或应用商店发布。
- 将 simulator、fake WebRTC、Metro bundle 或受控 provider 结果描述为物理设备双向音频和真实 OpenAI 账号证明。

## 公共 seam 与不变量

### Backend HTTP / SignalR

- `POST /api/v1/mobile-pairings`：仅 LocalBearer；创建短期、单次、高熵配对码，数据库只保存哈希。
- `POST /api/v1/mobile-pairings/exchange`：匿名但限流；原子消费配对码、创建 Mobile Device/MobileSession，并一次性返回短期 access token 和 refresh token。
- `POST /api/v1/mobile-sessions/refresh`：匿名但限流；验证并旋转 refresh token；旧 token 立即失效，数据库只保存哈希。
- `POST /api/v1/mobile-sessions/revoke`：MobileBearer；撤销当前 session，后续 access/refresh 都失败。
- `GET /api/v1/devices`：UI 身份；返回安全设备投影，支持 `deviceType` 过滤。
- 已有 Conversation、Messages、Realtime client-secret/session/event-ingest、Tasks、Notifications、Approvals 使用同一用户所有权规则；Mobile 不获得额外权限。
- `/hubs/client` 接受 Mobile access token，SignalR 只提供低延迟提示；HTTP/SQLite 仍是恢复和事实边界。

### TypeScript / React Native

- `MobileCredentialStore`：生产实现仅使用 Keychain/Keystore；测试使用明确 fake，不提供 AsyncStorage 或明文文件 fallback。
- `MobileApiSession`：access token 只在内存；遇到 `401` 最多执行一次串行 refresh 和一次原请求重放，未知写入结果不自动生成新幂等键。
- `ReactNativeWebRTCTransport`：实现 Agents SDK `RealtimeTransportLayer`，原生 WebRTC 对象不注册为浏览器 globals；关闭后停止全部 track、关闭 channel/peer 并移除监听。
- `MobileAudioRoute`：权限、call audio session、speaker/headset 状态与选择封装在窄 adapter；React 组件不直接依赖原生模块。
- `MobileLifecycleController`：前台进入时 refresh auth + HTTP recovery + SignalR；后台进入时 disconnect/stop audio；重复 AppState 事件不得重复建立 session。
- `MobileConversationController`：同一 `conversationId` 同时绑定 voice 与 typed；后端消息写入是 typed 接受边界。
- `MobileTaskNotificationFeed`：按实体 ID 和版本/事件水位去重，重连权威补拉未读通知、每种非终态任务和 pending approvals。
- Mobile bundle 不包含 LocalBearer、Device credential、refresh token、ephemeral secret 常量、标准 OpenAI API Key 或 `sk-` 形态。

## TDD 垂直切片

1. **移动认证领域与数据库**：先写 pairing 过期/单次消费、哈希存储、access 过期、refresh 旋转/重放/撤销的领域和真实 SQLite 测试，再实现实体、store 与 EF migration。
2. **认证协议与安全投影**：先以 TestServer 证明 Local/Mobile 认证分离、限流、跨用户拒绝、ClientHub Mobile 握手和设备列表不泄密，再实现 endpoints/handler/OpenAPI。
3. **Mobile 设备 Realtime 与委派**：先证明 Mobile Device 能使用同一 Conversation client-secret API、Server/disabled/cross-user 仍拒绝，并能将 Task 的 preferredDeviceId 指向 Desktop Device，再放宽 store 和补齐 client functions。
4. **安全凭据与 API session**：先以 fake Keychain/HTTP seam 证明 access 只驻内存、refresh 单飞旋转、401 一次恢复、撤销/损坏 fail closed，再实现 `react-native-keychain` adapter。
5. **Native WebRTC/音频/lifecycle**：先以注入式 native boundary 证明 SDP、data channel、mute/interrupt、track 清理、权限拒绝、speaker/headset 路由和 background disconnect，再实现生产 adapter 与原生权限配置。
6. **Conversation 与 typed/voice**：先证明同一 Conversation、typed 先持久化后 interrupt/text-only、Realtime transcript/event ingest 和断线仍可 typed，再实现 controller/UI。
7. **任务/通知/审批**：先证明 Desktop Device 选择、Codex 委派、SignalR 前台事件、NotificationId 去重、重连补拉和显式审批，再实现 task/notification screens。
8. **原生工程、合同与回归**：生成 OpenAPI/TS，运行全部 .NET/pnpm/EF/format/vulnerability/schema/secret/security 门禁；生成 Android/iOS Metro release bundle，并在有工具链的环境执行 Gradle/Xcode native build 与真机音频检查。

## 验收证据矩阵

- 真实 TestServer + 临时 SQLite：配对、token rotation/revoke、Mobile auth、Conversation/Realtime/Task/Notification/Approval 所有权、ClientHub 重连与数据恢复。
- 真实 Metro resolver/bundle：使用 `react-native` package condition，Mobile bundle 不引入 browser WebRTC 或 Node built-ins，Android/iOS JS bundle 均成功。
- 注入式 fake native boundary：WebRTC 信令/事件/清理、权限、音频路由、AppState；只证明应用逻辑和 adapter 合同。
- 原生 build：Gradle `assembleDebug` 与 `xcodebuild` simulator/device build；若当前机器缺工具链，报告明确列为未通过 gate，不能据 Metro 结果宣称完成。
- 物理设备 + 真实 OpenAI：iOS/Android 至少各验证一次麦克风输入、远端音频、耳机/扬声器切换、语音打断、typed text-only 和前后台恢复；需要真实凭据/设备时列为 live gate，不用 fake 替代。
- 安全：source/bundle/产物 secret scan、token/配对码哈希数据库断言、日志脱敏、无原始音频落盘。

## 风险与回滚

- React Native 0.87、Agents SDK 和原生 WebRTC 变化快；依赖精确锁定，package condition/Metro bundle 和 transport contract 纳入 CI。
- 原生音频路由由 OS、设备和蓝牙状态最终决定；UI 必须展示实际/期望状态并处理无法切换，不能把 API 调用成功等同于硬件已切换。
- 配对端点增加匿名攻击面；使用高熵短期单次码、固定时间哈希比较/索引、限流、失败不泄露存在性和服务器端撤销。
- 回滚时可单独移除 Mobile workspace 和 Mobile auth endpoints/migration；现有 LocalBearer、Desktop、Device Node、Conversation/Task/Notification schema 与行为保持兼容。
