# Jarvis V1 完整架构设计与 Codex 执行规范

[下载完整 Markdown 架构与执行文档](sandbox:/mnt/data/jarvis_v1_architecture_and_codex_execution_spec.md)

**文档版本：** 1.0  
**编制日期：** 2026-08-24  
**文件 SHA-256：** `0639c54ffeb94f8d04f76536d5af7f3fce078fcccc79f113dd523c33f683221d`

文档共 30 个主要章节，已经明确：

- C# 仅作为后端和本地 Device Node，不承担桌面或手机 UI；
- 桌面端采用 Electron、React、TypeScript；
- 手机端采用 React Native、TypeScript 和自有 Native WebRTC transport；
- 实时语音与文字输入共享同一个逻辑 Conversation；
- 文字输入默认触发 text-only Realtime response；
- 复杂任务立即委派后台，不阻塞实时交流；
- C# 数据库中的 Conversation、Task、Approval、Notification 才是事实来源；
- Codex App Server 只是受控后台执行器；
- V1 不实现日历、定时提醒、系统 Push 和唤醒词；
- 通知采用数据库持久化、Outbox、SignalR 和应用内弹窗；
- Codex 接入采用固定二进制、stdio JSON-RPC、生成 schema 和契约测试；
- 实施拆为 Phase 0–7，每个阶段都有交付物和可验证验收条件。

## 交给 Codex 时附上的启动指令

> 严格以附件《Jarvis V1 完整架构设计与 Codex 执行规范》为实现基线。先完整阅读文档，扫描当前仓库和本机环境，输出实际检测到的 .NET、Node、pnpm、Codex 版本及 Phase 0 文件计划，然后直接从 Phase 0 开始执行。不得修改文档中的锁定技术决策，不得提前大规模实现后续阶段。所有 build、test 和协议检查必须实际运行，每阶段完成后生成对应的 `docs/phases/phase-X-report.md`。