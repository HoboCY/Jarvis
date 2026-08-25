# ADR-004：Realtime 使用客户端 WebRTC 直连

- 状态：已接受
- 决策：V1 由 Desktop/Mobile 客户端通过 WebRTC 连接 OpenAI Realtime API；C# 后端只签发短期 client secret 和提供薄工具 API，暂不引入 sideband。
- 原因：音频不经过 C# 转发，降低延迟和后端媒体复杂度；后端仍保留凭据与权限边界。
- 影响：短期 secret 不落日志或数据库；Session 与持久化 Conversation 必须解耦。
