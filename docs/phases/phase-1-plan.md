# Phase 1 计划：Control Plane 基础

## 目标

在 Phase 0 架构边界内建立可持久化、可认证、可幂等验证的 Control Plane 基础，使 Conversation 和 typed message 成为数据库事实，并为后续 Realtime、Task 与 Notification 阶段提供 SignalR 和 Outbox 基座。

## 本阶段范围

- 引入 EF Core 10、SQLite、受版本控制的 migration 和迁移漂移检查。
- 实现 `Users`、`Devices`、`Conversations`、`Messages`、`IdempotencyRecords`、`OutboxMessages` 的领域模型、EF 映射、关系约束、唯一索引和 Unix 毫秒时间存储。
- 使用本机单用户 Bearer Token 认证基础；Token 只能来自必需配置，缺失或过短时启动失败，不写入仓库或日志。
- 实现受认证的 Conversation 创建、详情读取、消息游标分页和 typed message 写入 API。
- typed message 通过 `UserId + Scope + Idempotency-Key` 数据库唯一键实现幂等；相同键和相同请求返回原响应，不同请求返回 `409 ProblemDetails`。
- 实现受认证的 SignalR `ClientHub`。
- 实现数据库 Outbox 处理器与 SignalR 发布适配器；发布成功后持久化 `PublishedAtMs`，失败保留并记录有限重试信息。
- 更新 OpenAPI/TypeScript 合同、CI、测试和阶段报告。

## 明确不在本阶段

- Realtime client secret、Realtime Session、WebRTC、ContextAssembler 和 event ingest；这些属于 Phase 2。
- Tasks、Approvals、Notifications、Device lease、Codex 和 Responses Worker；这些属于 Phase 3–5。
- Desktop Conversation UI、任务中心和通知弹窗。
- 多用户注册、密码登录、设备配对和远程部署。

## 实施切片与 TDD 顺序

1. **SQLite schema**：先写真实临时 SQLite 的迁移/约束失败测试，再实现实体、`JarvisDbContext`、映射、design-time factory 和初始 migration。
2. **认证与 Conversation**：先写 TestServer 的未认证、创建、读取、所有权和分页测试，再实现本机单用户认证、数据库初始化和薄 Minimal API endpoints。
3. **typed message 幂等**：先证明重放只产生一条 Message、数据库唯一键拒绝重复身份、同键异请求返回冲突，再实现原子持久化流程。
4. **SignalR 与 Outbox**：先写真实 Hub 握手和 SQLite Outbox 发布测试，再实现 `ClientHub`、发布端口、处理器和后台 dispatcher。
5. **恢复与合同**：用同一 SQLite 文件重建 TestServer，证明 Conversation/Message/Outbox 状态保留；重新生成 OpenAPI/TS 合同并运行 migration drift、架构、secret 和完整回归门禁。

## 验收证据

- `dotnet restore Jarvis.sln --locked-mode`、Release build/test 通过且 NuGet audit 无已知漏洞。
- `dotnet ef migrations has-pending-model-changes` 返回无漂移，migration 可对空 SQLite 数据库应用。
- 真实 HTTP 请求创建/读取 Conversation；消息使用游标分页。
- 同一 typed message 重放返回相同 `messageId/sequence`，数据库只有一条 Message；同键不同载荷为 RFC Problem Details `409`。
- 无认证 Conversation API/ClientHub 被拒绝；正确本机 Token 可完成 API 和 SignalR 握手。
- Outbox 真实记录被发布一次并写入 `PublishedAtMs`；失败路径不会误标发布。
- 使用同一 SQLite 文件重启 TestServer 后，已确认的 Conversation 和 Message 仍可读取。
- `pnpm check:openapi`、TypeScript typecheck/lint/test/build、Codex schema、secret scan 和 Electron security 回归通过。

## 风险与约束

- SQLite 仍只用于 V1 单机模式；映射避免 SQLite 专属领域语义，以保留 PostgreSQL 迁移路径。
- EF Core Microsoft 包统一锁定 `10.0.11`；显式提升 `SQLitePCLRaw.bundle_e_sqlite3` 到无已知高危告警的 `2.1.13`，避免传递依赖回落到 `2.1.11`。
- 本机 Node 是 25.0.0；Node 24.19.0 兼容性仍由 GitHub Actions 证明。
- 本阶段 Outbox 是可靠发布基座，不提前创建 Phase 3 的 Notification 领域对象。
