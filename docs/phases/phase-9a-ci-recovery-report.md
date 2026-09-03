# Phase 9A CI Recovery 报告

## 结论

当前结论：`LOCAL_GREEN_REMOTE_UNVERIFIED`。

本工作树已完成 Linux sandbox 路径、Desktop 测试拆分、Renderer observation
可靠性修复和 CI job DAG 的本地合同验证。由于当前环境没有 GitHub CLI，未能对
任务分支创建 PR 或触发/读取新的 GitHub Actions；因此不能把本地绿色写成远程
通过，也不能把 Phase 9A 标记为 `PASS`。

## Baseline

| 项目 | 值 |
| --- | --- |
| 用户提示中的 prompt baseline | `a028fca7212d1b63e347f65c4a444be693fa5c12` |
| 实际起始 SHA / 当前 origin/main | `198385d1429b46167858457a920b5f370858363b` |
| 结束实现 SHA（报告提交的 parent） | `c757004bc1d4f37235baf563a4e1480b5d4d6fb2` |
| 分支 | `codex/phase9a-ci-recovery` |
| 本地操作系统 | macOS arm64 |
| 本地 Node / pnpm | `v25.0.0` / `10.24.0` |
| 仓库要求 Node / pnpm | `24.19.0` / `10.24.0` |
| .NET SDK | `10.0.100` |
| Electron | `44.0.0` |

本机 Node `25.0.0` 不是目标 CI 的等价环境；其本地成功只能作为开发验证，
不能替代 Node `24.19.0` Linux 证据。

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
一致。fixture 和静态合同为本地证据；最新 Node 24.19.0 独立 Debian 证据见下表，
GitHub Actions 仍未验证。

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
通过 `14/14`（sandbox standalone `9/9`，workflow contract `5/5`）；覆盖脚本拆分、
CI 触发器/job DAG/tool versions/timeouts/artifact、Renderer handoff/startup 稳态、
descriptor pinning 以及生产面 sandbox bypass 禁止项。

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
  保留 PR/main push，增加 `workflow_dispatch`、concurrency、固定版本、timeout、
  冷缓存 Electron runtime 安装、早期 bounded evidence initializer、受控
  D-Bus/Xvfb 准备和 bounded artifact 上传。
- `package.json`：公开 `test:headless` 与 `test:ci-contract`。
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
release jobs 仅在 main push 或任意 ref 的 `workflow_dispatch` 运行；artifact
上传使用 `if: always()`，门禁步骤没有 `continue-on-error`。

Linux renderer evidence artifact 名称为
`jarvis-phase9a-desktop-renderer-evidence`，保存 bounded `scenario.json`，不
上传 userData、credential 或秘密。其它 artifact：
`jarvis-phase9a-mobile-static`、`jarvis-phase9a-e2e-reports`、
`jarvis-phase9a-android-debug`、`jarvis-phase9a-ios-simulator-debug`、
`jarvis-phase9a-macos-arm64-release-test`。

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
| `pnpm check:package-audit` | PASS（exit 0）；2 moderate、3 个由现有 audit policy 忽略的 high，未误报为零漏洞 |
| `pnpm typecheck` | PASS |
| `pnpm lint` | PASS |
| `pnpm test:headless` | PASS；contracts 7、realtime 12、API client 4、Desktop unit 160 / wake 17 / package 14；不含 Mobile/Renderer |
| `pnpm build` | PASS |
| `pnpm test:ci-contract` | PASS；combined 14/14（sandbox 9/9，workflow 5/5） |
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
| `pnpm --filter @jarvis/desktop run test:package` | PASS；14/14 package/build contracts，另验证 dist 中真实 wake fixture 与 CPU probe |
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
| `git status --short` | PASS；仅列出本票 12 个 owned paths |

此前独立 Debian 环境曾执行 Node `24.19.0` / pnpm `10.24.0` 的
`pnpm check:package-audit`、`pnpm typecheck`、`pnpm lint`、`pnpm test:headless`、
`pnpm build` 与 `pnpm test:ci-contract`；全部通过，并验证了 cold install 后显式
`install-electron` 与 Electron `44.0.0` runtime。那次真实 renderer/sandbox 证据
发生在本轮 descriptor pin redesign 之前，不能替代下面的当前 helper 集成结果。

## 独立 Linux 集成证据

| 环境 | 结果 | 证据边界 |
| --- | --- | --- |
| 独立 Debian 容器（Node `24.19.0` / pnpm `10.24.0` / Electron `44.0.0`，当前 descriptor pin；`CAP_SYS_ADMIN`/`CAP_SYS_PTRACE`） | PASS | 冷缓存 sandbox 从 `1000:1000:0755` 变为 `0:0:4755`；built renderer `exit=0`，evidence `188454` bytes、mode `0600`，`observationAvailable=true`、`childExitCode=0`、`stderrClean=true`、profile/userData 与两类 owned process cleanup 均为 true；无绝对路径或敏感值泄漏。普通无 `CAP_SYS_PTRACE` Docker 容器对跨 UID proc-fd dereference 会 `Permission denied`；GitHub hosted runner 的实际权限仍属远程 `UNVERIFIED` |
| GitHub Actions `desktop-renderer-linux` | NOT_RUN / UNVERIFIED | `gh` 不可用，尚未运行同一候选 SHA |

## GitHub Actions verification

| Run | Commit SHA | Job | Conclusion | Artifact |
| --- | --- | --- | --- | --- |
| #23 / `33623011371` | `a028fca` | phase-0 Test workspace renderer | failed（原始 baseline） | none recorded |
| #24 / `33719867602` | `198385d` | phase-0 Test workspace renderer | failed（实际 baseline；sandbox SIGTRAP） | none recorded |
| PR run | `PENDING` | backend-quality | NOT_RUN / UNVERIFIED（`gh` unavailable） | none |
| PR run | `PENDING` | workspace-quality | NOT_RUN / UNVERIFIED（`gh` unavailable） | none |
| PR run | `PENDING` | contracts-security | NOT_RUN / UNVERIFIED（`gh` unavailable） | none |
| PR run | `PENDING` | desktop-renderer-linux | NOT_RUN / UNVERIFIED（`gh` unavailable） | `jarvis-phase9a-desktop-renderer-evidence` |
| PR run | `PENDING` | mobile-static | NOT_RUN / UNVERIFIED（`gh` unavailable） | `jarvis-phase9a-mobile-static` |
| Full Matrix dispatch | `PENDING` | e2e | NOT_RUN / UNVERIFIED（`gh` unavailable） | `jarvis-phase9a-e2e-reports` |
| Full Matrix dispatch | `PENDING` | android-native | NOT_RUN / UNVERIFIED（`gh` unavailable） | `jarvis-phase9a-android-debug` |
| Full Matrix dispatch | `PENDING` | ios-native | NOT_RUN / UNVERIFIED（`gh` unavailable） | `jarvis-phase9a-ios-simulator-debug` |
| Full Matrix dispatch | `PENDING` | macos-release-smoke | NOT_RUN / UNVERIFIED（`gh` unavailable） | `jarvis-phase9a-macos-arm64-release-test` |

没有把 #24 当作修复后证据，也没有把 skipped 写成 passed。远程实际 job
conclusion、artifact 上传和 Node 24.19.0 生效状态，必须由主代理在具备远程
权限后补写；在此之前阶段状态保持 `LOCAL_GREEN_REMOTE_UNVERIFIED`。

### 用户可执行的远程验证命令

以下命令供具备 GitHub 权限的操作者执行；它们不会改变本报告当前的远程状态，
只有实际运行结果才能更新上面的 `NOT_RUN / UNVERIFIED` 记录：

```sh
gh auth status
git push -u origin codex/phase9a-ci-recovery
gh pr create --base main --head codex/phase9a-ci-recovery --title "ci: restore green CI and isolate release gates" --body-file docs/phases/phase-9a-ci-recovery-report.md
gh pr checks --watch
phase9a_candidate_sha="$(git rev-parse HEAD)"
gh workflow run .github/workflows/ci.yml --ref codex/phase9a-ci-recovery
phase9a_run_id="$(gh run list --workflow .github/workflows/ci.yml --branch codex/phase9a-ci-recovery --event workflow_dispatch --commit "$phase9a_candidate_sha" --limit 1 --json databaseId --jq '.[0].databaseId')"
test -n "$phase9a_run_id"
gh run watch "$phase9a_run_id" --exit-status
gh run view "$phase9a_run_id" --json headSha,status,conclusion,jobs
gh api "repos/HoboCY/Jarvis/actions/runs/$phase9a_run_id/artifacts"
```

## Review, risks and rollback

### Review record

初审发现包括 sandbox pathname TOCTOU、E2E 缺少 Node 24 runtime、bypass 扫描面过窄
以及报告测试计数不准确；均已修复。复核又指出 foreign proc-fd 被两次 sudo pathname
使用的非原子窗口，以及 `appendSwitch`/`appendArgument` 的单/双引号和 whitespace
变体扫描缺口；现由 Python mutator 自身持有并验证 descriptor 后执行 mutation，合同
测试覆盖固定 mutator 安全属性与各 bypass 变体，报告已记录最新 Node24/Linux 证据。
两轮 review findings 均已关闭：Standards `PASS`（P1=0、P2=0），Spec `PASS`
（P1=0、P2=0）。残余仅为 GitHub Actions、远程 artifact 和其它外部 gate 的
`UNVERIFIED`，不改变当前 `LOCAL_GREEN_REMOTE_UNVERIFIED` 状态。

本票完成了本地公开 seam/TDD 合同检查。独立 Debian 容器已提供当前 descriptor
pin、冷 runtime、D-Bus 和真实 renderer 证据，但 GitHub Actions 同 SHA 证据仍缺失；
本地 Node 25 仅作开发验证。

回滚可按文件范围恢复本票变更：先移除 CI 对新脚本和新 scripts 的引用，再删除
sandbox helper/test 与 runner/scenario handoff 改动；不会删除用户 profile、
credential、数据库或其它生成物。不得用回滚来隐藏真实 CI 失败。

真实 OpenAI Realtime/Responses、真人近场/远场唤醒、长时间误唤醒率、30 分钟
真实 idle CPU/RSS、物理手机音频路由、Developer ID 签名、notarization 和正式
生产发布均为 `UNVERIFIED`，不属于本次证明。

## 下一步

当前 scoped code/CI commits 已完成且最终 SHA 已锁定。用户/操作者需推送当前分支，
以最终 HEAD 创建 PR，等待 core jobs，再对同一最终 SHA 通过 `workflow_dispatch` 执行
Full Matrix；记录每个 job 的实际 conclusion、artifact 和失败日志。远程验证完成前
不得标记 Phase 9A `PASS`。
