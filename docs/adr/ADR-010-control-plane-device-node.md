# ADR-010：Control Plane 与 Device Node 逻辑分离

- 状态：已接受
- 决策：Control Plane 持有用户、Conversation、Task、Approval、Notification 的事实状态；每台电脑的 Device Node 负责注册、租约、Codex 监管和本地能力执行。
- 原因：本地任务需要设备能力和最小权限，但不能把主任务状态写死在 API 进程或执行节点内存中。
- 影响：任务通过 DeviceId、租约、心跳和能力声明路由；节点重启后由 Control Plane 决定恢复、重试或失败。
