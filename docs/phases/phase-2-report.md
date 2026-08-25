# Phase 2 报告：Desktop Realtime 语音与文字统一 Conversation

## 结果

Phase 2 已实现并通过本地验证。Control Plane 持久化 `RealtimeSession` 生命周期和 normalized realtime events；Desktop renderer 只在内存中持有短期 ephemeral secret。语音 transcript、assistant 文本/音频 transcript 和 typed text 都写入同一个 Conversation，且连接生命周期使用 WebRTC `session.created` 返回的实际官方 session ID。

## 已交付

- `RealtimeSession` domain entity、单向生命周期、SQLite 映射和 EF migration `20260825174117_Phase2RealtimeSessions`。
- 认证 Desktop bootstrap、用户/Conversation/device 所有权校验、ProblemDetails、Idempotency-Key 及按用户/device 分区的 client-secret 限流。
- Application `IRealtimeClientSecretProvider` port 和 Infrastructure OpenAI adapter：请求 `POST /v1/realtime/client_secrets`，服务端 allowlist model/voice/tools，四个 Phase 3 工具明确返回 unavailable，稳定哈希 safety identifier 不含原始用户标识。
- client-secret bootstrap 返回完整 `instructions`、`expiresAt` 和 `sessionRotationAt`（Unix ms）；公开合同不暴露 mint response 的 `session.id`。Desktop 用该 instructions 创建 `RealtimeAgent`，并以 SDK `getInitialSessionConfig()` 测试证明完整上下文进入 session；连接前注册 `session.created` listener，连接 resolve 后在有界窗口等待实际 WebRTC ID。
- `ContextAssembler` V1 独立预算、固定安全人格指令、从最新消息向前保留以及随持久化历史推进的 ContextVersion；同一 Message 的 streaming→completed/interrupted 更新也会推进版本。
- connected/ended 生命周期端点和 normalized 批量 ingest：event/item 幂等、terminal 状态不可回退、跨 Conversation/session 拒绝、Outbox 仅发送 ID、不保存原始音频。
- `packages/realtime-agent` 精确锁定 `@openai/agents` `0.17.0`、`zod` `4.4.3`，使用公开 `RealtimeAgent`/`RealtimeSession`/`ScriptedRealtimeTransport` 类型。
- Electron main-only 长效 bearer IPC proxy、renderer WebRTC adapter、麦克风 mute/manual interrupt、transcript ingest、50 分钟 idle rotation、typed text-only response、CSP 和 Conversation UI。
- rotation 使用 prepare → 新 session connect/markConnected → atomic swap → 旧 session Rotated/close；新连接或 bootstrap/provider 获取失败时旧 session 保持 connected、未 close/ended，timer 会恢复。旧 transport 的迟到 disconnect 不会影响新 session；旧 session 的 Rotated 写入失败时立即关闭旧 transport，并用同一 bounded idempotency key 保留/重试 lifecycle update。
- SDK `history_updated` 确认 assistant incomplete item 的截断 transcript 后才写入 Interrupted；未确认的累计 delta 不会被当作终态文本。
- Desktop 采用有界 debounce event buffer（单批最多 100），rotation/disconnect 强制 flush；失败批次保留稳定 eventId/batch key，重试成功前阻止 rotation。App 不会在 flush 失败后丢弃 controller，Conversation/文字 UI 保持可用并提供“重试保存”。
- SQLite ingest 对 BUSY/LOCKED/UNIQUE 并发竞争做有限重试并重读 idempotency/sequence；未知 `DbUpdateException` 不会被伪装成冲突。client-secret single-flight 使用带移除标记的引用计数，避免同 key 出现两个并行 semaphore。
- 首次点击连接且没有 Conversation 时，先创建并继续同一次连接流程；OpenAPI/TypeScript contracts、api-client、SQLite/TestServer/fake HTTP/SDK scripted/Electron security 测试已同步。

## RED/GREEN 证据

基线 HEAD 为 `d0261f3791fabf267945344af3faf944501d2461`，基线 backend Debug 测试为 40 个通过。review blocker 的真实 RED 包括：

- SDK context test 在旧 `createRealtimeAgent` 下失败：SDK session 实际仍收到固定 `REALTIME_INSTRUCTIONS`，而不是后端完整 context。
- API integration test 首次编译失败：`RealtimeClientSecretResponse` 缺少 `externalSessionId`、`instructions`、`expiresAt`、`sessionRotationAt`。
- Desktop injected-session test 首次失败：agent 使用固定 instructions，且无 session.created 时会伪造 `desktop-<uuid>` external ID。
- actual WebRTC ID（包括 `connect()` resolve 后才到达的 `session.created`）、flush/retry、并发 batch、single-flight、provider/bootstrap failure 和 ContextVersion regression tests 均先以失败断言锁定旧行为，再实现对应 seam。

修复后的 targeted GREEN：

- `dotnet test tests/backend/Jarvis.Application.Tests/Jarvis.Application.Tests.csproj --no-restore --configuration Debug --filter RealtimeContextTests` — 4 passed，包含高并发 single-flight lease 测试。
- `dotnet test tests/backend/Jarvis.Infrastructure.Tests/Jarvis.Infrastructure.Tests.csproj --no-restore --configuration Debug --filter RealtimeClientSecretProviderTests` — 1 passed，断言 placeholder bearer 只在服务端 Authorization header。
- `dotnet test tests/backend/Jarvis.Api.IntegrationTests/Jarvis.Api.IntegrationTests.csproj --no-restore --configuration Debug --filter RealtimeApiTests` — 8 passed，包含真实 SQLite/TestServer lifecycle、重启恢复、replay、secret 不持久化、跨 Conversation 防护、并发 ingest/client-secret 和 200 字符 eventId。
- `pnpm --filter @jarvis/realtime-agent test` — 5 passed，包含 SDK scripted context config、typed interruption 顺序和 idle rotation。
- `pnpm --filter @jarvis/desktop test` — 16 passed，包含首次 Conversation 创建、实际 WebRTC ID（deferred event）、双 fake rotation 成功/失败、flush/retry/race、断线后 controller 保留、旧 lifecycle retry、旧 transport 隔离、history 截断 interruption 和 Electron security。

## 验证

- `dotnet restore Jarvis.sln --locked-mode` — passed。
- `dotnet build Jarvis.sln --no-restore --configuration Debug` — passed。
- `dotnet test Jarvis.sln --no-restore --configuration Debug` — 54 passed。
- `dotnet build Jarvis.sln --no-restore --configuration Release` — passed，0 warning/error。
- `dotnet test Jarvis.sln --no-build --no-restore --configuration Release` — 54 passed。
- `dotnet format Jarvis.sln --verify-no-changes --no-restore` — passed。
- `dotnet list Jarvis.sln package --vulnerable --include-transitive` — 未报告 vulnerable package。
- `dotnet ef migrations has-pending-model-changes --project src/backend/Jarvis.Infrastructure/Jarvis.Infrastructure.csproj --startup-project src/backend/Jarvis.Api/Jarvis.Api.csproj --configuration Release --no-build` — no pending model changes。
- `pnpm install --frozen-lockfile` — passed；Node `25.0.0` 相对仓库 pinned `24.19.0` 仅产生 engine warning，偏差保留。
- `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build` — passed；Desktop 16 tests、realtime-agent 5 tests、contracts 3 tests、api-client 1 test。
- `pnpm generate:openapi`、`pnpm check:openapi` — generated files byte-for-byte unchanged。
- `pnpm check:codex-schema`、`pnpm check:codex-schema-canonical`、`pnpm test:codex-schema-canonical` — passed（275 schema files）。
- `pnpm check:secrets`、`pnpm test:secret-scan` — passed；renderer build 未发现标准 OpenAI key pattern。

## 残余风险与未验证 gate

- 当前环境没有 `OPENAI_API_KEY`。fake HTTP 和 SDK scripted transport 只证明 adapter 合同、上下文配置和本地状态机；live OpenAI authorization、WebRTC、麦克风权限、真实音频播放和音质仍未验证。
- Electron UI/security/build 本地通过，但没有真实 OS microphone/WebRTC E2E smoke。
- 单机 Desktop device bootstrap 是 Phase 2 bridge；正式设备注册、heartbeat、lease、pairing 留给 Phase 4。
- OpenAI/Agents SDK 行为仍可能漂移；升级前必须保持精确版本和 adapter 合同测试。
