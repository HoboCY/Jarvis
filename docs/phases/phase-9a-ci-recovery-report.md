# Phase 9A CI Recovery 报告

## 结论

当前结论：`PASS`。

PR #7 仍为 Open / unmerged，分支为 `codex/phase9a-ci-recovery`。validated
implementation candidate 为 `2c649d4be73ad0b4af608ec97dd54be577597624`；带有
`full-matrix` label 的 pull-request synchronize Run #27（ID `33877662591`）九个
required jobs 全部 success，remote verification JSON 的 `overallStatus=success`。

PR #7 的 previous candidate `396441c19b9d7851d91363ee747d9f6253654427` 在 Run #26
（ID `33867878871`）保持历史 `REMOTE_PARTIAL_FAILED`；该历史 partial failure 不回退
本轮 Run #27 的结论。Run #27 的 job、artifact、JSON 字段和内容复核证据见下文。

本工作树已完成 Linux sandbox 路径、Desktop 测试拆分、Renderer observation
可靠性修复、CI job DAG，以及本轮 Mobile bootstrap 与 package audit runner 的
本地合同验证；Run #27 已提供完整矩阵远程证据。本报告不启动 Phase 9B，也不表示
正式发布外部门禁已通过。

本轮 Phase 9A-R2 修复 Mobile static 的共享包 bootstrap、workspace audit 顺序和
bounded package audit runner。Run #27 的 `headSha`、Run ID、Job conclusion 和
artifact 清单均来自 PR checks 与 `jarvis-phase9a-remote-verification` artifact，
不是由 tracked report 推断。

## Phase 9A-R 预合并触发与 evidence

首次合并前不能只依赖 `workflow_dispatch`：该 workflow 尚未存在于默认分支
`main` 时，GitHub 无法从任务分支把它作为稳定的预合并入口。CI 现在让同一个
Phase 9A PR 通过 `full-matrix` label 运行完整矩阵，并将 `pull_request` 事件扩展
为 `opened`、`synchronize`、`reopened`、`labeled`；PR 加标签后，后续
`synchronize` 仍会继续触发 E2E、Android、iOS 和 macOS jobs。核心五个 PR gates
始终独立运行，Full Matrix 保留原有 `needs` 与成功前置，标签不能绕过失败依赖。

`workflow_dispatch` 仍保留给 workflow 已进入默认分支后的未来任意 ref 验证，
`main` push 也继续运行完整矩阵。本地普通无标签 PR 的汇总会将四个 Full Matrix
`jobResults` 规范化为 `not-requested`；带标签、`main` push 或
`workflow_dispatch` 时记录真实 result，任何 expected skipped 都使汇总失败。
`phase9a-verification-summary` 使用 `always()` 等待九个 required jobs，先生成并
上传 bounded `artifacts/test-reports/phase9a/remote-verification.json`，再以
非零退出传播失败；PR evidence 的 `headSha` 取
`github.event.pull_request.head.sha`，其它事件取 `github.sha`。

## Baseline

| 项目 | 值 |
| --- | --- |
| 用户提示中的 prompt baseline | `a028fca7212d1b63e347f65c4a444be693fa5c12` |
| 实际起始 SHA / 当前 origin/main | `198385d1429b46167858457a920b5f370858363b` |
| PR #7 previous candidate SHA | `396441c19b9d7851d91363ee747d9f6253654427` |
| PR #7 validated implementation candidate SHA | `2c649d4be73ad0b4af608ec97dd54be577597624` |
| PR #7 historical Run #26 / ID | `#26` / `33867878871` |
| PR #7 validated Run #27 / ID | `#27` / `33877662591` |
| PR #7 Run #27 remote status | `PASS` (`overallStatus=success`) |
| 分支 | `codex/phase9a-ci-recovery` |
| 本地操作系统 | macOS arm64 |
| 本地 Node / pnpm | `v25.0.0` / `10.24.0` |
| 仓库要求 Node / pnpm | `24.19.0` / `10.24.0` |
| .NET SDK | `10.0.100` |
| Electron | `44.0.0` |

本机 Node `25.0.0` 不是目标 CI 的等价环境；其本地成功只能作为开发验证，
不能替代 Node `24.19.0` Linux 证据。

PR #7 Run #26 的四个已远程通过 jobs 是 `backend-quality`、`contracts-security`、
`desktop-renderer-linux` 和 `e2e`。`workspace-quality` 因 `ERR_SOCKET_TIMEOUT`
传输错误失败；这不是漏洞报告。`mobile-static` 因共享包未在 Mobile typecheck
前构建而出现 TS2307。Android、iOS、macOS 依赖失败的 Mobile/前置 jobs 而为
`skipped`；不能把它们写成 passed。remote verification artifact 的
`overallStatus` 为 failure，故 Run #26 是 `REMOTE_PARTIAL_FAILED`。Renderer 的
hosted gate 已闭环并保留严格 observation/evidence 语义。

## 原始 CI RED 与根因

提示中的 Run #23（ID `33623011371`）以 prompt baseline `a028fca` 运行，首个
实际阻断是 `phase-0 → Test workspace → @jarvis/desktop test →
test:renderer-scenario:built`。Linux workspace 中
`node_modules/electron/dist/chrome-sandbox` 是普通文件但不是 `root:root`、
`4755`，Electron 的 SUID helper 检查失败并以 `SIGTRAP` 退出。

随后在实际起始 SHA `198385d` 上的 Run #24（ID `33719867602`）再次出现同一
错误；Build workspace、Mobile、contracts/security steps 为 0s skipped，
phase-6-main、Android、iOS 和 macOS jobs 也被跳过。Run #24 是修复前的实际
基线，不是修复后的证据。

根因是 pnpm 安装产生的 Electron sandbox 文件没有被 CI 在 Linux 运行前设置为
Chromium 要求的 root-owned SUID `4755` 属性，而旧 CI 把多个无关检查放在一条
串行 gate 后面。修复通过受控脚本解析已安装 Electron 的真实 binary 和同一
`dist/chrome-sandbox`，并在 Xvfb 中运行真实场景；没有关闭 sandbox 或忽略退出码。

### Electron path contract 审阅修正

审阅中发现初版 resolver 把 Linux `path.txt` 的 `electron` 直接拼到了
`<install>/electron`，而 Electron 44 的 public package contract 是从安装根的
`path.txt` 读取相对值，再解析为 `<install>/dist/<path.txt>`，即真实的
`dist/electron`。该错误会在 Node 24.19.0 Debian 集成准备阶段返回
`Electron binary is unavailable.`，因此不把它计为 Linux GREEN。

resolver 现从真实 binary 的 canonical dirname 推导同目录 sandbox，并新增 fixture
固定 `path.txt -> dist/electron -> dist/chrome-sandbox`。mutation 前非特权 pin helper
打开并持有 descriptor，特权 mutator 只打开固定数字 proc-fd、校验传入 dev/ino/nlink
后用自身 fd 执行 `fchown/fchmod`，再以同一 fd 校验 root:root/4755；随后非特权
helper 重新检查当前目录项恒等性，shell 再调用同一 resolver 要求路径与初次完全
一致。fixture 和静态合同为本地证据；该段记录的是当时的 Node 24.19.0 独立 Debian
验证窗口。随后 PR #7 Run #26 的 `desktop-renderer-linux` 已 success；Run #27 对
validated implementation candidate 的同一 hosted renderer gate 也已 success（见下表）。

### Node 24 Linux D-Bus 集成修正

在 sandbox 已变为 `root:root`、`4755` 后，主代理的 Node 24.19.0 Debian 集成又
发现：无 D-Bus 的 Xvfb 环境中 Electron child 虽然 exit 0，但 system/session
D-Bus 错误进入 stderr，使严格 `stderrClean` 失败；非 init 容器中的 zombie 属于
容器 PID1 人工环境问题，不修改 runner 的清理断言。随后 cold Debian 验证发现
`/run/dbus` 目录本身也可能不存在，初版准备步骤因此无法绑定 system socket。

主代理在带 init/CAP_SYS_ADMIN 的独立 Debian 验证环境中启动 system D-Bus socket，
并以 `dbus-run-session -- xvfb-run ...` 运行场景，得到
`observationAvailable=true`、`childExitCode=0`、`stderrClean=true`、
`userData.removed=true`、`ownedAppProcessesGone=true`、
`ownedProcessGroupGone=true`、`consoleErrors=0`。CI 现复现同一受控准备：仅当
`/run/dbus/system_bus_socket` 不存在时才执行 `sudo -n dbus-daemon --system --fork`，
先以 `sudo -n install -d -m 0755 /run/dbus` 准备目录，再验证 socket 与
`dbus-run-session` 后包裹 Xvfb 场景；没有放宽 stderr 或清理断言。

### 冷缓存 Electron runtime 修正

主代理进一步在 fresh Node 24.19.0 Debian workspace 中验证：Electron 44 package
没有 postinstall；仅执行 `pnpm install --frozen-lockfile` 时可能只有 package
文件而没有 `path.txt`/`dist` binary。此前 Run #23/#24 能够到达 SUID helper 检查，
不代表冷 runner 已建立 binary，也不能把已有 cache 当作 CI contract。

因此 `desktop-renderer-linux` 在 frozen install 后、build/sandbox 前，以及
`macos-release-smoke` 在 package 前，均显式执行锁定的
`pnpm --filter @jarvis/desktop exec install-electron`。没有增加全局 postinstall，
其它 job 不会重复下载；安装步骤失败会直接阻断对应 gate。

### Renderer evidence 生命周期修正

此前 artifact 只有在 runner 启动后才会创建；若 install、build、sandbox 或 D-Bus
准备失败，`if: always()` upload 只能得到缺失文件。现在
`desktop-renderer-linux` 在 Checkout 后、setup 前以 `if: always()` 写入固定且
bounded 的 `scenario.json`：`status=not-run`、`observationAvailable=false`、
`failureReason=renderer-scenario-not-started`，不包含路径、环境变量或秘密。
runner 的成功与异常路径使用同目录临时文件加 `rename` 原子覆盖该 initializer；
前置门禁失败时则保留 initializer 供 artifact 审查。

## TDD RED → GREEN

### Linux sandbox contract

RED：在修复前，Run #23/#24 的 Linux built scenario 因 sandbox ownership/mode
失败。新增 fixture 回归测试先固定要求：错误 basename、workspace/Electron 安装
目录外路径、symlink/目录/FIFO、缺失文件、错误 owner/mode 和 secret-shaped
输入必须失败。

GREEN：`node --test eng/scripts/prepare-electron-linux-sandbox.test.mjs`
通过 `9/9`。测试只操作隔离临时 fixture，不需要 root；真实 mutation 由固定的
`/usr/bin/python3 -I -S -c` mutator 打开数字约束的 foreign proc-fd，立即以
自身 descriptor-backed `fstat` 比较 dev/ino/nlink，再执行 `fchown/fchmod` 并以同一
fd 验证 root:root/4755。非特权 helper 随后复验当前目录项恒等性；测试还覆盖
`path.txt -> dist/electron -> dist/chrome-sandbox`、hardlink 和目录项替换。

### Desktop scripts and CI contracts

RED：新增静态合同测试最初因脚本/runner 的目标约束尚未实现而失败（2 个
合同断言未满足）。

GREEN：
`node --test eng/scripts/prepare-electron-linux-sandbox.test.mjs eng/scripts/ci-workflow-contract.test.mjs`
通过 `15/15`（sandbox standalone `9/9`，workflow contract `6/6`）；覆盖脚本拆分、
CI 触发器/job DAG/tool versions/timeouts/artifact、Renderer handoff/startup 稳态、
descriptor pinning 以及生产面 sandbox bypass 禁止项。

### Phase 9A-R 预合并触发与远程 evidence contract

RED：合同测试新增了 `pull_request` 的 `labeled`/`synchronize` 触发、
`full-matrix` label 门控、`success()` 前置、九-job summary、required artifact 和
bounded evidence 字段；在 workflow 尚未实现时因缺少 `pull_request.types` 先失败。

GREEN（历史 R1）：Full Matrix 在带标签 PR、`main` push 或 `workflow_dispatch` 时运行，
`phase9a-verification-summary` 对普通无标签 PR 将四个 Full Matrix result 规范化为
`not-requested`，对请求场景保留真实 result 并将 skipped/失败传播为非零；summary
artifact 在最终状态 gate 之前上传。PR evidence 使用
`github.event.pull_request.head.sha`，其它事件使用 `github.sha`。当前合同测试
历史 R1 的合同测试为 `15/15`；这仍是本地 GREEN，不是远程证据。

### Phase 9A-R2 Mobile bootstrap 与 package audit runner

RED：新增公共 seam 测试先验证 Mobile static 必须在 typecheck 前按
`contracts-ts → realtime-agent → api-client-ts` 构建，以及 audit runner 的固定
registry、`audit-level=high`、重试预算和 workspace 顺序；起始 workflow 缺少三个
build steps，root script 仍直接调用 `pnpm audit`，因此新增合同先以失败结束。

本轮复核 RED：timeout budget/cleanup、JSON secret redaction 和报告远程状态合同先行
失败；旧 runner 的默认 `30000ms` deadline 会早于已知约 `250s` 的 pnpm 内置 transport
重试窗口返回 child timeout，SIGTERM-only 路径也无法证明 descendant 已退出，摘要会
回显 quoted JSON secret/path，报告还保留了错误的 local-only 状态、NOT_RUN renderer
记录和新建 PR 命令。

GREEN：`mobile-static` 在 frozen install 后显式按上述顺序构建三个共享包，再执行
Mobile typecheck/test/bundles；`workspace-quality` 将 required audit 移到 typecheck、
lint、headless tests 和 build 之后。`check-package-audit.mjs` 只对严格识别的
transport transient（含 nested metadata timeout/reset/DNS、明确 registry 429/5xx）
有限重试；漏洞报告、锁文件/参数/权限/unknown/malformed/异常子进程和子进程
timeout 立即失败，attempt/backoff/timeout/stdout/stderr/summary 都有界且脱敏。
默认单次 audit deadline 为 `300000ms`；超时后 supervisor 发送 `SIGTERM`，等待
`1000ms`，再对 POSIX detached process group 发送 `SIGKILL`，并在一个 bounded cleanup
wait 内等待 child `close` 与 process group 清理；若仍未完成则 destroy stdio、unref
并以 `cleanupComplete=false` 返回非成功结果。`node --test eng/scripts/check-package-audit.test.mjs`
通过 `22/22`，`pnpm test:ci-contract` 通过 `41/41`；live audit exit 0、runner
1 attempt，沿用
`pnpm-workspace.yaml` 的 audit policy，未将 timeout 或 ignored finding 写成漏洞。

### Renderer observation

RED：旧 runner 依赖 Electron stdout pipe 在立即退出前完整收到约 185KB JSON；
macOS Node 25 的基线重复试验曾出现首轮 `5/10` 失败：startup auto-connect
transient 状态下 UI 断言过早，或 observation 在 runner parse 前未完整 flush。

GREEN：child 将完整 observation 原子写入 runner-owned profile 的 bounded
handoff 文件，runner 在清理前读取并最终仍向 stdout 输出 JSON；startup 改为观测
连接状态达到连续稳定样本；stderr、child exit、owned app/process group 和
userData cleanup 断言均保留。当前本机 `test:renderer-scenario:built` 通过，
且最终脚本连续 3 次均通过（该重复结果仍是 macOS/Node 25，非 Linux 等价证明）。

## 改动文件

- `.github/workflows/ci.yml`：拆出 backend/workspace/contracts-security、Linux
  renderer、mobile static、E2E、Android native、iOS native、macOS release smoke；
  保留 PR/main push，增加带 `full-matrix` label 的预合并触发、
  `workflow_dispatch`、concurrency、固定版本、timeout、冷缓存 Electron runtime
  安装、早期 bounded evidence initializer、受控 D-Bus/Xvfb 准备、required artifact
  上传和 `phase9a-verification-summary`；Mobile static 在 typecheck 前构建三个
  共享包，workspace audit 保持 required 且位于其它 workspace gates 之后。
- `package.json`：公开 `test:headless`、`test:ci-contract` 和
  `check:package-audit` runner。
- `eng/scripts/check-package-audit.mjs`：固定官方 npm registry 与 high audit level，
  由真实 child supervisor 管理 `300000ms` deadline、detached POSIX process group、
  TERM/KILL cleanup 和 close 等待；仅重试明确 transport transient，并让 failure
  summary 只包含 allowlisted markers。
- `eng/scripts/check-package-audit.test.mjs`：22 条公共 runner seam 测试，覆盖
  timeout retry/耗尽、漏洞/unknown/malformed/lockfile/permission、registry 429/5xx、
  子进程 timeout/异常、真实 spawned shim 的 descendant cleanup、non-closing child 的
  bounded settle、正常 exit descendant drain、CI deadline budget、
  bounded output 和 JSON secret/path 脱敏。
- `eng/scripts/ci-workflow-contract.test.mjs`：新增 Mobile bootstrap 顺序、package
  audit runner 参数/有界重试/workspace 顺序合同，保留 summary/full-matrix truth table。
- 根 `test:headless` 组合 `contracts-ts`、`realtime-agent`、`api-client-ts` 的
  现有测试和 Desktop headless；不重复 Mobile，也不启动 Renderer。
- `src/clients/desktop/package.json`：拆出 `test:unit`、`test:wake-word`、
  `test:package`、`test:headless`；完整 `test` 仍包含 built renderer scenario，
  package gate 仍执行真实 build/package contract/wake fixture/CPU probe；macOS
  release script 继续保留真实 ASAR、安装和重启门禁。
- `src/clients/desktop/scripts/renderer-scenario-runner.mjs`：profile-owned
  observation handoff、UTF-8 byte-bounded stdout/stderr、cleanup 前读取和最终证据；
  runner 输出以原子覆盖写回 scenario evidence。
- `src/clients/desktop/scripts/renderer-scenario.mjs`：renderer surface、
  conversation projection 与 startup connection 稳态观测；成功和断言失败均先
  将 bounded observation 原子写入 handoff，有 handoff 时不把完整 JSON 打到 stdout。
- `eng/scripts/prepare-electron-linux-sandbox.sh`：Linux-only、无调用方 target
  参数；受控流程先由非特权 Node helper 固定父目录/目标 descriptor，再由固定的
  `/usr/bin/python3 -I -S -c` mutator 打开 `/proc/<pid>/fd/<fd>`、校验身份并以
  自身 fd 执行 `fchown/fchmod`，最后由同一 Node helper 做 no-follow 恒等性/属性复验。
- `eng/scripts/prepare-electron-linux-sandbox.mjs`：从 Desktop 已安装 Electron
  根 `path.txt` 解析 `<install>/dist/<path.txt>` binary，再从 binary dirname
  推导 sandbox，并提供不修改 fixture 的严格路径/文件属性校验。
- `eng/scripts/prepare-electron-linux-sandbox-pin.mjs`：仅允许 `--pin` 或
  `--dry-run`；以 `O_NOFOLLOW` 打开 canonical parent 和 sandbox，持有 fd 供固定
  系统工具操作，拒绝替换 inode、symlink、特殊文件及 hardlink。
- `eng/scripts/prepare-electron-linux-sandbox.test.mjs`、
  `eng/scripts/ci-workflow-contract.test.mjs`：公共脚本/最终属性和 CI 静态合同
  回归测试。
- `docs/phases/phase-9-plan.md`：Phase 9A–9F 方向与阶段边界。

## CI job DAG 与触发器

核心 PR gates 无 `needs`，可独立报告：`backend-quality`、`workspace-quality`、
`contracts-security`、`desktop-renderer-linux`、`mobile-static`。完整矩阵
`e2e` 只依赖 backend；`android-native`/`ios-native` 只依赖 mobile-static；
`macos-release-smoke` 等待真实质量、renderer、mobile 和 E2E 前置。E2E/native/
release jobs 在 main push、任意 ref 的 `workflow_dispatch` 或 PR 带
`full-matrix` label 时运行；其 `success()` 条件不会绕过 `needs` 失败，带标签后的
后续 synchronize 也会重新进入完整矩阵。`phase9a-verification-summary` 使用
`always()` 汇总九个 jobs，普通无标签 PR 的 Full Matrix 结果为 `not-requested`，
请求完整矩阵时 skipped/失败均使 summary 失败。artifact 上传使用
`if: always()` 和 `if-no-files-found: error`，门禁步骤没有 `continue-on-error`。

`workspace-quality` 的 npm audit 仍是 required，但执行顺序为 typecheck、lint、
headless tests、build、audit；audit runner 固定调用官方
`pnpm audit --registry=https://registry.npmjs.org --audit-level=high`，保留
`pnpm-workspace.yaml` audit policy。

Linux renderer evidence artifact 名称为
`jarvis-phase9a-desktop-renderer-evidence`，保存 bounded `scenario.json`，不
上传 userData、credential 或秘密。其它 artifact：
`jarvis-phase9a-mobile-static`、`jarvis-phase9a-e2e-reports`、
`jarvis-phase9a-android-debug`、`jarvis-phase9a-ios-simulator-debug`、
`jarvis-phase9a-macos-arm64-release-test`、
`jarvis-phase9a-remote-verification`（包含 bounded
`artifacts/test-reports/phase9a/remote-verification.json`）。

## Security result

- Chromium sandbox 仍由 Electron 默认启用；源码、CI、脚本和测试没有新增任何
  sandbox bypass 参数、禁用环境变量、关闭配置或等价绕过。
- shell script 不接受任何参数，target 不能由调用方指定；Node helper 从当前
  workspace 的 `@jarvis/desktop` 安装 Electron package/path metadata 解析 binary，
  精确绑定同一 dist 的 regular `chrome-sandbox`，拒绝 symlink、目录、FIFO、
  外部路径和缺失文件。
- `sudo` 仅接收固定系统 `/usr/bin/python3 -I -S -c` mutator；它只接受严格数字
  pid/fd/dev/ino/nlink，打开固定 proc-fd 后以自身 descriptor 执行 `fchown/fchmod`，
  不接收调用方 target，也不以 root 执行 Node 或其它仓库 JS。非特权 helper 先用
  `O_NOFOLLOW`/directory fd 固定 parent，再以 descriptor-backed `fstat` 与 no-follow
  当前目录项比较 dev/ino/nlink；fixture 测试永远不调用 root。
- Linux renderer 与 macOS release 在冷 frozen install 后显式安装锁定 Electron
  runtime；没有全局 postinstall，也不把已有 runner cache 当作 binary 保证。
- D-Bus 只补齐 Electron 运行时依赖，不关闭 sandbox，也不放宽 `stderrClean`。
- runner/场景只写 bounded、结构化 evidence，不写真实 userData 路径、credential、
  真实用户消息或 secret；其中的 UI 内容仅来自固定测试 fixture。独立 Linux
  evidence 为 owner-only `0600`，结构化扫描未发现 workspace/home/temp 绝对路径或
  bearer/API key/credential 字段；错误输出为通用 bounded 文本。

## Local verification

| 命令 | 结果 |
| --- | --- |
| `dotnet restore Jarvis.sln --locked-mode` | PASS |
| `dotnet tool restore` | PASS；`dotnet-ef 10.0.11` |
| `dotnet build Jarvis.sln --configuration Release --no-restore` | PASS；0 warnings / 0 errors |
| `dotnet test Jarvis.sln --configuration Release --no-build --no-restore` | PASS；285 tests（4 architecture、48 infrastructure、26 domain、19 application、43 device、8 E2E、137 API integration） |
| `dotnet format Jarvis.sln --no-restore --verify-no-changes` | PASS |
| `dotnet list Jarvis.sln package --vulnerable --include-transitive` | PASS；13 projects 未报告 vulnerable package |
| `dotnet ef migrations has-pending-model-changes ...` | PASS；无 pending model changes |
| `pnpm install --frozen-lockfile` | PASS；本机 Node 25 engine warning，非等价 CI |
| `pnpm check:package-audit` | PASS（exit 0）；runner 1 attempt，官方 registry/high level，沿用 workspace audit policy；默认 deadline 300000ms，未观察 timeout，未把 ignored finding 写成零漏洞 |
| `pnpm typecheck` | PASS |
| `pnpm lint` | PASS |
| `pnpm test:headless` | PASS；contracts 7、realtime 12、API client 4、Desktop unit 160 / wake 17 / package 14；不含 Mobile/Renderer |
| `pnpm build` | PASS |
| `node --test eng/scripts/check-package-audit.test.mjs` | PASS；22/22 |
| `pnpm test:ci-contract` | PASS；combined 41/41（sandbox 9/9，workflow 10/10，audit runner 22/22） |
| `pnpm check:openapi` | PASS；生成文件 byte-for-byte unchanged |
| `git diff --exit-code -- artifacts/openapi/openapi.json packages/contracts-ts/src/generated/openapi.ts` | PASS |
| `pnpm check:codex-schema` | PASS；275 files / 90 ClientRequest / 70 ServerNotification / 10 ServerRequest |
| `pnpm check:codex-schema-canonical` | PASS；275 files |
| `pnpm test:codex-schema-canonical` | PASS；2/2 |
| `pnpm check:secrets` | PASS |
| `pnpm test:secret-scan` | PASS；1/1 |
| `pnpm test:service-manifest` | PASS；20/20 |
| `pnpm --filter @jarvis/desktop typecheck` | PASS |
| `pnpm --filter @jarvis/desktop lint` | PASS |
| `pnpm --filter @jarvis/desktop run test:unit` | PASS；160/160 |
| `pnpm --filter @jarvis/desktop run test:wake-word` | PASS；17/17，含真实离线模型 fixture 与 CPU probe |
| `pnpm --filter @jarvis/desktop run test:package` | PASS；14 个 package/build contracts，另验证 dist 中真实 wake fixture 与 CPU probe |
| `pnpm --filter @jarvis/desktop build` | PASS |
| `pnpm --filter @jarvis/desktop test:renderer-scenario:built`（macOS/Node 25） | PASS；最终 evidence 187,506 bytes、mode 0600，严格 observation/exit/stderr/profile/process/console 字段全部通过 |
| 最终 built renderer scenario 连续 3 次（macOS/Node 25） | PASS；3/3，单次 evidence 187,506 bytes |
| `pnpm --filter @jarvis/mobile typecheck` | PASS |
| `pnpm --filter @jarvis/mobile test` | PASS；52/52 |
| `pnpm --filter @jarvis/mobile bundle:android` | PASS |
| `pnpm --filter @jarvis/mobile bundle:ios` | PASS |
| `pnpm check:mobile-native-config -- --require-bundles` | PASS |
| `tests/e2e/run-e2e.sh` | PASS；8 named E2E + 88 focused API integration + 41 device = 137 |
| `git diff --check` | PASS |
| `git status --short` | PASS；仅有本票 owned paths 与预先存在的未跟踪 `docs/phases/phase-9a-r-result-summary.md`；摘要未修改/删除/暂存 |
| clean Mobile worktree | PASS；`/private/var/folders/lb/k1l6m22d4k32ys00l52cf__m0000gn/T/jarvis-phase9a-mobile-XXXXXX.eF6CFkzF2W` 从 detached `HEAD 396441c` 创建，无 node_modules/dist 复用 |
| clean `pnpm install --frozen-lockfile` | PASS；1249 packages，Node 25 engine warning 仅因本机版本 |
| clean shared builds | PASS；按 `contracts-ts → realtime-agent → api-client-ts` 顺序各 exit 0 |
| clean Mobile typecheck/test | PASS；typecheck exit 0，tests 52/52 |
| clean Mobile Android/iOS bundles | PASS；`bundle:android`、`bundle:ios` 各 exit 0 |
| clean `pnpm check:mobile-native-config -- --require-bundles` | PASS；Android/iOS bundles 均存在且扫描通过 |

此前独立 Debian 环境曾执行 Node `24.19.0` / pnpm `10.24.0` 的
`pnpm check:package-audit`、`pnpm typecheck`、`pnpm lint`、`pnpm test:headless`、
`pnpm build` 与 `pnpm test:ci-contract`；全部通过，并验证了 cold install 后显式
`install-electron` 与 Electron `44.0.0` runtime。那次真实 renderer/sandbox 证据
发生在本轮 descriptor pin redesign 之前，不能替代下面的当前 helper 集成结果。

## 独立 Linux 集成证据

| 环境 | 结果 | 证据边界 |
| --- | --- | --- |
| 独立 Debian 容器（Node `24.19.0` / pnpm `10.24.0` / Electron `44.0.0`，当前 descriptor pin；`CAP_SYS_ADMIN`/`CAP_SYS_PTRACE`） | PASS | 冷缓存 sandbox 从 `1000:1000:0755` 变为 `0:0:4755`；built renderer `exit=0`，evidence `188454` bytes、mode `0600`，`observationAvailable=true`、`childExitCode=0`、`stderrClean=true`、profile/userData 与两类 owned process cleanup 均为 true；无绝对路径或敏感值泄漏。普通无 `CAP_SYS_PTRACE` Docker 容器对跨 UID proc-fd dereference 会 `Permission denied`；GitHub hosted runner 的实际权限仍属远程 `UNVERIFIED` |
| GitHub Actions `desktop-renderer-linux` | PASS（PR #7 Run #27） | validated implementation candidate `2c649d4be73ad0b4af608ec97dd54be577597624` 的 hosted renderer gate 已 success；Run #26 的 previous candidate partial failure 保留为历史记录 |

## GitHub Actions verification

| Run | Commit SHA | Job | Conclusion | Artifact |
| --- | --- | --- | --- | --- |
| #23 / `33623011371` | `a028fca` | phase-0 Test workspace renderer | failed（原始 baseline） | none recorded |
| #24 / `33719867602` | `198385d` | phase-0 Test workspace renderer | failed（实际 baseline；sandbox SIGTRAP） | none recorded |
| PR #7 / Run #26 (`33867878871`) | `396441c` | backend-quality | success | none |
| PR #7 / Run #26 (`33867878871`) | `396441c` | contracts-security | success | none |
| PR #7 / Run #26 (`33867878871`) | `396441c` | desktop-renderer-linux | success | `jarvis-phase9a-desktop-renderer-evidence` |
| PR #7 / Run #26 (`33867878871`) | `396441c` | e2e | success | `jarvis-phase9a-e2e-reports` |
| PR #7 / Run #26 (`33867878871`) | `396441c` | workspace-quality | failure（`ERR_SOCKET_TIMEOUT` transport；不是 vulnerability report） | none |
| PR #7 / Run #26 (`33867878871`) | `396441c` | mobile-static | failure（Mobile typecheck 的 TS2307；shared package build 缺失） | none（bundle 未生成，artifact not produced） |
| PR #7 / Run #26 (`33867878871`) | `396441c` | android-native | skipped（mobile-static failure） | none（artifact not produced） |
| PR #7 / Run #26 (`33867878871`) | `396441c` | ios-native | skipped（mobile-static failure） | none（artifact not produced） |
| PR #7 / Run #26 (`33867878871`) | `396441c` | macos-release-smoke | skipped（required upstream failure） | none（artifact not produced） |
| PR #7 / Run #26 (`33867878871`) | `396441c` | phase9a-verification-summary | failure（remote artifact `overallStatus=failure`） | `jarvis-phase9a-remote-verification` |

Run #26 是 previous candidate 的真实远程 partial failure：四个 jobs 通过，
workspace/mobile 阻断，Android/iOS/macOS 明确为 skipped，remote artifact overall
failure。没有把 #24 或 #26 当作本轮 new candidate 的成功证据，也没有把 skipped 写成
passed。Run #26 的结果仅作为历史对照。

Run #27 是 validated implementation candidate 的完整矩阵远程证据：

| Run | Commit SHA | Job | Conclusion | Artifact |
| --- | --- | --- | --- | --- |
| PR #7 / Run #27 (`33877662591`) | `2c649d4be73ad0b4af608ec97dd54be577597624` | backend-quality | success | none |
| PR #7 / Run #27 (`33877662591`) | `2c649d4be73ad0b4af608ec97dd54be577597624` | workspace-quality | success | none |
| PR #7 / Run #27 (`33877662591`) | `2c649d4be73ad0b4af608ec97dd54be577597624` | contracts-security | success | none |
| PR #7 / Run #27 (`33877662591`) | `2c649d4be73ad0b4af608ec97dd54be577597624` | desktop-renderer-linux | success | `jarvis-phase9a-desktop-renderer-evidence` |
| PR #7 / Run #27 (`33877662591`) | `2c649d4be73ad0b4af608ec97dd54be577597624` | mobile-static | success | `jarvis-phase9a-mobile-static` |
| PR #7 / Run #27 (`33877662591`) | `2c649d4be73ad0b4af608ec97dd54be577597624` | e2e | success | `jarvis-phase9a-e2e-reports` |
| PR #7 / Run #27 (`33877662591`) | `2c649d4be73ad0b4af608ec97dd54be577597624` | android-native | success | `jarvis-phase9a-android-debug` |
| PR #7 / Run #27 (`33877662591`) | `2c649d4be73ad0b4af608ec97dd54be577597624` | ios-native | success | `jarvis-phase9a-ios-simulator-debug` |
| PR #7 / Run #27 (`33877662591`) | `2c649d4be73ad0b4af608ec97dd54be577597624` | macos-release-smoke | success | `jarvis-phase9a-macos-arm64-release-test` |
| PR #7 / Run #27 (`33877662591`) | `2c649d4be73ad0b4af608ec97dd54be577597624` | phase9a-verification-summary | success（第 10 个 check；JSON `jobResults` 保留前 9 个 required jobs） | `jarvis-phase9a-remote-verification` |

Run #27 的 remote verification JSON 字段复核为：`runId=33877662591`、
`runAttempt=1`、`eventName=pull_request`、`ref=refs/pull/7/merge`、
`headSha=2c649d4be73ad0b4af608ec97dd54be577597624`、`fullMatrixRequested=true`、
`fullMatrix.requested=true`、`fullMatrix.status=requested`、九个
`jobResults` 全为 `success`、`overallStatus=success`、
`generatedAtUtc=2026-09-04T13:30:21Z`。Run duration 为 `8m19s`，job duration 为：
mobile `1m31s`、backend `2m43s`、workspace `51s`、contracts `1m19s`、renderer
`35s`、android `5m46s`、ios `2m50s`、e2e `1m44s`、macos `3m32s`、summary `4s`。

Run #27 产出 7 个 GitHub artifact（下表 digest 为 GitHub archive digest）：

| Artifact | GitHub archive size | Digest | 内容复核 |
| --- | ---: | --- | --- |
| `jarvis-phase9a-android-debug` | 57.9 MB | `538e69caaa566606d57749cdde16cabb307b125906bfd94b7daccd695e1c36ad` | `app-debug.apk` |
| `jarvis-phase9a-desktop-renderer-evidence` | 14.3 KB | `0615a93e633556fe11e71e05c645ac4d50f36242457de49543e97c23e2080ffa` | renderer observation/evidence |
| `jarvis-phase9a-e2e-reports` | 621 KB | `01b557e8a840bcb23b650a521dd291d558730f66beebf03076bebb084511efcb` | TRX 88/88 + 41/41 + 8/8 |
| `jarvis-phase9a-ios-simulator-debug` | 37 MB | `a147b70d70611043d27ead234a0ec24104b857c49319c400efdf267d11d76224` | iOS simulator app structure |
| `jarvis-phase9a-macos-arm64-release-test` | 328 MB | `5729a459dbb1d08a2796ae8e963dad589dec4b416fb9cb86bd1d2de643ca8845` | outer archive and inner manifests |
| `jarvis-phase9a-mobile-static` | 1.4 MB | `83bfd70e2800d7cf3cc6d8d2069b01a0b8a8097d34bd31ad259299bcf4cc28a5` | Android/iOS bundles `3197351/3191080` |
| `jarvis-phase9a-remote-verification` | 525 B | `f0f29ee8dcdd0cfd07a95cc33fc28f7cd8dbb64d4591a4df0430b2f70b695db6` | JSON fields and digest pass |

内容复核还确认：renderer `observationAvailable=true`、process exit `0`、
`stderrClean=true`、app/process group gone、userData ownerOnly/isolated/removed、
`consoleErrors=0`、`secretFree=true`，且 archive digest matches；macOS outer digest
matches，Desktop/API/Device Node inner hashes match manifests。macOS 的
`signatureStatus=unsigned-test`、`notarizationStatus=not-run` 是正式发布外部门禁，
不是本次 CI 的 PASS；Developer ID 签名、notarization 和正式发布的 external release gates remain `UNVERIFIED`。

本报告 evidence-only 文档提交的自身 SHA 不属于 Run #27 validated implementation candidate，
也不得被本报告自引用为 `headSha`。最终 PR
head/run 以 PR checks、remote artifact 和最终答复提供的事实为准；PR #7 仍保持
Open / unmerged。

### 用户可执行的远程验证命令

以下命令保留给具备 GitHub 权限的操作者，用于在后续代码 candidate 变更时复核
existing PR #7 的 `full-matrix`；本报告已经记录 Run #27 的实际 PASS，不把后续
evidence-only 文档提交当作该 run 的 implementation head。命令会先 verify existing
PR #7，再 push 同一分支并观察 `synchronize` run，不会创建第二个 PR。

```bash
set -euo pipefail
gh auth status
gh pr view 7 --json number,headRefName,baseRefName,headRefOid,labels
git push -u origin codex/phase9a-ci-recovery
gh pr edit 7 --add-label full-matrix
phase9a_candidate_sha="${PHASE9A_CANDIDATE_SHA:?set the implementation candidate SHA before the evidence-only commit}"
phase9a_pr_head_sha="$(gh pr view 7 --json headRefOid --jq .headRefOid)"
test "$phase9a_pr_head_sha" = "$phase9a_candidate_sha"
gh pr checks 7 --watch
phase9a_runs_json="$(gh run list --workflow .github/workflows/ci.yml --branch codex/phase9a-ci-recovery --event pull_request --limit 20 --json databaseId,headSha,event)"
phase9a_run_ids="$(jq -r --arg candidate_sha "$phase9a_candidate_sha" '.[] | select(.event == "pull_request" and .headSha == $candidate_sha) | .databaseId' <<<"$phase9a_runs_json")"
phase9a_run_id=""
while IFS= read -r candidate_run_id; do
  test -n "$candidate_run_id" || continue
  phase9a_candidate_run="$(gh run view "$candidate_run_id" --json headSha,event,jobs)"
  if jq -e --arg candidate_sha "$phase9a_candidate_sha" '
    .headSha == $candidate_sha
    and .event == "pull_request"
    and ([.jobs[].name] as $job_names
      | (["e2e", "android-native", "ios-native", "macos-release-smoke"]
        | all(. as $name | ($job_names | index($name)) != null))
      and ([.jobs[]
        | select(.name == "e2e" or .name == "android-native" or .name == "ios-native" or .name == "macos-release-smoke")
        | .conclusion] | all(. == null or . != "skipped")))
  ' <<<"$phase9a_candidate_run" >/dev/null; then
    phase9a_run_id="$candidate_run_id"
    break
  fi
done <<<"$phase9a_run_ids"
test -n "$phase9a_run_id"
phase9a_watch_status=0
gh run watch "$phase9a_run_id" --exit-status || phase9a_watch_status=$?
phase9a_run_json="$(gh run view "$phase9a_run_id" --json headSha,event,status,conclusion,jobs)"
jq -e --arg candidate_sha "$phase9a_candidate_sha" '
  .headSha == $candidate_sha
  and .event == "pull_request"
  and .conclusion == "success"
  and ([.jobs[]
    | select(.name == "e2e" or .name == "android-native" or .name == "ios-native" or .name == "macos-release-smoke")
    | .conclusion] | length == 4 and all(. == "success"))
' <<<"$phase9a_run_json" >/dev/null
phase9a_artifact_directory="$(mktemp -d)"
trap 'rm -rf "$phase9a_artifact_directory"' EXIT
gh run download "$phase9a_run_id" --name jarvis-phase9a-remote-verification --dir "$phase9a_artifact_directory"
phase9a_evidence_file="$(find "$phase9a_artifact_directory" -type f -name remote-verification.json -print -quit)"
test -n "$phase9a_evidence_file"
jq -e --arg candidate_sha "$phase9a_candidate_sha" '
  .fullMatrixRequested == true
  and .fullMatrix.status == "requested"
  and .headSha == $candidate_sha
  and .overallStatus == "success"
  and ([.jobResults["backend-quality"], .jobResults["workspace-quality"], .jobResults["contracts-security"], .jobResults["desktop-renderer-linux"], .jobResults["mobile-static"], .jobResults["e2e"], .jobResults["android-native"], .jobResults["ios-native"], .jobResults["macos-release-smoke"]] | length == 9 and all(. == "success"))
' "$phase9a_evidence_file" >/dev/null
test "$phase9a_watch_status" -eq 0
gh api "repos/HoboCY/Jarvis/actions/runs/$phase9a_run_id/artifacts"
```

本次预合并证明使用 PR 的 `full-matrix` label；`workflow_dispatch` 只在该 workflow
已经进入默认分支后用于未来 ref，不作为首次合并前的唯一入口。

## Review, risks and rollback

### Review record

初审发现包括 sandbox pathname TOCTOU、E2E 缺少 Node 24 runtime、bypass 扫描面过窄
以及报告测试计数不准确；均已修复。复核又指出 foreign proc-fd 被两次 sudo pathname
使用的非原子窗口，以及 `appendSwitch`/`appendArgument` 的单/双引号和 whitespace
变体扫描缺口；现由 Python mutator 自身持有并验证 descriptor 后执行 mutation，合同
测试覆盖固定 mutator 安全属性与各 bypass 变体，报告已记录最新 Node24/Linux 证据。
两轮 review findings 均已关闭：Standards `PASS`（P1=0、P2=0），Spec `PASS`
（P1=0、P2=0）。残余仅为正式发布外部门禁的 `UNVERIFIED` 边界；validated
implementation candidate 的 PR #7 Run #27 与 remote artifact 已 `PASS`，Run #26
的 previous candidate 状态仍明确为 `REMOTE_PARTIAL_FAILED`。

本票完成了本地公开 seam/TDD 合同检查。独立 Debian 容器已提供当前 descriptor
pin、冷 runtime、D-Bus 和真实 renderer 证据；Run #26 的 renderer success 是历史事实，
Run #27 已补足 validated candidate 的同 SHA GitHub Actions 与完整矩阵证据；本地 Node
25 仍仅作开发验证。

回滚可按文件范围恢复本票变更：先移除 CI 对新脚本和新 scripts 的引用，再删除
sandbox helper/test 与 runner/scenario handoff 改动；不会删除用户 profile、
credential、数据库或其它生成物。不得用回滚来隐藏真实 CI 失败。

真实 OpenAI Realtime/Responses、真人近场/远场唤醒、长时间误唤醒率、30 分钟
真实 idle CPU/RSS、物理手机音频路由、Developer ID 签名、notarization 和正式
生产发布均为 `UNVERIFIED`，不属于本次证明。

## 下一步

本报告是记录 Run #27 后形成的 evidence-only snapshot；报告形成时 PR #7 仍 Open / unmerged，
validated implementation candidate、Run ID、job conclusion 和 artifact 以 PR checks
与 remote artifact 为准。随后形成的文档提交自身 SHA 不得自引用为 Run #27 的
`headSha`；最终 PR head/run 由远程检查与最终答复给出。本次不得把 Run #26 的 partial
failure 或旧 `workflow_dispatch` 结果当作新候选成功证据，也未启动 Phase 9B。
