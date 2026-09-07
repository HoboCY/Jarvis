# Phase 9B Result

**状态：`LIVE_PARTIAL`。** 已使用真实打包 Desktop、Azure OpenAI Realtime、DeepSeek Responses
和 Codex App Server 执行本轮验收。A/E/F/G/H 通过；B/C/D 保留 UNVERIFIED；I 失败；
J 在手动加载原会话的明确范围内通过。未合并本分支，未开始 Phase 9C。

最终 live run 为 `e6823a71-5a51-459f-89b8-52bbeee12bc0`，执行窗口为
2026-09-06 16:19:00.782–16:43:09.377（Asia/Shanghai）。证据时间使用 UTC。
本报告只把该 run 绑定到其实际安装的代码候选；早期 run 的结果不转移到最终候选。

## Phase 9A Merge

- 原 PR [#7](https://github.com/HoboCY/Jarvis/pull/7) 已以 head
  `12598a6998ca6b51c8bfac1918f8c7e6ad102143` 完成普通 merge。
- 合并基线为 `5df7533141107585cfbaa90a9c40d78a7b0b959a`，父提交分别为
  `198385d1429b46167858457a920b5f370858363b` 和上述 PR head。
- Main [Run #29](https://github.com/HoboCY/Jarvis/actions/runs/33941226361) 与合并 SHA 一致，
  十个 job 全部成功，七份预期 artifact 存在且未过期，2026-09-06 已复核。
- 摘要 ZIP 元数据 SHA-256 为
  `2aae67b54521da2cac661d0acf940d342b1c5dcbd6224d19420b6839e1bfbaa0`。
  下载返回 HTTP 403；生成 job 和元数据已验证，归档内 JSON 仍为 UNVERIFIED。

## Phase 9B Candidate

- 分支：`codex/phase9b-desktop-golden-path`，从上述 merge 创建独立 worktree。
- **真实运行代码 SHA：`daea6e626592cab238c579c31fa65e914215e354`。**
  后续 CI 修复及文档提交以 PR head 标识，未重新进行真实 provider 调用；不能把本轮结果
  当作后续提交的重新 live 验证。
- 原 worktree 及其未跟踪的 Phase 9A 结果摘要保持原样。

| 实际解包安装的产物 | 字节数 | SHA-256 |
| --- | ---: | --- |
| Desktop ZIP | 139894735 | `06851ff15c85e002e62116a2d2437bbc772b9852b199dfd43dcfa466dc77235d` |
| API tar | 51005236 | `2948e9bdf6b046ddc6ad44a9419f573a41316e8d9f4cd28f69381b1727f00c47` |
| Device Node tar | 50907000 | `696e7acb032d44a0202313a44734d3aaf999960fcbb01c1ce711c2b4f57367f9` |

本分支增加调用前预算准入、隔离 profile、受限音轨观察和证据导出。同时修复正常运行路径中的
默认 Desktop 选择、重复 `app-server` 参数、真实 Codex completion 投影、异步迭代器取消、
持久取消与迟到事件、续租并发冲突，以及审批请求的执行范围。正常路径修复并非全部由 live flag 控制。

审批唯一索引从 `(DeviceId, RequestId)` 调整为 `(DeviceId, ExecutionId, RequestId)`，
允许不同执行合法复用 Codex 的原生 request ID。迁移
`20260906075325_Phase9BApprovalRequestScope` 的 Up 兼容旧索引下已有数据。
**写入跨执行重复 request ID 后，Down 不能无损恢复旧唯一索引。** 回滚应恢复升级前数据库备份，
或先制定明确的数据处理方案；仅回退二进制或删除临时 harness 不能完成数据库回滚，不自动删除用户数据。

## Live Environment

用户于 2026-09-06 确认使用现有 ASP.NET Core API User Secrets 中的 Azure/DeepSeek 配置，
无需再次填写凭据或设置 `.env`。运行仅选择所需 provider 配置，保留环境变量及命令行覆盖优先级。

| 项目 | 实际值或边界 |
| --- | --- |
| 平台 | macOS 26.6.2，arm64 |
| 工具链 | Node 24.19.0、pnpm 10.24.0、.NET SDK 10.0.100、Electron 44.0.0 |
| Realtime | Azure OpenAI，`gpt-realtime-2.1-mini`，`alloy`，ApiKey |
| Responses / summarizer | DeepSeek，`deepseek-v4-flash` |
| Codex | 0.146.0；二进制 SHA `ae1d3ffe6d48aec6a4dc3f50e7eb8e0d11962485a6a9406c5a7012139383da02` |
| 登录与存储 | 新建 Codex home 经正常登录；独立 DB、profile、本地 bearer、安全 salt 和设备身份 |
| 服务 | 两个唯一 launchd label，自包含 API/Device Node，实际打包 Desktop；仅监听 loopback |
| 运行限制 | 30 分钟硬时限；后台 worker 禁用，provider 自动重试为 0 |

DeepSeek 的后台执行、存储后 retrieve 与 provider cancellation 不在所选适配器的能力范围内，
按用户确认的 provider 变更排除，永不标记 PASS。[DeepSeek 官方文档](https://api-docs.deepseek.com/guides/responses_api/)。

| 最终 run 预算 | 已用 / 上限 |
| --- | ---: |
| Provider 请求 | 8 / 12 |
| Realtime 连接 | 3 / 4 |
| Delegation 尝试 | 2 / 2 |
| Codex 任务 | 5 / 5 |
| 重试 / 接管 | 1 / 2 |

额度在发送前持久准入，跨进程重启累计；该次重试来自 I 的 Node 接管。以上是最终 run 的额度，
不是此前所有诊断运行的合计。未超限；最终采证后停止了所有本轮服务及付费调用。

## Live Scenario Results

场景整体状态与 `evidence.json` 一致；子项用于显示已获得的证据，不把局部成功扩大为整个场景通过。

| 场景或子项 | 状态 | 实际观察 |
| --- | --- | --- |
| A — 隔离安装整体 | PASS | 打包 Desktop 和两个唯一 launchd 服务实际运行，执行设备在线 |
| A — 健康与访问边界 | PASS | 认证 health/ready/diagnostics 均 200，未认证 diagnostics 401，非回环访问拒绝 |
| A — 窗口生命周期 | PASS | Cmd-W 后 API/Node/Desktop 仍运行；Finder 恢复同一窗口且未增加 RTC 连接 |
| B — Realtime 整体 | UNVERIFIED | 文字及音轨通过，自动轮换缺证据，并观察到旧 session 未退役 |
| B — 真实文字往返 | PASS | Desktop 发送固定测试内容，真实 Azure 回复准确匹配，归一化消息持久化 |
| B — 远端音轨 | PASS | 三个实际 SDK 连接均观测到一个 remote audio track，状态 live；不代表真人听感 |
| B — 自动轮换 | UNVERIFIED | 产品阈值 50 分钟，超过本轮 30 分钟上限；未改时钟或延长预算来伪造通过 |
| B — 正常退出后的 session 退役 | FAIL | 初始 RTC 在 Desktop 正常退出后仍为 Connected，EndedAt 为空；需继续诊断生命周期 |
| C — 委派整体 | UNVERIFIED | 两次真实委派成功，但未建立丢失 SignalR 后补拉的时间窗口 |
| C — 创建、结果与通知 | PASS | 两次 Realtime `delegate_task` 均调用 DeepSeek，每项只有一个 execution 和成功事件；Action Center 与完成弹窗可见 |
| C — 断线补拉 | UNVERIFIED | 观察时两项已终态，未能在完成前断开 Desktop；没有真实离线完成证据 |
| D — provider 后台 retrieve/cancel | UNVERIFIED | `UNSUPPORTED_DEEPSEEK_BACKGROUND`，不执行也不记 PASS |
| D — 适用的本地取消事实 | PASS（复用 I） | I watchdog 的持久取消请求至最终 Cancelled 为 453ms；不是独立 D 运行或 DeepSeek 取消 |
| E — 本地只读任务 | PASS | 真实 Codex 读取允许根内 fixture，返回准确测试值；fixture/外部 canary 未变，Desktop 结果可见；18.042s |
| F — 请求、回答与继续执行 | PASS | 真实原生 request_user_input，经 Desktop 回答，同一执行正常完成；46.549s |
| F — 回答幂等 | PASS | 原幂等键重放 200，冲突回答 409；answer 事件始终一条 |
| G — 拒绝写入 | PASS | Desktop 拒绝真实审批后以 `approval_denied` 终止，无输出文件，无重复写入；36.399s |
| H — 仅批准本次 | PASS | Desktop 批准一次，真实文件编辑产生预定义 37 字节文件及一条正确 artifact；40.528s |
| G/H — 审批幂等与范围 | PASS | 同一 device 的两个 execution 可各用原生 request ID；重放 200、冲突 409，文件状态不变 |
| I — 重启后的交互身份 | PASS（子项） | Node 单独重启，Task/Execution/Thread/Turn/Input 身份均保留；Desktop 仍显示待回答项 |
| I — 回答后的原生执行恢复 | FAIL | 重启后约 63s 内已回答，但原生 turn 未继续；180s watchdog 超时后取消，总计 181.070s |
| J — 冷启动 HTTP 重建 | PASS（手动加载） | Desktop/API 重启，凭据来自 encrypted-store；手动加载原 conversation，10 条历史消息和任务结果可恢复 |
| J — 新连接与连续序号 | PASS | 手动加载原会话后重连 RTC，真实回复追加为序号 11/12；最终原会话序号 1–12 唯一连续 |

I 的持久回答在 watchdog 前已经完成。受限原生事件计数只见 task_started、user_message、
function_call 各一条，未见 function_call_output；现有证据定位到原生续执行未完成，尚不足以断言
SDK 内部根因。没有通过新建任务或新 turn 替代原执行，也没有为碰运气追加调用。

J 冷启动先自动创建了一个空会话。操作者在 Desktop 的会话选项中手动输入原 conversation ID
并加载，再断开并重新连接语音。因此 J 证明 HTTP 持久化恢复和原会话可继续使用，
**不证明自动恢复最后选择的会话**。中间空会话的 RTC 已显式断开；B 记录的初始 RTC 未退役问题仍存在。

## Persistence Evidence

原 conversation：`01a075cd-058e-7d17-9bd8-affeeeaae2b0`。
执行设备：`01a075cc-feea-70bd-bc25-b38c4d8bbc50`。
最终保留 12 条原会话消息、7 个 task / 7 个 execution、2 个审批、2 个已回答 input、
11 条通知及 1 条 artifact。另有 J 自动创建的一个空会话；不能把它描述为恢复的原会话。

| 用途 | Jarvis task ID | 最终事实 |
| --- | --- | --- |
| C1 | `01a075d1-2fcf-707d-b385-59e1f4207cd4` | Succeeded，一个成功事件 |
| C2 | `01a075d2-6a32-7107-a777-4286d81aced5` | Succeeded，一个成功事件 |
| E | `01a075d3-46ba-7d2f-bb60-b6475a82f1c9` | Succeeded，只读结果匹配 |
| F | `01a075d4-0ba5-7083-b980-6ed3add4d9e1` | Succeeded，一次回答 |
| G | `01a075d5-73ba-7907-93e9-2bf501009c61` | Failed / approval_denied，无文件 |
| H | `01a075d6-9a97-7c33-ba29-9210a27f9e3b` | Succeeded，一次审批、一条 artifact |
| I | `01a075d8-0206-788b-87aa-bc1b6924963e` | Cancelled，之前恢复超时 |

H 的期望内容在任务创建前固定为测试值的 UTF-8 字节加一个 LF。实际文件 37 字节，
SHA-256 `aa9bfb27a3b60f1ce08216df68378794b81d40b402c77f2ead2253e52c2d8713`；
持久 artifact 的字节数、SHA 和允许路径均匹配，重放审批后 mtime/SHA 未变。
fixture 为 67 字节，SHA `b91a405403d7b7eb4bb0502d141fc6593b578e0fa0539fa7aac99e90b8f2390f`。

所有观察到的 outbox 均已发布，最大 Attempts 为 0；其中 notification.created 为 11，
notification.updated 为 22，task.userInputRequired / Answered 各 2，approval.required / resolved 各 2。
C 的预算以持久准入 ledger 的 2 次为准；空 sourceMessageIds 导致查询口径中的 delegationObserved 为 0，
该诊断计数不能代替真实调用次数。完整 execution/interaction ID、外部 ID 哈希及长度/SHA 见受限证据包。

## Security Result

**交付文件检查 PASS；全程交互安全不能标记 PASS。** 本轮前期 UI 工具的自动输出曾带出既有
OAuth 回跳凭据、私密文档内容及 fixture 预览。这些内容没有转存到报告、仓库或证据包；
此处不重现其值。文件扫描通过不能抹去先前工具输出的暴露事实。

最终证据在临时根删除前，对实际选用的 provider 凭据、本轮新 bearer、salt、测试值和设备凭据
完成扫描；后加的 cleanup-check 再经选用 provider 凭据及结构检查。报告及源码另经仓库 secret scan。
证据只包含白名单字段、内部 UUID、外部 ID 哈希、状态、计数、长度与 SHA。
无原始 prompt、transcript、provider DTO、JSONL、数据库或音频文件。目录为 0700，文件为 0600。
这些结论限于实际检查对象，不表示扫描了用户所有日常 Secrets。

清理已确认：本轮临时根及独立 Codex 登录文件已删除；两个唯一 launchd label、所属 API/Node/Desktop
及 watcher 进程均不存在；本轮专用 safeStorage Keychain 项删除后查询返回不存在。
自动化持久 UI 会话已重置。用户的日常数据库、登录 home、服务及未关联文件未被清理。

## Evidence

证据目录（被 Git 忽略）：
`artifacts/live/phase9b/e6823a71-5a51-459f-89b8-52bbeee12bc0/`。
包含 22 个受限 artifact JSON，加 `evidence.json` 与 `manifest.json`，合计 113608 字节。

- `evidence.json` SHA-256：`10294ecf7bd2a84d09528c74ac2693535259e327e4d41549237bcf7e9fb5da29`。
- `manifest.json` SHA-256：`b669e4cf165d71dc5be32d031fb7e4869b7630e0ed333b8a9d39063e34c7e48d`。
- `scenario-checks.json`：Desktop 操作、场景边界和 HTTP 核对。
- `session-check.json`、`pre-node-restart.json`、`pre-cold-start.json`：受限持久化前后快照。
- `realtime-track-check.json`、`watch-*.json`、`replay-*.json`、`conflict-*.json`：音轨、watchdog 和幂等结果。
- `cleanup-check.json`：所属资源清理后的缺失检查。

验证命令：

```sh
pnpm phase9b:validate-live-evidence artifacts/live/phase9b/e6823a71-5a51-459f-89b8-52bbeee12bc0
```

根代理与独立 reviewer 均验证了 schema、相对路径、全部字节数/SHA、候选身份与文件权限。
原始 DB 和原生日志仅用于本轮私有检查，未作为交付证据保留。

## Local Verification

除特别注明外，以下完整候选检查在 `daea6e6` 上执行，均 exit 0。

| 命令或检查 | 结果 |
| --- | --- |
| `dotnet restore Jarvis.sln --locked-mode`、`dotnet tool restore` | PASS |
| `dotnet ef migrations has-pending-model-changes --project src/backend/Jarvis.Infrastructure/Jarvis.Infrastructure.csproj --startup-project src/backend/Jarvis.Api/Jarvis.Api.csproj --context Jarvis.Infrastructure.Data.JarvisDbContext` | 无漂移 |
| `dotnet build Jarvis.sln --configuration Release --no-restore` | PASS |
| `dotnet test Jarvis.sln --configuration Release --no-build --no-restore` | 340/340，0 failed / skipped |
| `dotnet format Jarvis.sln --no-restore --verify-no-changes` | PASS |
| `dotnet list Jarvis.sln package --vulnerable --include-transitive` | 未报告漏洞 |
| `pnpm install --frozen-lockfile`、`pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm check:package-audit` | PASS；执行于 `423e738`，其 workspace/frontend 与最终候选相同 |
| `pnpm test:headless` | 224 项全部通过；同上 workspace 身份 |
| `pnpm check:openapi` + 生成文件 `git diff --exit-code` | 字节一致 |
| `pnpm check:codex-schema`、`pnpm check:codex-schema-canonical`、`pnpm test:codex-schema-canonical` | PASS，canonical 测试 2/2 |
| `pnpm check:secrets`、`pnpm test:secret-scan` | PASS，fixture 1/1 |
| `pnpm test:service-manifest`、`pnpm test:ci-contract`、`pnpm test:phase9b-live-contract` | 分别 20/20、41/41、71/71 |
| `pnpm --filter @jarvis/desktop test:renderer-scenario:built` | PASS，7.76s |
| `bash tests/e2e/run-e2e.sh` | 八个命名场景 + 89 API + 51 Node 回归通过，37.3s |
| `bash eng/scripts/publish-macos-arm64.sh` | PASS，生成实际使用的自包含服务包 |
| `pnpm package:desktop:mac` | PASS，14 个包装测试，隔离安装及 encrypted-store 重启检查通过 |
| Electron 44 / Realtime SDK 0.17 实际 loopback TLS 准入检查 | 拒绝和约 2s 超时均 0 次出站；允许连接预留两个请求；302 目标收到 0 次请求 |

关键修复先在公开 API、实际 child process 或原生 JSONL 协议 seam 重现失败，再验证通过。
最终并发/取消定向检查覆盖 9 个 Node 与 27 个 API 用例；完整测试包含这些用例。
离线测试不会访问付费 provider，不能替代上表未通过的真实场景。

2026-09-07 的 CI 补充修复保留临时目录安全检查，仅让 preflight 测试使用私有临时父目录。
并发 JSONL 夹具改由 `/bin/sh` 读取临时脚本，避免 Linux 直接执行刚写入的脚本时触发
`Text file busy`。产品代码在 `Process.Start()` 失败时立即释放未启动的对象、清空字段并
原样抛出启动异常，防止后续 `DisposeAsync()` 的“未关联进程”覆盖原始原因；不吞掉退出等待异常。
Linux 完整 live contracts 已在带 init、可执行临时目录且禁用网络的容器中通过 71/71。
缺失可执行文件的公开 client 回归先在旧代码下复现清理异常覆盖，再验证保留
`Win32Exception` / `NativeErrorCode=2`。修复后 Device Node 测试在 macOS 与 Linux 各通过 78/78；
macOS 完整 live contracts 也通过 71/71。

## GitHub Actions

2026-09-07 用户明确要求继续推送后，正常具名分支推送成功，远端 SHA 与
`1f09342027eaf69c574393bfab97af1788bc09f1` 核对一致。此前审批模式为 Never 时的拒绝
已作为历史事实记录在该提交中，当前推送阻断已解除。

已创建 [draft PR #8](https://github.com/HoboCY/Jarvis/pull/8)，以 `full-matrix` 验证最终提交，
禁止自动合并。远端 CI 的实际状态见 [PR checks](https://github.com/HoboCY/Jarvis/pull/8/checks)；
最终 head、run URL、十个 job 和七份 artifact 的核对结果在 PR 描述与交付回复中记录，
不能用旧 run 或本地测试代替。live 证据仍绑定实际安装的 `daea6e6`，后续文档提交不改写该身份。

首轮 [Run #32](https://github.com/HoboCY/Jarvis/actions/runs/34078922161) 对应
`275c69d804e55c6d87595131dbad1db130d556ed`，因上述临时目录及进程启动失败路径未通过。
workspace、Desktop renderer、mobile-static、Android 和 iOS 原生检查成功；E2E 与 macOS
因前置失败被跳过，summary 随之失败。该 run 不计为最终远端通过证据。

## Review

独立 reviewer 复核最终代码，没有未关闭的 P1/P2 代码发现；数据库 Down 的限制已在本报告明确。
独立 evidence review 验证了 22 个 artifact、manifest、权限及场景分级，没有交付证据阻塞项。
review 明确保留 B/C 缺口、I 原生恢复失败、J 手动加载范围及交互安全暴露，未将其判为验收通过。
D 的 453ms 取自 I 的相同取消窗口，没有声称完成独立 D 或 provider 取消实验。

## Residual UNVERIFIED

仅列阶段外事项：真人声学与听感、实体手机音频、生产设备身份与 Keychain 部署、签名公证、
生产安装和组织级发布治理。阶段内 B/C/I 以及退出 session 生命周期问题已列于场景结果，
不得被归入这些阶段外事项。Phase 9A 摘要归档内容的 HTTP 403 限制见基线部分。

## Commits

| 代码提交 | 范围 |
| --- | --- |
| `e4d8e2db37eb7e48eb6ef0e87f241f1158da283a` | 隔离 Desktop live profile |
| `0fc78a07fc6d39a3d5ed71a227243832e482ec1c` | Node 配对后保留默认 Desktop |
| `070b5cca673020ea5e9ec931882fb936abaf378a` | App Server 命令只绑定一次 |
| `f90946285bfff6e08635239fa6712b4a0cc608ed` | 调用前预算、真实 completion、音轨和证据 seam |
| `423e738df09a26b43643478a61f4f799077a6eff` | Desktop 子进程保留预算控制环境变量 |
| `daea6e626592cab238c579c31fa65e914215e354` | 持久取消、迭代器并发、续租冲突及审批执行范围 |

`9c993668aa354da3d93e93cad764b8c2782a7873` 记录验收报告与回滚计划；其父代码候选就是本次真实运行 SHA。
`1f09342027eaf69c574393bfab97af1788bc09f1` 记录当时的远端策略阻断；以上提交已于
2026-09-07 推送。后续 CI 修复与交付文档提交由 PR commit 列表标识，最终 head 见交付回复。

## Next

Complete the unresolved Phase 9B live gate before Phase 9C.
