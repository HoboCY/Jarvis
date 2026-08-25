# ADR-009：不使用泛型 Repository 和重量 Agent Framework

- 状态：已接受
- 决策：EF Core 直接承担 Unit of Work 和数据访问；仅为真实外部边界定义端口；Phase 0-6 不引入完整 Agent Framework 作为核心依赖。
- 原因：避免隐藏查询语义、无替换价值的接口和过早框架耦合；显式 Application 用例更符合模块化单体边界。
- 影响：Domain 不依赖 EF/OpenAI/SignalR/Codex；Fake 只能位于明确 Adapter 之后并服务于契约测试。
