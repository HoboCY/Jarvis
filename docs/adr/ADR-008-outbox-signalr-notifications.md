# ADR-008：Outbox + SignalR 应用内通知

- 状态：已接受
- 决策：任务结果、失败、审批和取消先与数据库业务状态在同一事务写入 Notification/Outbox，再通过 SignalR 推送；客户端重连后主动补拉。
- 原因：SignalR 单次消息不是可靠事实来源；持久化通知可以在断线和进程重启后补发。
- 影响：通知至少一次投递，客户端按 NotificationId 去重；V1 不承诺应用退出后的系统 Push。
