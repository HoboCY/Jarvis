# Phase 1 实施报告：Control Plane 基础

## 结果

Phase 1 计划中的本地代码范围已完成：真实 SQLite/EF Core migration、单用户 Bearer 认证、Conversation API、typed message 数据库幂等、认证 SignalR ClientHub、SQLite Outbox 与 SignalR publisher adapter、重启恢复、OpenAPI/TypeScript 生成物、CI migration drift 检查和集成回归测试均已落地。所有持久化时间通过内置 `TimeProvider` 生成 Unix ms；`Idempotency-Key`、`ClientRequestId` 和 `Title` 的应用校验分别与 EF 上限 200、200、500 对齐。

本报告只记录本机实际执行的结果；没有把 GitHub Actions、Node 24.19.0 或生产环境验证写成本地已验证。

## 文件变更分组

- 依赖与门禁：`Directory.Packages.props`、`.config/dotnet-tools.json`、三个 backend 项目文件、相关 `packages.lock.json`、`.github/workflows/ci.yml`。
- Domain：`src/backend/Jarvis.Domain/{Identity,Devices,Conversations,Idempotency,Outbox}/`；包含 User、Device、Conversation、Message、IdempotencyRecord、OutboxMessage，Domain 未引用 EF。
- Contracts/Application：`src/backend/Jarvis.Contracts/ConversationContracts.cs`、`src/backend/Jarvis.Application/{Conversations,Identity,Outbox}/`；应用层只暴露 Conversation store 和 Outbox 外部边界。
- Infrastructure：`src/backend/Jarvis.Infrastructure/{Data,Conversations,Outbox,Idempotency}/`、`InfrastructureServiceCollectionExtensions.cs`；包含 DbContext、启动迁移/seed、EF store、dispatcher、options，以及由 `dotnet ef migrations add` 生成的 `Data/Migrations/20260825155259_Phase1Initial*`、`20260825165722_Phase1ReviewFixes*` 和 model snapshot。
- API：`src/backend/Jarvis.Api/{Authentication,Conversations,Outbox,Realtime}/`、`Program.cs`、API 项目文件；包含配置校验的本机 Bearer、ProblemDetails、Conversation endpoints、ClientHub 和 SignalR publisher。
- 测试：`tests/backend/Jarvis.Api.IntegrationTests/` 新增真实临时 SQLite 的 Conversation、SignalR、Outbox、schema、重启持久化和配置失败测试，并扩展 API smoke test；并发幂等测试在事务外先同步两个读取，再验证数据库唯一键竞争后的 replay 和单条落库。
- 合同与脚本：`eng/scripts/generate-openapi.mjs` 使用随机临时 token/SQLite 并在退出时清理；更新 `artifacts/openapi/openapi.json`、`packages/contracts-ts/src/generated/openapi.ts`，以及 `packages/contracts-ts/src/outbox.ts` 的 SignalR envelope 解码合同测试。
- 本报告：`docs/phases/phase-1-report.md`。

## TDD RED/GREEN 证据

首个未认证 API 测试先运行：

```text
dotnet test tests/backend/Jarvis.Api.IntegrationTests/Jarvis.Api.IntegrationTests.csproj --no-restore --configuration Debug
```

RED：1 failed、1 passed；Conversation POST 预期 `401 Unauthorized`，起始骨架实际返回 `404 NotFound`。随后实现认证和 API 后，该测试随集成套件 GREEN。

后续垂直切片的 GREEN 证据：

- schema/migration：真实 SQLite migration 应用、六张表和无 pending migration 测试通过（`SchemaTests` 1/1）。
- Conversation：create/detail、消息 descending cursor page、所有权、create replay/conflict、typed replay/conflict 和并发同键测试通过。
- SignalR/Outbox：认证与未认证 Hub handshake、真实 publisher 成功 `PublishedAtMs`、失败保留并递增 attempt/next attempt/error 测试通过。
- 恢复/配置：同一 SQLite 文件重建 host 后 Conversation/Message 保留；缺失或短 token 启动失败且不会在异常中出现 token，测试通过。

本次 review 修复也遵循先 RED 后 GREEN：浏览器 negotiate query token、create replay 的 `201 + Location`、camelCase enum JSON、OpenAPI bearer security、24h idempotency 过期复用等断言均先在旧实现上失败，随后对应目标测试通过；两个真实 SQLite 受控并发测试在两个初始 idempotency 读取后放行，最终 create/typed 均 GREEN，数据库各保留一条记录。过期 key 测试覆盖 create 新建、typed key 复用但 `ClientRequestId` 仍唯一，以及并发过期 key 只新建一条并 replay。早期读闸门曾因事务包住读取而只放行一个请求并超时，已改为事务外读取并加入 5 秒超时与失败释放，未保留挂起屏障。

## 实际验证命令与结果

后端：

```text
dotnet restore Jarvis.sln --locked-mode                         PASS
dotnet tool restore                                             PASS (dotnet-ef 10.0.11)
dotnet build Jarvis.sln --configuration Debug --no-restore       PASS (0 warnings, 0 errors)
dotnet build Jarvis.sln --configuration Release --no-restore     PASS (0 warnings, 0 errors)
dotnet test Jarvis.sln --configuration Debug --no-build --no-restore   PASS (本次 expiry 修复前 37 total; integration 29)
dotnet test Jarvis.sln --configuration Release --no-build --no-restore PASS (expiry 修复后 40 total; integration 32)
dotnet test tests/backend/Jarvis.Api.IntegrationTests/Jarvis.Api.IntegrationTests.csproj --configuration Debug --no-restore PASS (expiry 修复后 32/32；受影响测试 3/3)
受控 create/typed 幂等竞争的三个 Release 测试连续运行 10 轮             PASS (10/10)
pnpm --filter @jarvis/contracts-ts typecheck && pnpm --filter @jarvis/contracts-ts test && pnpm --filter @jarvis/contracts-ts lint PASS (3 tests)
dotnet format Jarvis.sln --verify-no-changes --no-restore         PASS
dotnet list Jarvis.sln package --vulnerable --include-transitive PASS (no vulnerable packages reported)
dotnet ef migrations has-pending-model-changes \
  --project src/backend/Jarvis.Infrastructure/Jarvis.Infrastructure.csproj \
  --startup-project src/backend/Jarvis.Api/Jarvis.Api.csproj \
  --context Jarvis.Infrastructure.Data.JarvisDbContext                  PASS
```

EF drift 命令输出 `No changes have been made to model since last migration.`；初始 migration 是通过 `dotnet ef migrations add Phase1Initial ...` 生成的，不是手写 migration。

前端/契约/安全矩阵：

```text
pnpm install --frozen-lockfile                   PASS (本机 Node 25 engine warning)
pnpm typecheck                                   PASS
pnpm lint                                        PASS
pnpm test                                        PASS
pnpm build                                       PASS
pnpm generate:openapi                            PASS
pnpm check:openapi                               PASS (generated files byte-for-byte unchanged)
pnpm check:codex-schema                          PASS (275 JSON files)
pnpm check:codex-schema-canonical                PASS (275 JSON files)
pnpm test:codex-schema-canonical                 PASS (2 tests)
pnpm check:secrets                               PASS
pnpm test:secret-scan                            PASS (1 test)
pnpm --filter @jarvis/desktop test               PASS (3 tests)
```

本阶段的审查固定点是 `6ebcf6c9c9cf61440b629866f5a842ffee526ac9`。权威长规范未改，SHA-256 为 `0639c54ffeb94f8d04f76536d5af7f3fce078fcccc79f113dd523c33f683221d`。`.DS_Store`、`AGENTS.md`、`docs/agents/` 均未修改；`docs/phases/phase-1-plan.md` 是主代理在本阶段开始前创建的阶段输入，本 worker 保留其内容不变。

## 风险与未验证项

- 本机 Node 为 25.0.0，因而所有 pnpm 命令带 engine warning；CI 定义的 Node 24.19.0 尚未在本机运行，也没有宣称 GitHub Actions 已通过。
- SQLite 是 V1 单机持久化方案；Outbox dispatcher 通过 SQLite claim lease 防止同一数据库上的重叠领取并提供本地 at-least-once 基座，尚未承诺多实例/PostgreSQL 的租约、分布式锁或运行验证。
- `IdempotencyRecords.ExpiresAtMs` 按配置使用 24 小时 retention；请求按 key 惰性删除/替换已过期记录，未复用的过期记录不会被后台全表清扫，本阶段不提供后台 sweeping cleanup。
- Bearer token 是本机单用户基础，不是 JWT、注册或密码系统；Token 只从必需配置读取，生产 secret 管理和部署注入仍是后续工作。
- SignalR publisher 已在 TestServer client handshake 和真实 SQLite Outbox 流程中验证，但尚未做跨进程/生产网络验证。
- 本阶段未实现 Realtime client secret/session、WebRTC、ContextAssembler、event ingest、Tasks、Approvals、Notifications、Device lease、Codex/Responses worker 或 Desktop Conversation UI。

## Phase 2 前置

Phase 2 可直接复用本阶段的 User/Conversation/Message/Outbox migration、所有权边界、typed message 幂等和 SignalR publisher seam；开始前需明确 Realtime client secret 的配置/授权边界、Realtime Session 生命周期、WebRTC/音频输入、ContextAssembler 输入输出及 event ingest 的外部事件幂等与恢复策略。
