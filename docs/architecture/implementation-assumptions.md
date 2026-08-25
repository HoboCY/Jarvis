# Phase 0 实现假设

本文只记录基线无法确定、且实现必须明确的环境事实；锁定架构决策仍以 `docs/jarvis_v1_architecture_and_codex_execution_spec.md` 为准。

- 当前开发机为 macOS arm64；已安装 .NET SDK `10.0.100`。
- 当前本机 Node 为 `25.0.0`，不是 Node 24 LTS；没有安装 Node `24.19.0`。仓库配置和 CI 仍锁定 Node `24.19.0`，本机 Node 25 造成的偏差必须在阶段报告中保留。
- 当前 pnpm 为 `10.24.0`，用于生成并验证 workspace lockfile。
- 当前 Codex CLI 为 `0.146.0`；Phase 0 以 `codex app-server generate-json-schema --out <dir>` 生成版本绑定的 schema。
- Codex 原生 darwin-arm64 二进制 SHA-256 为 `ae1d3ffe6d48aec6a4dc3f50e7eb8e0d11962485a6a9406c5a7012139383da02`；该值由任务输入提供，供版本清单和 CI 复核。
- Phase 0 在离线/占位边界内验证 OpenAPI 生成链路；实际 OpenAI、Realtime、SignalR、SQLite、Device Node 和 Codex 业务集成属于后续阶段。
- CI 使用 Node 24.19.0，且会从干净环境执行 frozen lockfile；本机因为 Node 25 不具备与 CI 完全一致的运行时证明。
