# ADR-002：Electron + React 作为桌面 UI

- 状态：已接受
- 决策：桌面端采用 Electron、React、TypeScript，分离 Main、Preload、Renderer 进程和 TypeScript 配置。
- 原因：需要 WebRTC、麦克风、应用内通知、系统托盘和受限操作系统能力，同时保持 UI 不依赖 C#。
- 影响：Renderer 使用严格安全边界；高权限行为只能通过白名单 Preload IPC。
