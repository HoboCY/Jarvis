# Phase 3 实施报告：Task Orchestrator、Fake Worker 与持久化通知

## 结果

Phase 3 的本地代码范围已完成：Task/TaskEvent/Notification 领域状态机、SQLite/EF migration、认证任务与通知 API、确定性 Worker Router、具备续租与 fencing 的可恢复 Fake Delay Worker、事务 Outbox/SignalR 事件、Realtime SDK 薄工具代理、Desktop Main/Preload/Renderer 任务通知 feed，以及 OpenAPI/TypeScript 合同均已落地。

Fake Worker 只返回明确标记 `fake=true` 的确定性结果，不调用真实 Codex、Responses、文件、命令或网络执行器；真实 Codex/Responses 集成仍分别属于 Phase 4/5。

## 改动文件

- Domain：`src/backend/Jarvis.Domain/Tasks/{Task,TaskEvent}.cs`、`src/backend/Jarvis.Domain/Notifications/Notification.cs`。
- Application：`src/backend/Jarvis.Application/Tasks/{TaskPorts,TaskService,WorkerRouter}.cs`、`src/backend/Jarvis.Application/Notifications/{NotificationPorts,NotificationService}.cs`。
- Infrastructure：`src/backend/Jarvis.Infrastructure/{Tasks,Notifications}/`、`JarvisDbContext.cs`、`InfrastructureServiceCollectionExtensions.cs`；新增 migration `20260825225642_Phase3AttachmentRefs` 及 model snapshot。
- API/合同：`src/backend/Jarvis.Api/{Tasks,Notifications}/`、`Program.cs`、`src/backend/Jarvis.Contracts/ConversationContracts.cs`。
- Realtime/Desktop：`packages/realtime-agent/src/{index,realtime-agent.test}.ts`、`packages/api-client-ts/src/index.ts`、`packages/contracts-ts/src/{outbox,index,outbox.test}.ts` 及生成 OpenAPI；Desktop 的 `package.json`、`pnpm-lock.yaml`、Main、Preload、Renderer、公开 task feed 和测试。
- 测试：新增 Domain、Application Router、Task API、Fake Worker、Notification API 测试，并扩展 SignalR/Outbox 测试。

## RED/GREEN 证据

- Domain 状态机：首次运行 `dotnet test tests/backend/Jarvis.Domain.Tests/Jarvis.Domain.Tests.csproj --no-restore --configuration Debug --filter TaskDomainTests` 时，新增测试先因 `Jarvis.Domain.Tasks` 尚未实现而编译 RED；完成并收紧全状态图、取消与过期 lease 规则后 GREEN，Domain 全套 9/9。
- Realtime 工具：初版 scripted transport 测试在旧 unavailable stub 上没有产生 function-call output，行为 RED；接入真实 SDK function-call details 后 GREEN。复审又以相同长前缀、不同尾部的 `callId` 复现截断碰撞，改为完整输入摘要并恢复规范 `remember_fact` 参数合同后，Realtime 12/12。
- Desktop feed：`task-feed.test.ts` 首次直接运行时因 `task-feed.js` 缺失得到真实 `ERR_MODULE_NOT_FOUND` RED；后续复审分别复现同毫秒版本回退、refresh 后迟到事件复活、全局通知被 Conversation 过滤、动作响应丢失、分页截断、异步补拉失败与 StrictMode 旧 refresh 覆盖。完成 durable `entityVersion` 水位、有界保守回拉、稳定动作幂等键、七种非终态分页与可取消重试后，Desktop 45/45。
- Worker 可靠性：复审测试曾复现跨 lease 边界 `adapter.Calls=2`，以及续租异常、过期 owner completion 和设备配置静默降级；周期续租、fail-closed、到期 fencing、乐观并发有限重试和 `WorkerDeviceId` 启动校验完成后，Fake Worker 22/22。
- 后端垂直切片 GREEN：Task API 10/10、Fake Worker 22/22、Notification API 3/3、Outbox/SignalR 7/7；完整 API 集成测试 78/78。

## 行为与边界

- Task 终态不可回退；Queued 可直接取消，Running 才能成功或报告进度，运行中先进入 `CancellationRequested`，Fake Worker 确认后才写 `Cancelled`。Task、TaskEvent、Notification、Outbox 事务提交；TaskEvents 使用唯一 `(TaskId, Sequence)`，Notification 使用唯一 `(UserId, DedupKey)`，HTTP 与 Outbox 都携带持久 `entityVersion`。
- Worker Router 对 `localFiles/writeFiles/runCommands` 优先路由 Codex，`deepReasoning/networkResearch` 路由 Responses，无能力路由 Internal，未知 capability 返回 400。Fake Worker 周期续租，未分类续租失败时 fail-closed，过期 lease 不能续租或提交终态；未配置 `WorkerDeviceId` 时作为 Phase 3 通配 seam，显式配置时严格匹配且非法值启动失败。SQLite 是恢复事实来源。
- Task 创建返回 202，不等待 worker；同用户/作用域/Idempotency-Key 由真实 SQLite 唯一键保证 replay/conflict，并校验 Conversation、sourceMessageIds 和 preferredDeviceId 所有权。`attachmentRefs` 参与幂等 payload 并按输入持久化。通知 GET 只返回 Pending/Delivered，delivered/read/dismiss 写操作具备认证、所有权、稳定幂等键与并发重试。
- SignalR 只推送 `task.updated`、`task.eventAdded`、`notification.created`、`notification.updated` envelope；Desktop 重连按七种非终态分页补拉当前 Conversation 的任务并全局补拉未读通知。客户端使用版本水位与有界 tombstone 处理至少一次和乱序推送，水位淘汰或瞬时回拉失败时走权威 HTTP 的有限重试。
- `delegate_task/get_task_status/cancel_task` 通过注入 backend 调用认证 C# API，长 `callId` 的稳定幂等键不会因前缀截断碰撞；`remember_fact` 接受完整规范参数但仍明确返回 Phase 5 unavailable。Desktop bearer 和 SignalR 连接仅在 Main，Preload 暴露固定白名单 IPC，Renderer 不接触 bearer。

## 实际验证

```text
dotnet restore Jarvis.sln --locked-mode                              PASS
dotnet build Jarvis.sln --no-restore --configuration Release          PASS (0 warning, 0 error)
dotnet test Jarvis.sln --no-restore --configuration Release           PASS (105 tests; API integration 78)
dotnet format Jarvis.sln --no-restore --verify-no-changes             PASS
dotnet ef migrations has-pending-model-changes --project src/backend/Jarvis.Infrastructure/Jarvis.Infrastructure.csproj --startup-project src/backend/Jarvis.Api/Jarvis.Api.csproj --configuration Release --no-build  PASS (no pending model changes)
pnpm install --frozen-lockfile                                       PASS (Node 25 vs pinned 24.19 engine warning)
pnpm typecheck                                                       PASS
pnpm lint                                                            PASS
pnpm test                                                            PASS (63 tests: contracts 4, realtime-agent 12, api-client 2, desktop 45)
pnpm build                                                           PASS
pnpm generate:openapi                                                PASS
pnpm check:openapi                                                   PASS (byte-for-byte stable)
pnpm check:codex-schema && pnpm check:codex-schema-canonical         PASS
pnpm test:codex-schema-canonical                                     PASS (2 tests)
pnpm check:secrets && pnpm test:secret-scan                          PASS
git diff --check                                                     PASS
```

## 未解决项与风险

- 本地验证没有启动真实 Electron OS 级窗口、麦克风/WebRTC，也没有真实 OpenAI Codex/Responses、文件/命令/网络副作用验证；这些不是本阶段 Fake seam 的证明范围。
- SignalR、Outbox、SQLite/TestServer 已在本地协议、乱序/迟到事件和重连补拉 seam 验证，但尚未做生产网络、多进程、多实例或部署验证。
- 本机 Node 为 25.0.0，仓库锁定 24.19.0，因此 pnpm 命令保留 engine warning；CI/生产 Node 版本尚未在本机证明。
- Desktop Main/Preload 和生产 build 已通过 TypeScript/build 门禁，但未做真实 OS 级视觉通知体验 E2E。

本阶段由当前本地提交交付，未推送。Phase 4 前置是保留当前 Task/Notification 合同和 Fake adapter seam，新增真实 Device 注册/heartbeat/lease、Codex App Server 与审批/Artifact 边界时不得把 Fake 结果冒充真实执行。
