# ADR-001：C#/.NET 作为主后端

- 状态：已接受
- 决策：Control Plane 与 Device Node 使用 C#/.NET 10、ASP.NET Core 10；桌面和移动 UI 不使用 C#。
- 原因：ASP.NET Core、SignalR、BackgroundService、EF Core、进程管理与官方 OpenAI .NET SDK 覆盖 V1 的后端边界。
- 影响：业务状态、权限、任务和通知由 C# 后端持有；TypeScript 只负责客户端 UI 与实时传输。
