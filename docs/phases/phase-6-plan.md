# Phase 6 计划：可靠性、安全、桌面发布与运维验收

## 目标

在 Phase 5 已具备的持久化 Conversation、Task、TaskExecution、Approval、Notification、Outbox、Realtime、Responses Worker 和 Device Node 基座上，完成单机生产形态的运行保障：所有外部 HTTP 依赖使用有边界且可观测的 retry/timeout/circuit breaker；Backend 与 Device Node 输出安全结构化日志并可导出 OpenTelemetry；Desktop 具备 tray、独立通知 overlay、受认证诊断视图和可安装发布包；Backend/Device Node 可作为独立于窗口生命周期的 macOS `launchd` 服务运行；八个规范 E2E 场景、重启恢复和性能预算都有可重复的自动化证据。

Jarvis SQLite 数据库仍是 Conversation、Task、Approval、Notification 与 Outbox 的事实来源。SignalR、tray/overlay、诊断页、OpenTelemetry 后端、Electron 窗口和进程内 circuit 状态都不是事实来源；任何重启或断线恢复必须重新读取持久化事实。

## 本阶段范围

- 为 OpenAI Realtime HTTP、Device Node 注册/心跳/领取/事件客户端和其他明确的外部 HTTP 读取链路增加集中配置的 timeout、指数退避+jitter retry 与 circuit breaker。一个 client 只安装一个 resilience handler；默认不重试 `POST`、`PUT`、`PATCH`、`DELETE` 等不安全方法，只有已经具备稳定 Idempotency-Key 且服务端已证明幂等的 Jarvis 内部写请求才可显式允许重试。
- 保留 Responses Runtime 已有的 provider 状态机和稳定 idempotency seam，在 adapter 外增加可观测 circuit 状态而不重复叠加 retry；未知是否已被 provider 接受的写请求继续 fail closed，不自动重放副作用。
- 在 Backend 与 Device Node 注册统一的 `ActivitySource`、`Meter`、ASP.NET Core/HttpClient/runtime instrumentation 和可选 OTLP exporter；OTLP 未配置时应用仍可启动。Activity/日志携带受控 correlation ID，指标禁止把 UserId、ConversationId、TaskId 等高基数标识作为 label。
- 增加规范要求的 realtime、task/lease/approval、Codex process/turn/protocol、notification/outbox 指标；状态诊断使用有限聚合，不暴露密钥、token、对话正文、完整 transcript、命令正文或原始绝对路径。
- Backend 与 Device Node 使用结构化 JSON console 日志。新增统一敏感值/路径/命令脱敏边界；用户内容日志默认关闭且可配置，普通生产日志不得记录标准 API Key、ephemeral secret、Refresh Token、完整 transcript 或 Memory value。
- 新增 liveness/readiness 和 `GET /api/v1/diagnostics`。诊断端点只接受 loopback 请求并要求 Local bearer，返回版本、进程/运行时间、数据库可用性、任务/审批/通知/outbox 安全聚合、已知 worker 与 circuit 健康状态；响应中无 secret、bearer、设备凭据、对话正文、命令或路径。
- Desktop Main/Preload/Renderer 增加受白名单约束的诊断读取和“运行诊断”视图。Renderer 仍不持有 bearer，所有请求由 Electron Main 代理；诊断页只显示后端返回的安全 DTO。
- Desktop 增加 macOS tray 生命周期：关闭主窗口时隐藏而非终止后台能力，tray 可显示/隐藏主窗口和退出；second-instance/activate 可恢复窗口。增加独立 always-on-top 通知 overlay BrowserWindow，使用与主窗口相同的安全 webPreferences、导航阻断和 IPC 白名单；overlay 只接收长度受限的安全通知投影，不承载 bearer 或任意 HTML。
- 使用 Electron Forge 生成 macOS arm64 release test artifact；发布脚本同时构建 Desktop、生成版本清单与 SHA-256。无 Apple 签名凭据时只产生明确标记的 unsigned 本机测试包，不冒充已签名/公证的生产包。
- 为 Backend 与 Device Node 增加可重复的 `darwin-arm64` publish 流程、版本清单和 `launchd` plist 模板；提供 install/uninstall/status/smoke 脚本。脚本使用显式绝对路径、独立数据/日志目录和最小环境，支持临时根目录 dry-run；实际验收可在当前用户 domain 安装一组唯一测试 label，启动、探活、停止并完全清理，不覆盖现有服务。
- 建立可执行的 `tests/e2e` 测试项目/入口，使用真实 ASP.NET Core TestServer、临时 SQLite、SignalR 客户端、受控 Fake OpenAI HTTP、Fake Responses runtime、Fake Codex JSONL 子进程和真实 outbox/lease worker，覆盖规范八个 E2E 场景；fake 边界不得冒充真实 OpenAI 或生产服务证明。
- 增加确定性性能 smoke：预热后测量文字消息、Task 创建、通知发布/补拉的样本延迟，并按规范预算验证文字提交 P95 不超过 300ms、TaskId 不超过 1s、通知发布/拉取不超过 2s。测试只评估本机控制面预算，不宣称公网 provider 延迟。
- 将 CI 拆分为所有 PR 都执行的既有门禁，以及 `main` 额外执行的 E2E smoke、Desktop test package build、版本清单和测试报告 artifact；Linux CI 不声称完成 macOS 安装验收，macOS 发布 smoke 使用独立 job。
- 更新 OpenAPI、生成 TypeScript contract、lock files、运行手册和 `docs/phases/phase-6-report.md`。

## 明确不在本阶段

- Phase 7 的 React Native、Native WebRTC、移动麦克风/音频路由、移动任务中心、移动通知与配对 UI。
- Apple Developer ID 签名、notarization、自动更新渠道、Windows Service/systemd 安装器、生产服务器上线和真实运维告警接入；本阶段只完成 macOS arm64 的可安装本机测试包与 `launchd` 方案。
- 真实 OpenAI 账户的负载/费用/配额压测，或用 fake provider 结果声称线上 provider 已验证。
- 把 OpenTelemetry collector、Prometheus、Grafana 或日志 SaaS 变成 Jarvis 事实来源；exporter 不可用不能破坏核心业务。
- 在浏览器 URL、renderer state、诊断 JSON、日志、版本清单或安装脚本参数中传播 Local bearer、Device credential、标准 API Key 或 ephemeral secret。

## 公共接口与不变量

- 公共测试 seam 为认证 HTTP API、真实 SQLite/TestServer、真实 SignalR client、公开 worker 单轮、Device Node HTTP client、Electron Main/Preload IPC、打包产物和服务进程；不通过测试私有 helper、具体 Polly 调用次数或 Electron 内部实现声称行为完成。
- Retry 只处理明确的瞬时异常、HTTP 408、429 和 5xx；认证/授权、校验、业务冲突和其他 4xx 不重试。带副作用的未知提交结果绝不因 circuit/retry 自动重复执行。
- Circuit breaker 打开后应快速失败，break duration 后只允许受控探测并可恢复；circuit 进程内状态可丢失，持久化恢复仍由 Task execution/lease/idempotency 决定。
- Correlation ID 接受合法、长度受限的 `X-Correlation-ID` 或由服务生成，并回写响应；它用于日志/trace 关联，不用于授权、幂等或数据库主键。
- 指标 label 只使用有限枚举/状态/worker kind/result；UserId、DeviceId、ConversationId、MessageId、TaskId、ExecutionId、ApprovalId、NotificationId、CodexThreadId 和 OpenAI ResponseId 只可进入受控 trace/log field，不能成为无界 metric dimension。
- `GET /api/v1/diagnostics` 同时满足 loopback 和 Local bearer 才返回。反向代理头不能把远端请求伪装成本机；测试环境通过显式受限 override 注入 loopback，不在生产放宽。
- Overlay 是瞬时显示层；通知 created/read/dismissed/delivered 状态只由数据库 API 决定。Overlay 或主窗口断开时通知仍落库，重连后按 NotificationId 补拉去重。
- Backend 和 Device Node 必须能在 Desktop 完全退出时继续作为独立服务运行；Desktop 只连接服务，不成为服务 supervisor 或事实来源。
- Release artifact 必须由 clean build 生成，可被复制/安装到隔离目录并成功启动到 `app.whenReady`；unsigned/notarized 状态必须进入版本清单和阶段报告。

## 实施切片与 TDD 顺序

1. **安全日志、关联与遥测骨架**：先写 correlation 生成/透传、敏感字段不落日志、有限 metric label 和无 OTLP 配置可启动测试，再实现 JSON logging、Activity/Meter、instrumentation 与 exporter 配置。
2. **HTTP 韧性与 circuit 状态**：先用受控 HTTP server 覆盖 GET 瞬时重试、4xx 不重试、幂等写显式重试、未知副作用不重放、circuit open/fail-fast/recover，再把一个集中配置 handler 接到 Realtime 和 Device Node clients；Responses adapter 只接 circuit/telemetry，不重复其现有 retry。
3. **诊断与健康边界**：先以 TestServer + SQLite 覆盖未认证、非 loopback、safe DTO、聚合数值、readiness 失败和不泄密，再实现 diagnostics query/endpoint、liveness/readiness、Desktop Main/Preload 代理与 renderer view。
4. **通知 tray/overlay**：先通过可观察的 Electron public factory/controller seam 覆盖安全 BrowserWindow 配置、close-hide、activate、tray menu、通知投影校验/去重和断线补拉，再实现 Main 生命周期、独立 overlay 页面与 renderer 展示。
5. **八个 E2E 和性能预算**：先建立场景 fixture，然后逐一实现文字输入、跨模态指代、文字打断语音、后台委派、通知断线补发、Codex 审批、Codex 崩溃恢复和 Session rotation；重启场景使用共享临时 SQLite 创建新 host/worker 实例，性能测试有预热、样本数和明确预算。
6. **服务发布与安装 smoke**：先对 publish manifest、plist 变量展开、安全权限、重复 install/uninstall 和错误配置 fail closed 写脚本测试，再实现 API/Device Node publish 与 `launchd` 模板。当前用户 domain 使用唯一测试 label 完成安装、启动、Backend health、Device Node heartbeat/恢复、停止和清理。
7. **Electron release test package**：先固定 Forge 配置和 artifact 元数据，再构建 macOS arm64 unsigned test package，复制/安装至隔离目录，启动并观察 readiness/单实例锁后退出；记录 artifact 路径、大小、SHA-256、签名/公证状态。
8. **CI、合同与回归**：生成 OpenAPI/TS，运行全部 .NET/pnpm/EF/format/vulnerability/schema/secret/security 门禁；main macOS job 运行 E2E、package/install/start smoke，产出 JUnit/TRX、版本清单与 artifact。最后形成 Phase 6 报告，逐项区分自动化证明、本机安装证明和仍需生产凭据的门禁。

## E2E 场景与验收证据

1. **文字输入**：创建 Conversation、连接 Realtime、发送 typed text、收到 text-only、User/Assistant Message 均持久化。
2. **跨模态指代**：语音 transcript 持久化后，同一 Conversation/Session 的文字请求能从 context bootstrap 看见前文。
3. **文字打断语音**：active response 被取消/截断，旧 Assistant Message 标为 Interrupted，新 typed request 得到 text-only 回复。
4. **后台委派**：`delegate_task` 在 1 秒内返回 TaskId，会话仍可用；worker 完成后 Notification/Outbox/SignalR/UI 投影一致。
5. **通知断线补发**：SignalR 断开期间任务完成，通知先持久化；重连补拉按 NotificationId 只显示一次且不丢失。
6. **Codex 审批**：Fake Codex JSONL 发出文件写入审批，Task 等待；用户只批准 once，决定返回相同 execution，任务继续并终态正确。
7. **Codex 崩溃恢复**：持久化 CodexThreadId/Execution 后进程退出；新 supervisor/worker resume 原 thread，不盲目重放未知副作用，恢复或明确失败并通知。
8. **Session rotation**：旧 session 到期/轮换时不丢 transcript、summary、task、notification 与 memory context；新 session bootstrap 的 ContextVersion 反映持久事实。

附加验收：Backend 使用同一 SQLite 在新 host 实例恢复非终态 task/outbox；Device Node 使用持久 identity 和已有 execution 重新注册/心跳/领取恢复；通知数据库与 UI 去重状态一致；所有 source/产物 secret scan 通过；macOS Desktop release test artifact 可安装到隔离目录并成功启动；`launchd` 测试服务能独立于 Desktop 启动、探活并清理。

## 运行、配置与回滚

- 新配置集中在 `Resilience`、`Observability`、`Logging` 与 `Diagnostics` 节；所有边界值启动校验。OTLP endpoint 可选，bearer/API Key/Device credential 仍是显式必需配置且不提供不安全 fallback。
- Resilience 出现回归时可按 client 关闭 retry/circuit，但保留 timeout 和已有 idempotency/fencing；不得通过放宽重复写规则恢复。
- 遥测 exporter 异常时关闭 exporter，保留本地 JSON 日志和业务执行；不得删除持久化业务记录作为回滚方式。
- 服务安装回滚使用阶段提供的显式 uninstall 脚本，先 bootout 唯一 label，再删除对应 plist/隔离 publish 目录；不递归删除用户目录或其他服务文件。
- Desktop artifact 回滚为安装上一版本的签名/测试包；数据库 schema 本阶段原则上不新增业务 migration，如诊断需要 schema 变化则必须单独记录前向/反向迁移步骤。
- 本机 Node `25.0.0` 与仓库锁定 `24.19.0` 不一致；前端/Forge 门禁最终以固定 Node `24.19.0` 的 CI 和 macOS release job 为准，并在报告中保留差异。

## 官方实现约束

- .NET 使用 `Microsoft.Extensions.Http.Resilience` 的单一标准/自定义 resilience handler，按 HTTP method 和幂等语义收窄 retry；不叠加多个 handler。
- OpenTelemetry 遵循 logs、metrics、distributed tracing 三类信号；exporter 可选且不能成为业务启动依赖。
- Electron 发布产物通过 Electron Forge 构建；macOS 本机 smoke 可以验证 unsigned test artifact，但只有配置 Developer ID、签名和 notarization 的独立发布门禁才可称生产发行包。
- Backend/Device Node 在 macOS 使用 `launchd` 的显式 plist/ProgramArguments/WorkingDirectory/StandardOutPath/StandardErrorPath，不依赖 Desktop 窗口生命周期或登录 shell 环境。
