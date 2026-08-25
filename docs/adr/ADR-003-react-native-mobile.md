# ADR-003：React Native 作为移动 UI

- 状态：已接受
- 决策：移动端后续采用 React Native + TypeScript，并使用自有 Native WebRTC transport；不直接复用浏览器版 WebRTC transport。
- 原因：麦克风权限、音频路由、前后台生命周期和原生 WebRTC 能力需要移动端原生桥接。
- 影响：移动端不阻塞 Desktop MVP；共享合同和 Agent 层，移动传输层独立实现。
