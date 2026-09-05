# Phase 9 计划：发布证据、真机验收与治理

## 方向

Phase 9 将 Phase 8 的本机 unsigned artifact、离线唤醒模型和控制面板自动化
证据，推进到可审计的发布候选、真实设备验收和仓库治理。每项结论都必须标明
它是本机自动化、CI、目标硬件、真实 provider，还是正式发布系统的证据；测试
fixture、fake provider 和 unsigned 包不能替代后者。

本阶段只在本票中执行 Phase 9A。其余切片保持为后续前置条件，不能因为本次
CI 变绿而提前标记完成。

## 分阶段范围

### Phase 9A：CI Recovery

恢复 Linux Electron built renderer scenario 的真实 Chromium sandbox 运行环境，
拆分 Desktop headless、renderer、Backend、contracts/security、mobile 和发布
门禁，并保留失败证据和严格退出/清理断言。使用固定 Node `24.19.0`、pnpm
`10.24.0`、.NET `10.0.100` 与 Electron `44.0.0`；任务分支可通过
`pull_request` 上的 `full-matrix` 标签在合并前执行完整矩阵；`workflow_dispatch`
保留给该 workflow 已进入默认分支后的未来任意 ref 验证。

### Phase 9B：真实 Desktop Golden Path

在隔离安装目录中验证真实 Desktop 到 Backend/Device Node 的认证、Realtime、
任务、审批、通知、重启恢复和发布候选路径。fake 或离线路径只能作为自动化
边界，不得冒充真实 provider 证据。

### Phase 9C：真人声学与硬件验收

在固定目标 Mac、麦克风和扬声器上填写近场/远场唤醒、背景误唤醒及 30 分钟
idle CPU/RSS worksheet。未实际执行的格子继续为 `UNVERIFIED`。

### Phase 9D：当前 HEAD 移动端真机验收

在当前候选 SHA 上分别完成 Android 与 iOS 原生构建、安装、设备音频路由、
Realtime/任务/通知恢复和版本可追溯性验收。Metro bundle 和静态 native config
检查不能替代真机证据。

### Phase 9E：macOS RC 签名、notarization、升级与回滚

在固定 release candidate 上完成 Developer ID 签名、公证、安装更新、失败回滚
和发布制品校验。Phase 8/9A 的 unsigned test package 不属于正式发布证明。

### Phase 9F：架构 ADR 与仓库治理

记录经过验收的边界、事实来源、回滚策略、CI required checks、artifact 保留和
安全 ownership；将可自动检查的不变量固化为测试或 CI，而不是依赖口头约定。

## Phase 9A 验收边界

- Linux 脚本只能从当前 Desktop 工作区已安装的 Electron binary 解析同一
  `dist/chrome-sandbox`；Electron npm package 的 `path.txt` 位于安装根目录，
  其相对值必须解析到 `<install>/dist`，sandbox 再从 canonical binary dirname
  推导。严格拒绝外部路径、替代路径、symlink、目录、FIFO 和缺失文件；真实
  `chown/chmod` 仅由受控 CI Linux 流程执行。变更前由非特权 helper 以
  `O_NOFOLLOW` 打开并持有 canonical parent 与 sandbox descriptor；固定的
  `/usr/bin/python3 -I -S` mutator 只接收数字 proc-fd 身份，打开后以自身 descriptor
  执行 `fchown/fchmod` 并复验同一 fd。helper 以 descriptor-backed `fstat`、no-follow
  当前目录项和 dev/ino/nlink 恒等性防止替换，变更后再校验 root:root/4755。
- Linux renderer job 必须验证 `/run/dbus/system_bus_socket` 和
  `dbus-run-session`；仅在 system socket 不存在时用 non-interactive sudo 启动
  创建 `/run/dbus`（`install -d -m 0755`）并启动
  `dbus-daemon --system --fork`，并在 Xvfb 下通过 `dbus-run-session` 运行真实
  renderer。D-Bus 准备失败必须阻断场景，不能通过放宽 `stderrClean` 掩盖。
- 冷 runner 在 frozen install 后必须由 Linux renderer 和 macOS release job 显式
  执行锁定 Electron 包的 `install-electron` CLI，再进行 build/sandbox/package；
  不增加全局 postinstall，避免所有 job 重复下载并避免隐式依赖缓存。
- Linux renderer job 在 Checkout 后、setup 前先写入固定 bounded 的
  `scenario.json`（`not-run`、`observationAvailable=false`、通用失败原因）；
  后续 runner 成功或失败时以原子覆盖更新，任何前置门禁失败都仍能上传该证据。
- Renderer 场景继续观察真实 Electron child 的 JSON、退出码、stderr、profile
  和 owned process cleanup；sandbox 不允许通过参数、环境变量或 UI 选项关闭。
- `test:headless` 不启动 GUI，但保留 unit、真实 wake-word fixture/CPU probe、
  package/build contract；完整 `test` 还运行 built renderer scenario。
- PR 默认独立运行核心质量门禁；带 `full-matrix` 标签的 PR、`main` push 与任意
  ref 的 `workflow_dispatch` 运行 E2E/native/release 完整矩阵，后续 `synchronize`
  事件继续保留该标签门控。Full Matrix 保留原有 `needs`，标签不得绕过失败前置；
  artifact 上传可 `always`，质量门禁不可 `continue-on-error`。
- `phase9a-verification-summary` 以 `always()` 汇总九个 required jobs，向
  `jarvis-phase9a-remote-verification` 上传 bounded
  `artifacts/test-reports/phase9a/remote-verification.json`；普通无标签 PR 的
  Full Matrix 明确为 `not-requested`，带标签、`main` push 或
  `workflow_dispatch` 中任何 skipped/失败均使汇总失败。

## 后续进入条件

Phase 9B 之前需要 Phase 9A 的同一候选 SHA 获得 Node `24.19.0` CI 证据；Phase
9C/9D 需要目标硬件/真机；Phase 9E 需要 Apple 发布凭据和回滚演练；Phase 9F
需要把最终验收结果转化为 ADR 和治理规则。真实 OpenAI Realtime/Responses、
真人声学、物理移动端音频、签名/notarization 和生产发布均不由 Phase 9A
证明。
