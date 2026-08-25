# Phase 0 报告：仓库与架构骨架

## 结果

Phase 0 的本地代码骨架已实现并通过本机可执行验证，本报告随 Phase 0 提交纳入版本控制；GitHub CI 结果以对应提交的 Actions 记录为准。没有实现 Phase 1+ 的数据库实体、认证、Realtime 业务、任务状态机、通知、Responses Worker 或 Codex 执行器。

## 改动文件分组

- 根构建与版本：`Jarvis.sln`、`global.json`、`Directory.Build.props`、`Directory.Packages.props`、`NuGet.config`、`package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、`tsconfig.base.json`、`.gitignore`、`eng/versions.json`。
- .NET 骨架：`src/backend/Jarvis.Api`、`Jarvis.Application`、`Jarvis.Domain`、`Jarvis.Infrastructure`、`Jarvis.DeviceNode`、`Jarvis.Contracts`；六个测试项目位于 `tests/backend/`。
- 桌面端：`src/clients/desktop/`，分离 Main/Preload/Renderer tsconfig，Electron 安全配置和自动化安全测试。
- TypeScript workspace：`packages/contracts-ts`、`packages/api-client-ts`、`packages/realtime-agent`；OpenAPI 生成文件位于 `packages/contracts-ts/src/generated/openapi.ts`。
- 合同与检查：`eng/scripts/` 下 OpenAPI、Codex schema 结构/确定性规范化、renderer/dist secret scan、secret scan fixtures 和测试；根 `eslint.config.mjs` 提供实际 ESLint 检查；OpenAPI JSON 位于 `artifacts/openapi/openapi.json`。
- Codex 契约：`artifacts/codex-schema/0.146.0/`，由实际 Codex 0.146.0 命令生成并经 canonical JSON 规范化，共 275 个 JSON 文件。
- 文档与 CI：`docs/adr/ADR-001-*` 至 `ADR-010-*`、`docs/architecture/implementation-assumptions.md`、本阶段计划/报告、`.github/workflows/ci.yml`、`tests/e2e/README.md`、`eng/codex/README.md`。

## TDD RED → GREEN 证据

1. RED：先创建 `Jarvis.ArchitectureTests` 测试，恢复测试依赖后运行 `dotnet test tests/backend/Jarvis.ArchitectureTests/Jarvis.ArchitectureTests.csproj --no-restore`；测试真实失败于缺失 `src/backend/Jarvis.Api/Jarvis.Api.csproj`。
2. GREEN：补齐六个后端项目及引用后，使用同一命令运行，3/3 通过；测试实际检查项目引用方向，并从已编译 `Jarvis.Domain` assembly 确认不引用 `Jarvis.Infrastructure`。
3. Electron RED：先把安全测试改为精确入口 URL 和 HTTP(S) 外链契约，旧实现因缺少 `isAllowedExternalUrl` 导出而失败；GREEN：实现精确入口策略和 Main 传入 concrete entry URL 后，`pnpm --filter @jarvis/desktop test` 通过 3/3。
4. Architecture RED：临时向 Domain 加入 `Microsoft.NET.Test.Sdk` PackageReference 后，新增禁依赖测试以 1 个失败、3 个通过结束；移除临时依赖并 restore 后 GREEN 为 4/4，未保留该临时包。
5. Electron 精确性加固 RED：新增路径规范化、`app:`、远程同 URL 和本地开发 URL 测试后，旧的 URL 规范化比较使测试 1 个失败、2 个通过；GREEN：改为原始 URL 精确匹配并限制入口为 `file:` 或本地 HTTP(S)，测试恢复为 3/3。
6. Codex canonical RED：先加入未实现 canonicalizer 的负例测试，`node --test eng/scripts/codex-schema-canonical.test.mjs` 因缺少模块失败；GREEN：实现递归 object 键排序、保持 array 顺序、2 空格和尾换行后，负例目录检查被拒绝、规范化目录通过，测试 2/2。

## 实际验证命令与结果

以下命令均在本机实际执行并通过：

- `dotnet restore Jarvis.sln --locked-mode`：12 个 .NET 项目 locked restore 通过。
- `dotnet build Jarvis.sln --no-restore`：通过，0 warning、0 error。
- `dotnet test Jarvis.sln --no-restore --no-build`：通过，9 个测试通过（5 个骨架测试 + 4 个架构测试）。
- `dotnet build Jarvis.sln --configuration Release --no-restore` 与对应 Release `dotnet test`：通过，0 warning、0 error，9 个测试通过；用于验证 Release-only warnings-as-errors。
- `pnpm install --frozen-lockfile`：通过，lockfile 无变更。
- `pnpm typecheck`：通过，4 个 workspace 项目完成严格 TypeScript 检查。
- `pnpm lint`：通过，实际执行 ESLint 9 flat config + TypeScript ESLint。
- `pnpm test`：通过，三个共享包和桌面安全测试通过（共 7 个 Node 测试用例）。
- `pnpm build`：通过，三个共享包和 Desktop Main/Preload/Renderer 均成功编译。
- `pnpm --filter @jarvis/desktop build`：通过，并复制 Renderer `index.html` 到可加载的 `dist/renderer`。
- `pnpm check:openapi`：通过；实际启动 ASP.NET Core API、读取 `/openapi/v1.json`、运行 `openapi-typescript`，生成文件无差异。
- 在两个生成文件均处于 intent-to-add（`git status --short` 为 `A`）的当前首次提交场景下运行上述 `pnpm check:openapi`，仍通过 byte-for-byte 比较。
- `codex app-server generate-json-schema --out artifacts/codex-schema/0.146.0`：通过，实际生成版本绑定 schema。
- `pnpm check:codex-schema`：通过，275 个 JSON 可解析，权威 `ClientRequest.json` 的 90 个 method union 成员可解析，并精确校验 `initialize`、`thread/start`、`turn/start`、`turn/interrupt` 的 params 结构。
- `node eng/scripts/canonicalize-codex-schema.mjs artifacts/codex-schema/0.146.0`：通过，将 275 个已签入 schema 规范化为递归 object 键排序、array 原序、2 空格缩进和单尾换行。
- `pnpm check:codex-schema-canonical`：通过，固定版本目录 275/275 文件均为 canonical JSON。
- `pnpm test:codex-schema-canonical`：通过，2/2；包含未排序/未规范化文件的失败负例和 array 顺序保持断言。
- 使用同一 Codex 0.146.0 生成到 `mktemp -d`，对临时目录和签入目录分别执行 `canonicalize-codex-schema.mjs` 后运行 `diff -ru`：通过，275 文件树递归字节一致；临时目录已清理。
- `pnpm check:secrets`：通过，扫描 `src/**`、`packages/**` 及已构建的 renderer/dist JavaScript，覆盖 `sk-proj-`、service/admin、legacy key 和 API key assignment 规则。
- `pnpm test:secret-scan`：通过，正例 modern project key 被发现，redacted 负例被接受。
- `pnpm --filter @jarvis/desktop test`：通过，Electron 安全配置、精确入口导航和 HTTP(S) 外链测试 3/3 通过。
- `git diff --check -- . ':(exclude)docs/jarvis_v1_architecture_and_codex_execution_spec.md' ':(exclude)docs/Jarvis V1 完整架构设计与 Codex 执行规范.md' ':(exclude).DS_Store'`：通过；另用 `rg --hidden -n '[[:blank:]]+$'` 检查工作区 Phase 0 文件且排除构建目录、两份规范和 `.DS_Store`，无结果。检查排除了原始规范中的 Markdown 强制换行；两份规范未修改，长规范 SHA 保持基线值。

## 未解决项与风险

- GitHub Actions 未在本机执行；CI 文件已覆盖 locked restore、backend build/test、frozen pnpm、typecheck/lint/test/build、OpenAPI diff、Codex schema 结构/确定性检查、renderer/dist secret scan、fixture regression 和 Electron security test，不能把 CI 写成已通过。
- Codex schema 生成器输出的 object 键顺序并非稳定字节顺序；生成流程必须继续执行 canonicalizer，CI 的结构检查和 canonical 检查共同阻止协议或生成过程漂移。
- `pnpm check:openapi` 的差异检查直接比较生成前后的原始 bytes，不依赖 Git index，因此首次提交、intent-to-add 和普通 untracked 状态都不会假通过。
- 本机只有 Node `25.0.0`，没有 Node `24.19.0`；本地 pnpm 命令均出现 engine warning，但实际通过。仓库和 CI 已锁定 Node `24.19.0`，因此 Node 24 运行时兼容性仍需 CI 实机确认。
- OpenAPI 使用 `Microsoft.AspNetCore.OpenApi 10.0.11`，避免 .NET 10.0.0 链路带入的已知 `Microsoft.OpenApi 2.0.0` 高危告警；后续升级仍需重新执行 NuGet audit 和生成差异检查。
- 当前 Codex 验证只证明固定 0.146.0 schema 合同和离线 JSON 解析，不证明真实任务执行、审批、恢复或外部服务可用性。
- ESLint 已锁定 9.35.0，使用 TypeScript ESLint 8.42.0；当前配置覆盖 TS/TSX 和 Renderer 禁止 Node 内置模块、危险 Electron 配置等边界，尚未引入专门的 React Hooks 规则集。
- `.DS_Store` 和两份架构规范输入未修改；`.DS_Store` 未纳入版本控制。

## Phase 1 前置

1. 在保持 Domain/Application/Infrastructure/API 边界的前提下加入 EF Core 10、SQLite、迁移和真实关系约束。
2. 建立单用户认证基础、Users/Devices/Conversations/Messages 数据模型和 Conversation API。
3. 实现 ProblemDetails、typed message 幂等和 Outbox；SignalR ClientHub 只作为持久化通知的传输层。
4. 用真实临时 SQLite/TestServer 集成测试替代当前 Phase 0 的 assembly/placeholder 测试，并继续保留架构测试和生成合同门禁。
