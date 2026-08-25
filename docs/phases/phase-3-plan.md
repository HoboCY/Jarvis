# Phase 3 计划：Task Orchestrator、Fake Worker 与持久化通知

## 目标

在 Phase 2 的统一 Conversation、Realtime 薄工具占位、SQLite、Outbox 和认证 SignalR 基座上，打通“Realtime 快速委派 → 后端持久化任务 → Fake Worker 异步执行 → 持久化通知 → Desktop 在线推送或重连补拉”的完整纵向链路。数据库中的 Task、TaskEvent 和 Notification 是唯一事实来源；Realtime tool、SignalR 消息和 Desktop 内存状态都不是事实来源。

## 本阶段范围

- 新增 `Tasks`、`TaskEvents`、`Notifications` 领域实体、完整合法状态转换、EF 映射、索引和 migration；所有时间继续使用 UTC Unix ms，所有实体保留并发版本。
- 实现确定性的 Worker Router：本地文件、写文件或命令能力路由为 Codex；纯文本深度推理或网络研究路由为 Responses；后端内部能力路由为 Internal。Phase 3 只执行明确标注的 Fake adapter，不冒充真实 Codex/Responses 集成。
- 实现 Task Orchestrator 的创建、按所有权查询、按 Conversation/状态列表、取消和 Fake Worker 执行入口；创建必须在单个事务内写 Task、首个 TaskEvent、IdempotencyRecord 和 Outbox。
- 实现 Fake Delay Worker 的受控异步处理：从数据库领取已持久化任务、写入进度、观察取消、生成确定性的示例结果，并在终态事务内写 TaskEvent、Notification 和 Outbox。测试可直接触发单轮处理，生产循环只依赖数据库恢复工作，不依赖内存队列。
- 实现 `POST /api/v1/tasks`、`GET /api/v1/tasks/{taskId}`、`GET /api/v1/tasks?conversationId=...&status=...`、`POST /api/v1/tasks/{taskId}/cancel`；写操作要求 `Idempotency-Key`，错误继续使用 Problem Details。
- 实现未读通知查询及 delivered/read/dismiss 状态更新 API；通知按 `NotificationId` 和后端 `DedupKey` 去重，用户不能读取或更新他人的 Task/Notification。
- 扩展 SignalR/Outbox 合同，发布 `task.updated`、`task.eventAdded`、`notification.created`、`notification.updated`；业务状态、通知和对应 Outbox 必须同事务提交。
- 将 `delegate_task`、`get_task_status`、`cancel_task` 从 Phase 2 unavailable stub 替换为 Renderer 中的受认证 C# API 薄代理；`remember_fact` 继续明确返回 Phase 5 unavailable。工具执行结果只反映后端已持久化状态，不声称 Fake/真实 Worker 已经完成。
- 使用 SDK 提供的 function-call details 将 Realtime Session scope 与 `toolCall.callId` 组合为稳定幂等键；同一工具调用重放不得重复创建任务或重复取消。
- Desktop Main 持有长期 bearer 和 SignalR 连接，只通过严格白名单 IPC 向 Renderer 转发已验证的连接状态与事件；Renderer 不接触 bearer。
- Desktop 增加 Task Center、未读通知弹窗、read/dismiss 操作和按 NotificationId 去重；SignalR 连接或重连后主动补拉未读通知与当前 Conversation 的非终态任务，不依赖 SignalR 补历史。
- 更新 OpenAPI、生成的 TypeScript 合同/API client、secret scan、测试和 `docs/phases/phase-3-report.md`。

## 明确不在本阶段

- 真实 Device 注册/心跳/lease、DeviceHub、Codex App Server、审批与 artifact manifest；属于 Phase 4。Phase 3 的 Fake Worker 不能写 Codex Thread/Turn ID，也不能执行文件、命令或网络副作用。
- Responses API、Conversation Summary、MemoryFacts 和 `remember_fact` 持久化；属于 Phase 5。
- 系统级 Push、日历、定时任务、后台移动唤醒、完整重试/circuit breaker、安装包和 Overlay 窗口；属于 Phase 6–7。
- 以 SignalR 或进程内 Channel 作为任务/通知事实来源；SignalR 只负责低延迟提示，重连恢复必须走 HTTP + SQLite。

## 公共接口与不变量

- 公共测试 seam 为领域实体状态转换、Task Orchestrator、认证 HTTP API、真实 SQLite/TestServer、真实 SignalR client、Realtime Agent SDK scripted transport，以及 Desktop 的公开任务/通知控制器与白名单 IPC；不测试私有方法或 EF 调用次数。
- Task 只能沿规范状态图转换；终态不可回退。运行中取消先进入 `CancellationRequested`，只有 Worker 确认停止后才进入 `Cancelled`；尚未开始的 Queued Task 可直接安全取消。
- `POST /tasks` 只有数据库事务成功后才能返回 accepted；同用户、同 endpoint、同 Idempotency-Key、同 payload 返回原 TaskId，异 payload 返回 `409`。并发重放由 SQLite 唯一约束证明，而不是仅靠内存锁。
- `sourceMessageIds` 必须属于同一用户和 Conversation；`preferredDeviceId` 必须属于当前用户；未知或不支持的 capability 必须返回 `400`，不能自由映射为更高权限 Worker。
- Fake Worker 的延迟、结果和失败行为通过配置/测试 seam 控制；默认结果必须明确标识为 fake，不得被阶段报告描述为真实 Codex/Responses 结果。
- Task 终态和 Notification/Outbox 同事务；通知至少一次投递，客户端按 NotificationId 去重。SignalR 推送成功不自动等同于用户已读，只有客户端回执才推进 Notification 状态。
- Realtime tools 只验证参数、调用后端、返回后端 DTO。`delegate_task` 快速返回 accepted/taskId/status；`get_task_status` 和 `cancel_task` 必须重新经过当前用户所有权校验。
- Renderer 不读取 token、不直接连接任意 URL、不执行文件或命令；Main 只允许固定 Control Plane hub/API 路径，并向 Renderer 转发合同允许的事件。

## 实施切片与 TDD 顺序

1. **领域状态机**：先写 Task 全状态图、取消、终态保护和 Notification 单向状态测试，再实现实体。
2. **关系 schema 与幂等创建**：先写真实 SQLite/TestServer 的创建、所有权、并发同键重放、异载荷冲突和重启保留测试，再实现映射、migration、store 和 API。
3. **Worker Router 与 Fake adapter**：先写确定性路由、未知能力拒绝、异步快速接受、进度/完成、运行中取消和非终态恢复测试，再实现 orchestrator 与 Fake Worker 单轮/hosted loop。
4. **通知事务与补发**：先写终态同事务生成 Notification/Outbox、SignalR 在线投递、失败保留、离线后重启补拉、delivered/read/dismiss 单向状态和去重测试，再实现服务与端点。
5. **Realtime 薄工具**：使用官方 SDK `ScriptedRealtimeTransport` 先证明三个真实工具经过 SDK 校验/执行/返回，重复 `toolCall.callId` 复用稳定 Idempotency-Key，错误安全返回；再注入 Desktop 后端代理，保留 `remember_fact` unavailable。
6. **Desktop 可观察流程**：先通过公开 feed/controller seam 测试连接后补拉、事件去重、任务刷新、通知弹窗、read/dismiss 与重连补发，再接 Main SignalR、Preload IPC 和 React Task Center。
7. **合同与回归**：重新生成 OpenAPI/TS，验证 SignalR payload 可解码，运行全部 .NET/pnpm/EF/format/schema/secret/Electron 门禁，并生成阶段报告。

## 验收证据

- 真实 TestServer + 临时 SQLite 证明任务创建在 1 秒内返回持久化 TaskId，并发同键只产生一条 Task；重启后 Task、TaskEvents 和 Notification 仍存在。
- Fake Worker 定向测试证明 Task 进度与终态、运行中取消和恢复流程，且所有结果明确来自 Fake adapter。
- 真实 SignalR 测试客户端证明已提交 Outbox 可发布 `task.updated` 与 `notification.created`；断开连接完成任务后，重连通过 HTTP 拉取仍能看到同一未读 Notification。
- SDK scripted transport 证明 Realtime 三个工具走真实 SDK function-call 管线，后端返回前不伪造成功，稳定 tool-call idempotency 不重复创建 Task。
- Desktop 测试/build 证明长期 bearer 仍只在 Main，Renderer 通过白名单 IPC 接收事件并按 NotificationId 去重显示 Task Center/通知；重连触发补拉。
- `dotnet restore/build/test/format`、NuGet vulnerability audit、EF migration drift、`pnpm install --frozen-lockfile`、typecheck/lint/test/build、OpenAPI diff、Codex schema、secret scan 和 Electron security 全部通过。

## 风险与未验证项

- Fake Delay Worker 只证明编排、持久化、取消、通知和恢复 seam；真实 Codex/Responses 执行能力分别留到 Phase 4/5，报告必须明确区分。
- 本阶段可用 TestServer/真实 SignalR client 验证协议与补拉，但真实 Electron 窗口的 OS 级视觉/通知体验若环境无法启动，需要保留为 Phase 6 E2E gate。
- `@microsoft/signalr` 新依赖必须精确锁定并通过 frozen lockfile；本机 Node 25.0.0 与仓库 Node 24.19.0 的偏差继续记录。
- SQLite 单写者可能在并发任务、Worker 和 Outbox 间出现 BUSY/唯一键竞争；只对已识别的瞬时/唯一冲突做有限重试，未知数据库异常继续抛出。
