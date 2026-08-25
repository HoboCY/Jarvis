# ADR-005：语音和文字共享逻辑 Conversation

- 状态：已接受
- 决策：语音和文字输入进入同一个逻辑 Conversation；Realtime Session 只是可轮换的短生命周期连接，文字默认请求 text-only 输出。
- 原因：跨模态指代和上下文连续性依赖统一事实来源，不能维护两套会话历史。
- 影响：Conversation、Message、摘要和记忆由 C# 数据库持久化；Session 轮换不会丢失逻辑上下文。
