# Phase 0 计划：仓库与架构骨架

## 目标

建立可重复构建、可验证的 Jarvis V1 monorepo 骨架；只实现 Phase 0 的边界，不实现会话、任务、记忆、通知或 Codex 业务流程。

## 具体文件与范围

- 根配置：`.gitignore`、`global.json`、`Directory.Build.props`、`Directory.Packages.props`、`NuGet.config`、`Jarvis.sln`、`eng/versions.json`。
- 后端：`src/backend/Jarvis.{Api,Application,Domain,Infrastructure,DeviceNode,Contracts}/`，以及 `tests/backend/Jarvis.*.Tests/`；建立 .NET 10 项目、最小健康端点、内置 ProblemDetails/OpenAPI 占位、清晰项目引用方向和架构测试。
- 桌面端：`src/clients/desktop/`；建立 Electron Main、Preload、React Renderer 三个独立 TypeScript 配置，严格 Electron 安全窗口配置和自动化安全测试。
- 共享包：`packages/contracts-ts/`、`packages/api-client-ts/`、`packages/realtime-agent/`；建立 pnpm workspace、严格 TypeScript、lint/test/build/typecheck 脚本。
- 合同生成：`eng/scripts/generate-openapi.mjs`、`eng/scripts/check-openapi-diff.mjs`、`eng/scripts/check-codex-schema.mjs`、生成的 `packages/contracts-ts/src/generated/openapi.ts`。
- Codex 契约：`artifacts/codex-schema/0.146.0/`，由固定的 Codex 0.146.0 实际生成，不手工复制。
- 文档：`docs/architecture/implementation-assumptions.md`、`docs/adr/ADR-001.md` 至 `ADR-010.md`、`docs/phases/phase-0-report.md`。
- CI/E2E：`.github/workflows/ci.yml`、`tests/e2e/README.md`；CI 覆盖 locked restore/build/test、pnpm frozen install、TS checks、OpenAPI diff、Codex schema、secret scan 和 Electron security test。

## 验收条件

1. `dotnet restore --locked-mode`、后端 build 和全部后端测试真实通过。
2. ArchitectureTests 真实检查 Domain 不引用 Infrastructure，且项目引用方向符合基线。
3. Desktop 可 build；自动化测试真实断言 `contextIsolation=true`、`nodeIntegration=false` 和无任意导航/IPC 越权配置。
4. `pnpm install --frozen-lockfile` 后，三个共享包及 Desktop 的 typecheck、lint、test、build 命令真实可运行。
5. OpenAPI 占位服务可启动；脚本实际生成 OpenAPI JSON 和 TypeScript 合同，重复生成无差异，枚举来源于 OpenAPI。
6. Codex 0.146.0 的 `generate-json-schema` 产物可解析，离线检查覆盖 `initialize`、`thread/start`、`turn/start`、`turn/interrupt`。
7. CI 文件包含所有 Phase 0 质量门禁；报告不把未运行的 GitHub Actions 写成通过。
8. 报告列出改动、实际命令与结果、未解决项、风险和 Phase 1 前置；明确本机 Node 25 与锁定 Node 24.19.0 的偏差。

## TDD 顺序

1. 先创建架构测试并运行预期失败的 RED，证明缺失的项目骨架不满足依赖方向。
2. 创建最小 .NET 项目和引用，运行同一测试得到 GREEN。
3. 以同样的垂直切片补齐 Electron 安全测试、共享包契约测试、OpenAPI 生成检查和 Codex schema 检查。
4. 最后运行完整相关验证并记录原始结果。

## 明确不做

Phase 0 不实现数据库实体/迁移、认证、Realtime 会话、任务状态机、Outbox、SignalR 业务、Responses Worker、Codex 执行器或移动端业务。
