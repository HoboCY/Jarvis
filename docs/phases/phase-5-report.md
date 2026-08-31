# Phase 5 实施报告：Responses Worker、会话摘要与显式记忆

## 结果

Phase 5 的代码范围已完成：纯文本 Task 现在可由 Control Plane 内的 Responses Worker 在不依赖 Device Node 的情况下执行；OpenAI Response ID 只作为 TaskExecution 的外部映射，Jarvis 数据库中的 Task、Conversation、Message、Summary、MemoryFact、Notification 与 Outbox 仍是事实来源。

长会话现在通过累计 Conversation Summary、摘要之后的消息增量、分区上下文预算和显式 Memory Fact 继续。Realtime Session 轮换后会重新从认证 bootstrap 读取数据库事实，不依赖前端内存或 SignalR 补历史。

## 主要改动

- Responses SDK 边界：Infrastructure 引入官方 `OpenAI` .NET SDK `2.13.0`，以窄 `IResponsesRuntime` create 端口隔离 SDK DTO，并以继承它的 `IStoredResponsesRuntime` 单独承载 OpenAI 的 retrieve/cancel 生命周期。日常 provider 由 `Responses:Provider` 选择：OpenAI 保留 background/store/retrieve/cancel；DeepSeek 指向 `https://api.deepseek.com`，create 强制 `background=false`、`store=false`，只接受同步终态，queued/in-progress/unknown 立即 fail closed，不伪造 retrieve/cancel。模型、超时、重试与轮询由 `Responses:*` 配置；摘要使用 `Responses:SummarizerModel`。所有 create 可携带稳定 `Idempotency-Key` 作为追踪字段，但无状态 DeepSeek 不依赖它恢复；DeepSeek 只对明确的 429 做有限重试，网络、超时和 5xx 不重试，OpenAI 保持原有瞬时重试。实现参考官方 [Responses create](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)、[retrieve](https://developers.openai.com/api/reference/cli/resources/responses/methods/retrieve) 与 [OpenAI .NET SDK](https://www.nuget.org/packages/OpenAI/)。
- Responses Worker：只领取 `WorkerKind.Responses`，不读取 Device、allowed roots 或 Codex runtime。外部 Response ID 落 TaskExecution；queued/in-progress 可跨 scope 与过期 lease 恢复，cancel、failed、incomplete、unknown 均 fail closed，终态与 TaskEvent、Notification、Outbox 同事务写入。
- 安全错误边界：provider 原始错误正文不进入 Task、TaskEvent、Notification 或 Outbox；用户只收到按有限状态映射的固定安全摘要。
- 会话摘要：新增 `ConversationSummaries`、`Conversation.CurrentSummaryId`、连续 FromSequence/ToSequence 与累计摘要。新摘要包含旧累计摘要和新增消息；成功后原子切换 current summary 并写 `conversation.summaryUpdated`。provider 失败时不修改原消息或 CurrentSummaryId。
- 上下文组合：bootstrap 加载当前摘要、摘要后的已完成消息、当前用户的非终态任务、未读终态结果与 active 非敏感 Memory Fact。固定规则不裁剪；偏好、摘要、消息、任务/结果、记忆分别受预算约束。ContextVersion 只汇总当前用户可见事实。
- 显式记忆：新增 MemoryFact 领域模型、认证 API、SQLite active 唯一索引、幂等 save/retract、同 key 原子 supersede、来源 MessageId、置信度、敏感标记与 LastConfirmedAt。只有当前用户明确“记住/remember”的 User 消息可作为来源；敏感事实默认拒绝且不注入上下文。
- Router 与客户端：本地文件、写文件、命令继续路由 Codex；network research、deep reasoning、summary、structured output 路由 Responses；空能力保持 Internal，未知能力拒绝。Realtime `remember_fact` 已替换 unavailable stub，并通过 Desktop Main/Preload 的认证薄代理调用后端，Renderer 不持有 bearer。
- 合同与数据库：新增两份 Phase 5 EF migration，更新 OpenAPI、生成 TypeScript contract、API client、Desktop 类型和 lockfile。OpenAPI 当前包含 30 个 paths。

## 独立审查修复

独立双轴审查最终通过，Standards 与 Spec 均无阻塞。审查期间发现并修复：provider 原始错误可能持久化；Responses SDK adapter 缺少受控 HTTP 合同测试；Memory 缺少跨用户、敏感与并发 SQLite 证明；无状态网络异常未进入有限重试；Realtime 正文和 ContextVersion 的 Task/Notification 查询未完整限制当前用户。

## 实际验证

```text
dotnet restore Jarvis.sln --locked-mode                              PASS
dotnet list Jarvis.sln package --vulnerable --include-transitive     PASS (12 projects, no vulnerable packages)
dotnet build Jarvis.sln -c Release --no-restore                      PASS (0 warning, 0 error)
dotnet test Jarvis.sln -c Release --no-build --no-restore            PASS (273/273)
  Infrastructure 39; Domain 26; Architecture 4; DeviceNode 43;
  Application 18; API integration 135; E2E 8
dotnet format Jarvis.sln --no-restore --verify-no-changes            PASS
dotnet ef migrations has-pending-model-changes ...                   PASS (no pending model changes)

dotnet test tests/backend/Jarvis.Infrastructure.Tests/Jarvis.Infrastructure.Tests.csproj -c Release --no-build --no-restore PASS (39/39)
dotnet test tests/backend/Jarvis.Api.IntegrationTests/Jarvis.Api.IntegrationTests.csproj -c Release --no-build --no-restore --filter FullyQualifiedName~Phase5ResponsesWorkerTests PASS (13/13)
dotnet test tests/backend/Jarvis.Api.IntegrationTests/Jarvis.Api.IntegrationTests.csproj -c Release --no-build --no-restore --filter FullyQualifiedName~Phase5SummaryWorkerTests PASS (3/3)

pnpm install --frozen-lockfile                                       PASS
pnpm typecheck                                                       PASS
pnpm lint                                                            PASS
pnpm test                                                            PASS (67/67: 4 + 12 + 3 + 48)
pnpm build                                                           PASS
pnpm check:openapi                                                   PASS (30 paths; byte-for-byte stable)
pnpm check:codex-schema                                              PASS (275 files; 90/70/10 unions)
pnpm check:codex-schema-canonical                                    PASS (275 files)
pnpm test:codex-schema-canonical                                     PASS (2/2)
pnpm check:secrets && pnpm test:secret-scan                          PASS (1/1)
pnpm test:service-manifest                                           PASS (19/19)
git diff --check                                                     PASS
```

实际工具版本：.NET SDK `10.0.100`、pnpm `10.24.0`、Codex `0.146.0`。本机 Node 为 `25.0.0`，与仓库锁定的 `24.19.0` 不同，因此 pnpm 保留 engine warning；所有代码门禁仍通过。pnpm 还报告 `electron`、`esbuild` build scripts 被当前安装策略忽略。

## 影响与回滚

- API 影响：新增 `POST /api/v1/memory-facts` 与 `POST /api/v1/memory-facts/{memoryId}/retract`；写操作要求 Local bearer 与 `Idempotency-Key`。Router 对 deep reasoning、network research、summary 和 structured output 的执行方改为 Responses。
- 配置影响：`OpenAI` 只保留 Realtime/client-secret 所需的 ApiKey、BaseUrl、RealtimeModel、Voice、AllowedVoices、SafetyIdentifierSalt、ClientSecretLifetimeSeconds；`Responses:Provider/Model/SummarizerModel/TimeoutSeconds/MaxTransientRetries/PollingIntervalMs` 为启动必填。安全配置写入器按 provider 使用 `gpt-4.1-mini`（OpenAI）或 `deepseek-v4-flash`（DeepSeek）默认模型。选择 `DeepSeek` 时额外要求 `DeepSeek:ApiKey` 与 `DeepSeek:BaseUrl`；选择 `OpenAI` 时不要求 DeepSeek 凭据。API Key 仍只存在于可信后端。
- 数据库影响：新增 ConversationSummary、MemoryFact、current summary 外键和 active memory 唯一约束。回滚前应先停止 Responses/Summary worker，确认没有 Running/Recovering Responses execution，再按相反顺序回退 Phase 5 migrations 并恢复旧二进制。
- 运行回滚：若外部 provider 异常，可禁用 Responses/Summary worker；原 Task、Message、旧 Summary 和 MemoryFact 保留审计，不应通过改写原消息或放宽敏感策略恢复服务。

## 未解决项与风险

- 当前环境没有 `OPENAI_API_KEY`，未执行真实 OpenAI Responses smoke；本阶段的 provider 边界证明来自官方 SDK 发出的受控 HTTP 请求和 scripted runtime，不能冒充真实账户或线上 provider 证明。
- 未执行生产数据库迁移、生产部署、线上认证基础设施、真实 Realtime Session 轮换或真实 OpenAI 账户验证。
- 本机 Node 版本偏差需在固定 Node `24.19.0` 的 CI/发布环境再次确认；发布环境也应明确允许或构建 `electron`、`esbuild` 的安装脚本。

本阶段将提交并推送到当前 `main` 分支。Phase 6 可在保留现有事实来源、权限边界与受控 provider adapter 的前提下继续实现 circuit breaker、可观测性、日志治理、安装与发布能力。
