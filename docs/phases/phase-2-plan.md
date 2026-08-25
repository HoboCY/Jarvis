# Phase 2 计划：Desktop Realtime 语音与文字统一会话

## 目标

在 Phase 1 的 Conversation、Message、认证、SQLite、Outbox 和 SignalR 基座上建立可轮换的 Realtime Session。Desktop 的语音与文字必须进入同一个逻辑 Conversation；OpenAI Realtime 只负责当前低延迟交互，C# Control Plane 继续负责身份、上下文组装、会话记录、消息持久化、幂等、恢复和审计。

## 本阶段范围

- 新增 `RealtimeSessions` 持久化模型、EF 映射和 migration；Session 与 Conversation、Device 关联，但不保存短期 client secret。
- 实现受认证的单机 Desktop bootstrap，返回当前用户已登记的 Desktop `DeviceId`；完整设备注册、心跳和专用设备身份仍留在 Phase 4。
- 实现 `POST /api/v1/realtime/client-secrets`、connected/ended 生命周期端点和每用户/设备创建限流。
- 通过应用层 `IRealtimeClientSecretProvider` 隔离 OpenAI；Infrastructure 使用标准 API Key 调用当前官方 `POST /v1/realtime/client_secrets`，只把短期 `value` 返回给客户端。
- 实现稳定、不可逆、最长 64 字符的用户 safety identifier。当前官方 Realtime client-secret schema 没有独立 `safety_identifier` 字段，因此只通过受支持的 session tracing metadata 传递，不发送用户原始标识；此兼容差异由 adapter 合同测试固定并在报告中保留。
- 实现 `ContextAssembler` V1：固定人格/安全规则不可裁剪；用户偏好、摘要、最近消息、任务结果和 Memory Facts 使用独立预算。Phase 2 尚无摘要、任务和 Memory 表时后三类为空，不伪造数据；优先丢弃最旧消息。
- 实现 `POST /api/v1/conversations/{conversationId}/realtime-events:ingest`，批量接收版本化规范事件，支持请求幂等、事件去重、外部 item 去重、partial/streaming 到 terminal 的单向更新，并拒绝跨 Conversation/Session 覆盖。
- 扩展 Message 领域行为，持久化 voice user transcript、assistant text/audio transcript、Completed/Interrupted/Failed 终态；不保存原始音频。
- 扩展 `packages/realtime-agent`：固定指令、四个受限工具 schema/stub、版本化 normalized event、typed text-only helper、连接错误映射和 50 分钟 idle-boundary rotation 状态机。
- Desktop 使用锁定版本的 OpenAI Agents SDK `RealtimeAgent`/`RealtimeSession` 与浏览器 WebRTC，启用麦克风、播放、VAD、自动/手动中断；typed message 先持久化，再中断当前语音，随后在同一 Realtime Session 触发 text-only response。
- Desktop 把最终 transcript、文本增量/终态和 interruption 规范化后批量写回 Control Plane，并在 Session 断开时保留已持久化 Conversation 和纯文字 UI。
- 更新 OpenAPI/TypeScript 合同、CSP、secret scan、CI、测试和阶段报告。

## 明确不在本阶段

- Tasks、TaskEvents、Notifications、Approvals、Fake Worker 和四个 Realtime tool 的真实业务执行；属于 Phase 3。Phase 2 的 tool stub 必须返回明确的 unavailable/unsupported 结果，不得伪造成功。
- Device 注册/心跳/lease、Device Node、Codex app-server；属于 Phase 4。
- Responses Worker、摘要生成、Memory 检索、移动端 Native WebRTC 和远程部署；属于 Phase 5–7。
- Realtime sideband、原始音频持久化、任意客户端模型/MCP 配置或浏览器内本地命令执行。

## 公共接口与不变量

- `IRealtimeClientSecretProvider` 是应用层唯一 OpenAI client-secret 外部端口；测试 fake 只能放在该端口之后。
- client-secret 请求只接受后端允许列表中的 model/voice/tool 配置；标准 API Key 只来自后端必需配置，短期 secret 不写数据库、日志、异常或 Outbox。
- 每次写入端点必须使用 `Idempotency-Key`，错误统一为 Problem Details；同键同载荷重放原响应，同键异载荷返回 `409`。
- normalized event schema 带显式版本、eventId、externalItemId、role/modality/status/text 和 session identity；terminal 状态不可回退为 streaming，跨 Conversation 的 session 或 item 返回冲突。
- 一条逻辑 Conversation 可有多个短期 RealtimeSession；50 分钟仅进入 rotation-ready，用户说话或助手回答期间不得切断，空闲后才获取新 Context、连接新 Session 并把旧 Session 标记 `Rotated`。
- typed message 始终复用当前 Realtime Session，默认 `output_modalities: ["text"]`；发送时先中断正在播放的语音。断线只降级 Realtime 能力，不删除或重建 Conversation。

## 实施切片与 TDD 顺序

1. **领域与 schema**：先写 RealtimeSession 状态转换、Message partial/terminal 更新和真实 SQLite 约束测试，再实现实体、映射和 migration。
2. **Context 与 OpenAI adapter**：先写预算、旧消息裁剪、安全规则保留、稳定哈希和 fake HTTP 合同测试，再实现 ContextAssembler、配置校验与 client-secret provider。
3. **受认证 API**：先写无认证、设备/Conversation 所有权、限流、bootstrap、secret 不持久化、connected/ended 幂等和失败 Problem Details 测试，再实现 endpoints/services/store。
4. **事件 ingest**：先写批量重放、partial 到 completed/interrupted、外部 item 去重、terminal 不回退、跨 Conversation 拒绝和重启恢复测试，再实现持久化流程和 Outbox 事件。
5. **共享 Realtime 包**：先写 normalized schema 向后兼容、text-only、typed interruption、工具白名单、错误映射和 rotation clock 状态机测试，再实现 package API。
6. **Desktop 可观察流程**：以可注入 transport/session port 测试 connect、voice transcript、typed text-only、barge-in 和 rotation；生产 adapter 使用 Agents SDK/WebRTC，Renderer 展示 Conversation、连接状态、麦克风与 typed composer。
7. **合同与回归**：重新生成 OpenAPI/TS 类型，运行真实 TestServer + SQLite、fake OpenAI HTTP、SDK scripted transport、Desktop 构建和完整质量门禁。

## 验收证据

- 真实 TestServer/SQLite 证明 authenticated bootstrap、client-secret、connected/ended、normalized ingest、重启恢复与跨 Conversation 防护。
- fake OpenAI HTTP server 断言标准 Key 仅在服务端 Authorization header，body 使用当前 `expires_after + session` schema，响应读取 top-level `value/expires_at/session.id`；日志和数据库均不含 secret。
- Context 单元测试证明固定安全规则不裁剪、各 section 预算独立、旧消息先裁剪、ContextVersion 随已持久化消息推进。
- Realtime package/SDK scripted transport 证明 voice 与 typed 共享同一 session/history，typed 先 interrupt 再 text-only，assistant 被打断后只持久化已确认文本，rotation 只在 idle boundary 执行。
- Desktop production build 包含 WebRTC adapter、麦克风/播放控制和恢复 UI；renderer bundle secret scan 不含标准 key 或 `sk-` 形态。
- `dotnet restore/build/test/format`、NuGet vulnerability audit、EF migration drift、`pnpm install --frozen-lockfile`、typecheck/lint/test/build、OpenAPI diff、Codex schema、secret scan 和 Electron security 全部通过。

## 风险与未验证项

- 当前环境没有 `OPENAI_API_KEY`，因此本阶段能用 fake HTTP 和 SDK scripted transport 完整验证代码/合同，但无法在本机证明真实 OpenAI 账号、麦克风权限、网络质量和实际语音播放；阶段报告必须明确保留 live acceptance gate，不把 fake 结果写成真实语音已通过。
- OpenAI Realtime API/Agents SDK 变化快；锁定 package 版本，所有原始事件和 client-secret payload 隔离在 adapter，并用合同测试固定当前 schema。
- 本机 Node 25.0.0 与仓库 Node 24.19.0 有偏差；本地结果和 GitHub Actions 结果分开记录。
- safety identifier 在当前 Realtime client-secret schema 中没有专用字段；若官方后续增加字段，优先迁移到正式字段并移除 tracing metadata 兼容路径。
- Phase 2 的 Desktop bootstrap 只服务单机已认证用户；Phase 4 必须用正式设备注册/配对和专用设备身份替换该临时发现入口。
