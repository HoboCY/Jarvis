# ADR-006：Codex App Server 作为受控后台执行器

- 状态：已接受
- 决策：本地文件、命令和代码任务由 C# Device Node 通过 stdio JSON-RPC 控制 Codex App Server；固定版本并保存 schema 契约。
- 原因：Codex 执行本地任务，但不拥有 Jarvis 的主会话、任务、记忆、通知或审批事实来源。
- 影响：任务能力、allowed roots 和审批由 Control Plane 限定；协议通过窄适配器隔离，V1 不把 Codex DTO 放进 Domain。
