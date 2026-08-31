# Phase 5 计划：Responses Worker、会话摘要与显式记忆

## 目标

在 Phase 4 的持久化 Task、TaskExecution、Conversation、Message、Notification 与 Realtime bootstrap 基座上，打通“纯文本任务入队 → Control Plane 内 Responses Worker 执行 → 外部 Response ID 映射 → 结果与通知落库”，并让长会话通过 Conversation Summary、分区 token 预算和显式 Memory Fact 在 Realtime Session 轮换后继续。Jarvis 数据库中的 Task、Conversation、Message、Summary 与 MemoryFact 始终是事实来源；OpenAI Response、Realtime Session 和前端内存都不是事实来源。

## 本阶段范围

- 引入官方 `OpenAI` .NET SDK 的 Responses Client，并固定当前稳定包版本；新增窄 `IResponsesRuntime` create 端口、可选 `IStoredResponsesRuntime` 生命周期端口和 Infrastructure adapter。日常 Responses provider/model/timeout/retry/polling 由 `Responses:*` 配置，摘要使用 `Responses:SummarizerModel`；标准 OpenAI 与 DeepSeek API Key 只留在可信后端。
- OpenAI Responses 调用使用后台响应、持久化查询、取消、超时、有限瞬时重试和稳定 Idempotency-Key；DeepSeek create 使用同步终态，非终态立即 fail closed，不依赖服务端 retrieve/cancel 或幂等恢复。TaskExecution 保存 provider Response ID；Jarvis TaskId 仍是用户可见主 ID。
- 新增独立 Responses Worker，只领取 `WorkerKind.Responses` 的任务，不依赖 Device 注册、DeviceHub、Codex 或 allowed roots；Fake Worker 收窄为只执行 Internal 任务。
- Responses Worker 以数据库状态恢复 queued/running/cancellationRequested 任务；创建、查询、取消和终态回写均经 lease/fencing 检查。成功或失败时与 TaskEvent、Notification、Outbox 同事务写入。
- 新增 `ConversationSummaries` 领域实体、EF 映射、关系约束和 migration；摘要只覆盖已完成且尚未被当前摘要覆盖的消息，成功后原子更新 `Conversation.CurrentSummaryId` 并写 `conversation.summaryUpdated` Outbox。
- 摘要生成失败时不更新 CurrentSummaryId、不删除、不截断、不改写原 Message；下一轮可安全重试。
- Realtime Context bootstrap 加载当前摘要、摘要之后的最近消息、非终态任务、最近未读任务结果和有效 Memory Facts；ContextVersion 同时反映这些持久事实的版本。
- ContextAssembler 保持固定安全规则不可裁剪，并分别限制用户偏好 1,000、摘要 2,000、最近消息 6,000、任务/结果 1,500、Memory Facts 1,500 个估算 token；超限优先丢弃旧消息。
- 新增 `MemoryFacts` 领域实体和 API。`remember_fact` 只接受当前用户明确“记住/remember”消息作为来源；相同 key 的新值在同一事务撤销旧值并以 `SupersedesMemoryId` 指向旧事实。
- 支持显式 retract；Memory 写操作幂等，来源消息必须属于当前用户且为 User 消息。敏感事实默认拒绝，只有后端显式配置允许时才可保存；默认不把敏感事实注入模型上下文。
- 将 Realtime `remember_fact` unavailable stub 替换为认证后端薄代理，返回规范 `{ saved, memoryId }`；Renderer 仍不持有 bearer。
- 完善确定性 Router：本地文件/写入/命令继续优先 Codex；deep reasoning、network research、纯文本结构化输出/总结路由 Responses；内部持久化操作保持 Internal；未知能力继续拒绝。
- 更新 OpenAPI、生成 TypeScript 合同与 API client、测试、版本锁和 `docs/phases/phase-5-report.md`。

## 明确不在本阶段

- Phase 6 的完整 circuit breaker、OpenTelemetry、发布级日志治理、安装器、托盘/Overlay、性能压测和生产服务化。
- Phase 7 的 React Native 客户端、Native WebRTC、移动音频路由和移动配对 UI。
- 隐式从每句话提取长期记忆、向量数据库、知识图谱、自动合并任意语义近似事实；V1 只支持显式 key/value 记忆。
- 让 Responses Worker 访问本地文件、命令或 Device Node；需要这些能力的任务仍必须路由 Codex。
- 把 OpenAI Conversation/Response 当作主会话或主任务，或把完整外部 provider DTO 引入 Domain。

## 公共接口与不变量

- 公共测试 seam 为 Memory/Conversation/Task 领域行为、认证 HTTP API、真实 SQLite/TestServer、`IResponsesRuntime` 契约、Responses Worker 单轮执行、Realtime Context bootstrap 和 Realtime Agent tool backend；不测试私有方法或 SDK 内部调用次数。
- `WorkerKind.Responses` 的 Task 在没有任何 Device 的情况下也能完成；Device API、DeviceHub 和 Codex runtime 不参与该链路。
- 一个有效 Responses lease 最多创建一个外部 Response；重启后凭已持久化 Response ID 查询已有执行，不重复提交。OpenAI Response ID 永远不能替代 TaskId。
- 只有 queued/in-progress Responses 状态可继续轮询；completed 写成功终态，failed/incomplete 写明确失败，cancelled 写取消终态。错误正文只保存适合用户展示的摘要。
- 当前 Summary 的范围必须连续且 `FromSequence <= ToSequence`；新 Summary 只能覆盖旧 Summary 之后的已完成消息。成功切换 CurrentSummaryId 后旧 Summary 保留审计，不修改原消息。
- 每个用户同一 key 同时最多一个 Active MemoryFact；纠正必须在同一事务 retract 旧值并创建指向旧值的新事实。retract 不能影响其他用户事实。
- Context 只读取当前用户所属 Conversation、Task、Notification 和 MemoryFact；旧摘要已覆盖的消息不重复注入。固定规则不裁剪，所有可变部分均受预算限制。
- SignalR/Outbox 只提示 `conversation.summaryUpdated` 等事件；Session 轮换时通过新的认证 bootstrap 读取数据库真相，不依赖推送补历史。

## 实施切片与 TDD 顺序

1. **Memory 领域与持久化**：先写显式来源、敏感策略、同 key supersede、retract、并发唯一 Active fact 和所有权测试，再实现实体、API、store、migration 与 Realtime tool proxy。
2. **Summary 领域与失败隔离**：先写连续范围、成功切换 CurrentSummaryId、Outbox，以及 provider 失败时消息和 CurrentSummaryId 完全不变的 SQLite 测试，再实现 summary store/worker。
3. **Responses Runtime 契约**：先用受控 HTTP/SDK seam 覆盖 background create、retrieve、cancel、输出文本、状态映射、稳定幂等头、超时与有限瞬时重试，再实现官方 SDK adapter。
4. **纯文本 Worker**：先覆盖无 Device 完成、Response ID 持久化、重启恢复查询、取消、失败/不完整、lease fencing 和终态通知，再实现单轮与 hosted loop，并把 Fake Worker 收窄到 Internal。
5. **Context 组合与 Session 轮换**：先通过认证 client-secret bootstrap 证明摘要、摘要后的新消息、非终态任务、未读结果和有效非敏感记忆均被注入且分别不超预算；再扩展查询与 ContextVersion。
6. **Router 与前端薄代理**：先覆盖新增纯文本 capability 规则和 `remember_fact` SDK tool call 的稳定幂等/错误映射，再更新 TS API client、Desktop backend 桥接和合同。
7. **合同与回归**：生成 EF migration、OpenAPI/TS，运行全部 .NET/pnpm/EF/format/schema/secret 门禁；如本机存在安全可用的真实 OpenAI API Key，再执行不含敏感数据的 Responses smoke，否则明确保留 provider 在线验证门禁。

## 验收证据

- 真实 TestServer + 临时 SQLite 证明纯文本任务不注册 Device 也能经过 Responses Worker 到达终态，Response ID、TaskExecution、TaskEvent、Notification 与 Outbox 可在重启后恢复。
- 受控 Responses adapter 测试证明官方 SDK 请求使用 background/store、稳定幂等键和配置模型，并正确查询/取消全部 provider 状态；不以 fake 结果冒充真实 provider 在线证明。
- 长 Conversation 测试生成 Summary 后建立新 Realtime Session，bootstrap 同时包含摘要和未覆盖的新消息；每一可变分区均满足 token 预算，固定安全规则完整保留。
- 摘要 provider 抛错时，原 Message 内容、状态、数量、Conversation.CurrentSummaryId 均不变化。
- Memory API/真实 SQLite 证明明确记忆、同 key 更正、旧值失效、SupersedesMemoryId、retract、并发唯一性、跨用户隔离和敏感默认拒绝。
- Realtime SDK scripted tool 证明 `remember_fact` 经过认证后端并返回持久化 memoryId；重复同一 tool call 不产生重复事实。
- `dotnet restore/build/test/format`、NuGet vulnerability audit、EF migration drift、`pnpm install --frozen-lockfile`、typecheck/lint/test/build、OpenAPI diff、Codex schema和 secret scan 全部通过。

## 风险与回滚

- Responses API 和官方 .NET SDK 会快速变化；只在 Infrastructure adapter 使用 SDK DTO，包版本集中固定并用 adapter 契约测试保护。回滚可恢复旧包和关闭 Responses Worker，不影响已有 Task/Message。
- 外部 create 成功但本地 Response ID 落库前崩溃存在重复提交风险；必须使用稳定 Idempotency-Key，并在任何恢复重试前优先检查已持久化 execution intent/ID。不能证明安全时明确失败，不盲目重放。
- Summary 是派生数据；异常时可禁用 Summary Worker 并继续使用原消息。数据库回滚前先停止 Responses/Summary worker，再按 EF migration 回退。
- Memory 可能包含隐私；默认拒绝 sensitive，日志不得记录 value，context 默认排除 sensitive。策略异常应 fail closed，而不是放宽保存或注入规则。
- 本机 Node `25.0.0` 与仓库固定 `24.19.0` 不一致；前端门禁仍以 frozen lockfile 和 CI 固定版本为准，阶段报告保留环境差异。
