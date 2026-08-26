# Phase 4 计划：Device Node、Codex App Server 与显式审批

## 目标

在 Phase 3 的持久化 Task、TaskEvent、Notification 与 Outbox 基座上，打通“Codex 任务入队 → Device Node 原子领取租约 → 受限 Codex App Server 执行 → 显式审批 → 结果与产物清单落库 → 通知”的完整纵向链路。Control Plane 中的 Device、Task、TaskExecution、Approval、Notification 仍是唯一事实来源；SignalR、Device Node 本地缓存和 Codex Thread 都不是事实来源。

## 本阶段范围

- 扩展 Device 领域模型，支持注册、专用设备凭据、心跳、能力更新、在线/离线/禁用状态和并发版本；设备凭据只存不可逆哈希，UI bearer 与 Device credential 严格分离。
- 新增 `TaskExecutions` 与 `Approvals` 领域实体、EF 映射、索引和 migration；实现 Approval 单次决定、过期拒绝、Once/TaskSession scope、Task/Execution/Device 绑定和审计事件。
- 实现 Device Coordination 用例与 `POST /api/v1/devices/register`、`POST /api/v1/devices/{deviceId}/heartbeat`、`POST /api/v1/device-tasks/claim`、`POST /api/v1/device-tasks/{taskId}/events`、`POST /api/v1/device-tasks/{taskId}/lease:renew`；所有写入口幂等，claim/renew/event 必须验证租约所有权与设备身份。
- 新增认证 `DeviceHub`，发布 `task.available`、`task.cancellationRequested`、`approval.resolved`、`node.configurationChanged`；SignalR 只提示，领取权只来自数据库原子 lease。
- 实现 UI Approval API：`GET /api/v1/approvals?status=pending` 与 `POST /api/v1/approvals/{approvalId}/decision`；决定只接受后端枚举和显式 UI 操作，并在同一事务更新 Approval、Task、TaskEvent、Notification 与 Outbox。
- 扩展 Desktop Main/Preload/Renderer 白名单链路，连接/重连后补拉 pending approvals，按 ApprovalId 去重显示明确的批准一次/拒绝按钮；Renderer 不持有 bearer、Device credential 或任意 Codex decision payload。
- 在 `Jarvis.DeviceNode` 内建立窄 `ICodexRuntime` 端口、Codex 进程 supervisor 和 stdio JSONL 客户端；完成每连接一次 `initialize`/`initialized`，支持 `thread/start`、`thread/resume`、`turn/start`、`turn/interrupt`，关联 request/response 与 server request，流式转发 item/turn 事件。
- 处理 command execution、file change 与 permission approval server request；Device Node 先持久化 Approval 并暂停 Task，收到 Control Plane 的绑定决定后才响应 Codex。拒绝、取消、过期和连接丢失均安全收束，不默认放行。
- 每个 Jarvis Task 默认创建独立 Codex Thread，并持久化 `TaskId ↔ DeviceId ↔ CodexThreadId ↔ CodexTurnId`；恢复时优先 `thread/resume`，禁止跨任务自动复用。
- 实现 capability envelope：`readFiles`、`writeFiles`、`runCommands`、`network`、`allowedRoots`。默认只读、网络关闭；路径必须 canonicalize、拒绝 traversal 与敏感凭据目录，写入/命令/扩大根目录必须审批，Codex 子进程只继承最小环境。
- 实现结果与 typed artifact manifest；产物只允许登记 canonical path 位于 approved roots 内的文件，并随 TaskExecution metadata/Task result 持久化。任务终态、通知和 Outbox 同事务。
- 实现 Device Node 与 Codex 进程恢复：子进程退出立即上报 `Recovering`，记录脱敏 stderr 摘要，有限次数退避重启，成功 resume 后继续，耗尽后明确失败并通知，不允许热循环。
- 保持 `eng/versions.json` 中 Codex `0.146.0` 与实际 native binary SHA-256 固定；用该二进制重新生成 schema 到临时目录并与 `artifacts/codex-schema/0.146.0` 比较，扩展 initialize/thread/turn/interrupt/notifications/approvals 契约测试。
- 更新 OpenAPI、生成 TypeScript 合同/API client、secret scan、安全门禁、阶段测试和 `docs/phases/phase-4-report.md`。

## 明确不在本阶段

- Responses API 后台执行、Conversation Summary、MemoryFacts 与 `remember_fact`；属于 Phase 5。
- 系统级 Push、日历、定时任务、移动端后台唤醒、生产安装器和 Overlay；属于 Phase 6–7。
- 实验性 Codex WebSocket listener；V1 只使用官方 stdio JSONL 协议。
- 把 Codex DTO、JSON-RPC payload 或本地执行状态引入 Domain；上游协议始终封装在 Device Node 的 `ICodexRuntime` 后面。
- 自动理解自然语言“同意”为审批、任意客户端自定义 decision、跨任务复用授权、或为了测试而默认放宽 sandbox/allowed roots。

## 公共接口与不变量

- 公共测试 seam 为领域状态机、认证 HTTP API、真实 SQLite/TestServer、真实 SignalR client、Device Node orchestration、真实 JSONL 子进程和 Desktop 公开 controller/IPC；不测试私有方法或进程调用次数。
- Device credential 只能代表一个未禁用 Device；UI bearer 无法调用 Device API/DeviceHub，Device credential 无法调用用户审批 API/ClientHub。
- Codex Task 只能由 capability 匹配、Preferred/AssignedDeviceId 合法且 lease 未被其他节点持有的 Device claim；同一 Task 同时最多一个有效 lease 和一个 active TaskExecution。
- Device task event 以 `DeviceId + TaskId + ClientEventId` 唯一，重放返回原结果；乱序、错误 ExecutionId、错误 lease owner、过期 lease 和终态后的事件被拒绝。
- Approval 创建与 Task `WaitingForApproval` 同事务；一次决定不可重放为不同结果，过期决定拒绝。批准仅恢复对应执行，拒绝使当前执行安全结束并产生明确终态/通知。
- SignalR 只传低延迟提示；客户端和 Device Node 重连后必须通过 HTTP 恢复 pending approvals、non-terminal tasks 与 assigned/recovering executions。
- Codex 进程退出不能直接重复执行副作用；先进入 `Recovering`，恢复已有 Thread/Turn 映射，只有确认不可恢复或达到策略上限后才失败。
- artifact manifest 只接受允许根目录内的 canonical regular files；拒绝目录穿越、symlink 逃逸、敏感凭据目录和未授权根目录。

## 实施切片与 TDD 顺序

1. **Device 与审批领域状态**：先写注册/心跳/禁用、Approval 单次决定/过期/scope、Task 等待审批/恢复和路径权限测试，再实现实体。
2. **关系 schema 与 Device 身份**：先用真实 SQLite/TestServer 证明 credential hash、UI/Device 认证隔离、注册/心跳持久化与重启恢复，再实现映射、migration 和认证 handler。
3. **原子 lease 与 execution**：先写并发 claim 唯一胜者、能力/指定设备过滤、续租、过期进入 Recovering、事件幂等/乱序拒绝测试，再实现协调服务和 API。
4. **审批事务与双 Hub**：先写审批请求、pending pull、一次性决定、过期/异设备拒绝、TaskEvent/Notification/Outbox 同事务和 DeviceHub/ClientHub 推送测试，再实现服务与端点。
5. **Codex 协议适配器**：使用真实 Fake Codex App Server JSONL 子进程，先覆盖 initialize、thread start/resume、turn start/interrupt、stream items、三类 approval server request、protocol error 与关联取消，再实现 `ICodexRuntime` 和 supervisor。
6. **Device Node 执行循环与恢复**：先覆盖注册/心跳/claim、受限执行、进度、批准继续、拒绝终止、cancel、进程崩溃→Recovering→有限重启/resume→成功或失败，再实现 hosted worker。
7. **Desktop 审批流程**：先通过公开 feed/controller seam 覆盖重连补拉、ApprovalId 去重、批准一次、拒绝、过期刷新和 IPC 输入校验，再接 Main SignalR、Preload 与 React UI。
8. **合同、真实 smoke 与回归**：比较固定版本 schema，运行真实 pinned Codex 的只读受限任务 smoke，重新生成 OpenAPI/TS，执行全部 .NET/pnpm/EF/format/schema/secret/Electron 门禁并生成阶段报告。

## 验收证据

- 真实 TestServer + 临时 SQLite 证明 Device 独立认证、注册/心跳、并发 claim 单胜者、续租、事件幂等、审批事务和重启恢复。
- Fake Codex JSONL 子进程证明完整 initialize/thread/turn/interrupt、progress、write approval 批准继续、拒绝安全结束和进程崩溃恢复；测试观察公共协议和持久化状态。
- 固定的真实 Codex `0.146.0` 执行一个网络关闭、只读 sandbox、单一 allowed root 的本地任务；不依赖 fake 声称真实集成完成。
- 真实 SignalR client 证明 `task.available` 仍需 HTTP claim，`approval.required`/`approval.resolved` 可达；断线重连通过 HTTP 补拉不会丢审批。
- Desktop test/build 证明用户只能通过明确按钮选择后端 decision enum，Renderer 无 bearer/Device credential/Codex raw payload。
- Task 成功时 result/artifact manifest、TaskExecution、TaskEvent、Notification 与 Outbox 一致；拒绝、崩溃耗尽和不可恢复路径产生安全终态与通知。
- `dotnet restore/build/test/format`、NuGet vulnerability audit、EF migration drift、`pnpm install --frozen-lockfile`、typecheck/lint/test/build、OpenAPI diff、Codex schema、secret scan 和 Electron security 全部通过。

## 风险与回滚

- Codex App Server 协议快速变化；适配器只绑定固定 schema，升级必须先刷新二进制校验和、生成 schema 并通过契约测试。回滚可恢复固定二进制与对应 schema/adapter。
- 进程崩溃时无法证明某个外部副作用是否已完成；恢复默认复用 Thread 且不自动重放未知副作用，必要时明确失败并要求用户确认。
- Device credential、路径和命令日志均可能敏感；只持久化哈希、最小化环境并对 stderr/路径做脱敏。任何认证或路径策略异常应 fail closed。
- migration 同时增加执行和审批状态；回滚前须停止 Device Node、确认无非终态执行，再按 EF migration 回退并恢复旧二进制。
- 本机 Node `25.0.0` 与仓库固定 `24.19.0` 不一致；前端门禁仍以 frozen lockfile 与 CI 固定版本为准，阶段报告保留该环境差异。
