# Phase 9B Result

## Phase 9B-R 当前执行记录 — 2026-09-10

- 安全门禁：`RESOLVED_NO_REUSABLE_CREDENTIAL_EXPOSURE`。依据用户明确的非敏感确认，
  本次没有仍有效或可复用认证材料的泄露；不要求轮换 Azure OpenAI / DeepSeek Key。
  此结论不抹去下文的历史 UI 输出事件，也不重现任何暴露值。
- 起始 HEAD：`243d6db220ff2b00bcde4fc32df762d8cc7076f5`；远端分支和 PR Head
  已重新核对一致。Base 为 `5df7533141107585cfbaa90a9c40d78a7b0b959a`。
- 执行范围：现有 PR #8 / `codex/phase9b-desktop-golden-path`，仍为 Draft；
  不新建 PR、不合并、不进入 Phase 9C。
- 当前阻塞：新环境的官方浏览器登录未在 15 分钟内完成。2026-09-10
  15:00:46 UTC 收到固定状态 `AUTH_TIMEOUT` / `AUTH_RUNTIME_REMOVED`；随后仅检查
  目录元数据，确认该助手所属的临时认证运行目录剩余数为零，未读取认证文件内容。
  本次协议源码提交为 `e873c9e39e4fa43a6a1db1720e9f1c310c5bed85`，但原生协议任务
  没有启动，无 A/B/C 结论，也没有 Provider 请求或 targeted / A–J run。
  这属于认证前置条件未完成，安全门禁保持 resolved；下一次必须重新创建独立环境。
- 安全输出限制的离线合同 85/85 通过，lint 通过；独立 Standards / Spec 复核无剩余
  P1/P2。后续输出边界检查发现旧进程摘要仍有无来源的 length / digest 通道，
  supervisor 已改为 observed / suppressed 布尔状态；直接 writer 和 bundle validator
  也已拒绝通用输出摘要。完整合同 90/90、harness lint 通过，独立追加复核无剩余
  P1/P2，重点测试复跑 25/25 通过。
  未据此认定发生凭据泄露，安全事件的 resolved 结论保持不变。
- `appsettings.secrets.json` 和 `secrets.json` 已加入精确文件名 Git 忽略规则；
  元数据检查确认未跟踪、未暂存，example 模板仍可跟踪，未读取凭据内容。
  原工作树仍保留既有 Phase 9A 分支及文件；共享 Git 本地排除规则已保护两个工作树，
  两边对应文件的跟踪数和暂存数均为零，example 模板仍可跟踪。
- 安全输出限制的本地提交为 `40ec81c2894474c4783cfd62f5bae6080c5ea6b7`，
  尚未作为最终候选或推送后的 CI 结论。
- 用户已说明实际 Provider Key 位于 `appsettings.secrets.json`；其具体位置待确认。
  两个工作树中的完整文件名检查未找到该文件，未读取内容；后续不得静默使用旧默认来源替代。
- Desktop 正常退出、单次自动轮换、实际 SignalR 连接控制、Main 会话选择持久化已接入。
  生命周期复审发现的已确认但未激活连接、终态重试、请求代次与连接绑定、切换状态/action、
  跨会话 task 快照问题均已修复并关闭代码级 P1/P2。
- 最终源码独立复跑：Desktop unit 222/222、共享 Realtime-agent 13/13 通过；
  实际 built Electron renderer 场景通过，stderr 干净、所属进程全部退出、临时 profile 已删除。
  实际 App 覆盖等待 A secret 时切换 B 后拒绝迟到的 A、B 空任务与全局通知保留、
  B 加载失败保留 A、同 A 重载；其余绑定及终态交错由 unit 合同覆盖。
  先前 missing-observation 失败保留，原因未确定；最终 Standards / Spec 追加复审完成，
  无剩余 P1/P2，实际 App surface 的离线验证缺口已关闭。
  这些结果不替代真实后端、SignalR/WebRTC 或 live 验收。
- 第二步已保存为本地提交 `90e500be047d43c78086de79ee0ae3d0f5e2af80`，尚非最终候选。
- 后续 Live J 范围复核发现第二步仍有 artifact 恢复 P1：启动只拉未完成任务，
  任务转换又丢弃 manifest，因此完成任务的产物不能在 renderer 自动恢复。
  使用现有 API 有界恢复只读 manifest 的补片已实现；部分扫描结果有可见提示，重复
  扫描不累积超出窗口。初次完整 unit 为 227/228，退出时序断言在并行检查下失败，
  该文件单独运行 21/21 通过；现已改用受控 monotonic 时钟。最终独立复跑为
  230/230、typecheck、lint、build 和 built renderer 均通过；实际界面等待完整恢复
  状态，所属进程和临时 profile 均已清理。这些仍是离线证明。
- Gap 3 / Live J 的终态恢复补片复用同次有界全状态查询，以只读 identity/status
  区域恢复无 artifact 的终态任务，并沿用会话绑定隔离。
- 终态恢复首个补片通过 233/233 unit，但独立 public-seam 检查复现了旧全状态快照
  覆盖新终态事件、不同 HTTP 快照导致同一任务跨区域重复。首轮修复关闭这两例后，
  又复现刷新开始前已到达的终态被旧快照丢弃；现已统一两个投影的实体版本合并。
  复审还发现初始 connected 可先于会话选择恢复，触发不带 Conversation 过滤的查询。
  完整空快照清除旧事件来源的任务，部分扫描保留有界结果；52 项 feed 合同及五种
  公共接口快照/事件交错检查通过。启动时未绑定会话的 task 查询与事件投影已阻断。
- 最终 actual App 离线场景移除了人工 Load 和断线期间的通知事件注入，验证自动
  选择恢复、断线期间后台完成的无 artifact 任务及通知在 connected 后通过 HTTP
  恢复；无关 waiting/artifact 任务保留。相同连接 revision 的回放不再触发重复补拉。
  对 7 个冻结 Desktop 文件的独立验证为 241/241 unit、typecheck、lint、build、
  built renderer 全部通过；renderer 9.49 秒，stderr 干净，所属进程组和临时 profile
  已清理，验证前后源码 hash 一致。独立 Standards / Spec 审查无剩余 P1/P2。
  此结论仅关闭 Desktop 离线门禁，协议探针及真实后端/live 验收仍未执行。
- 协议探针初稿检查点为 RED：语法通过，独立合同执行仅 1/7 通过。
  预审发现历史 pending 项匹配、跨进程请求 ID 去重、认证目录隔离及新 Turn 证明缺口；
  实际 CLI/transport 的清理、取消、输出及预算边界也尚待补齐回归。
  这些是尚未执行的 harness 缺陷，不是凭据泄露证据或真实 Codex 协议限制结论。
  修复与独立复核通过前不得启动认证或 native probe。
- 后续纯边界检查点 11/11 测试及 lint 经独立运行通过；重复 continuation 审计、
  额外历史 Turn、resolved generation 三项已通过窄范围追加复核。
  早先完整流程检查点为 RED（13/14，3 处 lint 错误，CLI 未完成）：旧完成通知格式
  与固定版本 schema 不符，且丢失 status。
- typed notification/history 补片的冻结源码已独立通过 14/14 和 lint；完成通知已采用
  固定版本的嵌套结构，正常通知不再引发解析失败，history 两种严格候选结构均检查
  受控选项和输入标志。生命周期审查尚未关闭。这些离线判定不证明 native 恢复能力。
- 无认证的真实 Node 子进程夹具复现了两处清理错误：信号退出被误判失败，主进程
  退出后仍存活的子进程组被误判已清除；夹具已全部清理。CLI 取消、有界写入、延迟
  reissue 判定和进程组退出验证仍须修复；这不是实际 Codex 执行或凭据暴露证据。
- 无回调的受控 transport 还复现了写入无界等待，以及 abort、fatal input、close 时
  未被接住的响应拒绝。原生 `serverRequest/resolved` 尚未接入当前进程的类型化
  registry；纯 registry 测试不证明 transport 已处理该通知。完成项的副作用分类和
  非成功完成的证据投影也仍属待关闭的生命周期门禁。
- 写入/清理补片的 20/20 合同及 lint 独立通过，但验收仍未通过：复核发现假夹具
  使用固定 PID，清理路径可能据此向非自有进程组发信号，已停止重复运行该版本。
  没有误杀或认证材料暴露的证据；须先隔离假夹具的生命周期控制与真实进程组控制。
  独立的真实 Node 管道检查还确认成功写入回调返回 null，原探针只接受 undefined，
  会把真实成功写入误判为错误。该检查的自有子进程与新临时目录已清理；修复须通过
  真实自有 Node JSONL 往返合同，不能只用无参数假回调证明。
  首次 stalled-write RED 在 wrapper 的 120 秒观察窗口内未返回统计，pass/fail 数为
  unknown。后续修正版本独立通过 22/22、lint 与前后源码一致性检查；假 spawn 默认
  无权访问宿主进程组，真实管道和清理测试使用本次自有 Node 子进程。追加独立审查
  已关闭这两项 P1 和 POSIX 测试的 Windows 边界 P2。
- typed item / resolved 通知补片初次 RED 为 25 项中 22 通过、3 失败；修后独立
  29/29 和 lint 通过，前后源码 hash 一致。复核发现同批次 input 后紧接的 fatal
  可能越过重启边界，item 外层也未校验当前请求的 Thread/Turn。
  另以公开接口复现显式不完整的 history 被批准用于 continuation；该边界须拒绝，
  正常原生 completion 的摘要格式仍应保留，两者不能混淆。
  三项修正后的冻结源码已独立通过 31/31（1.17 秒）、lint、ownership 与前后 hash
  检查，独立审查关闭全部三项发现。fatal-flow 直接断言零 restart、零 answer；
  continuation 的排除来自在第二进程前退出的控制流，并非独立计数断言。
  CLI/decision 补片在 worker 直接 Node 入口通过 40/40（21.02 秒），初始 RED 统计
  unknown；随后独立执行完整 `pnpm test:phase9b-live-contract` 得到 105/130 通过、
  25 失败（5.54 秒），报告的失败堆栈位置均在 probe 测试中。Eng live lint 通过
  （1.96 秒），5 个冻结文件前后 hash 全部一致。
  后续修正版由 worker 直接通过 47/47，并在 `pnpm exec` 串行入口通过 137/137；
  正常 package script 入口仍为 104 通过、32 失败、1 cancelled。两种入口并非只改变
  并发度，不能据此归因于并发。root 在测试执行前退出的纯元数据检查确认：`pnpm run`
  扩展后的 PATH 超出探针的 1024 字符限制，产生 INVALID_ENVIRONMENT，直接 Node
  入口则未触发。须显式收紧测试进程环境并保留生产限制；未输出 PATH 内容，也未
  在检查中开启认证或 native 门禁。
  测试环境窄修后，worker 的正常 package 入口已通过 137/137；独立整套调用未取得
  可恢复的结束统计，保持 UNVERIFIED。独立的 5 文件 hash、Eng lint 与两个语法
  检查均通过。审查剩余三项：确认 continuation 后遇到同批 reissue 的计数保真、
  B 的 completed-with-error 判定，以及 CLI 的真实 child-spawn/group-absence
  握手证明。最终修正先得到 RED 0/2，再 GREEN 2/2；root 独立执行正常 package
  入口已通过 139/139（70.56 秒），零失败、取消或跳过。Eng lint 通过（2.35 秒），
  两个语法检查通过，执行后 5 个冻结文件全部匹配。独立审查关闭最后三项发现；
  两个真实 Node CLI 信号合同均先等待动态 spawn 握手，再外侧确认对应自有进程组消失。
  早期复核还发现停止首进程期间终态丢失、迟到 reissue 被忽略、真实 resolved 被误归为 C、
  continuation 完成与计数投影不准确，以及固定指令与 validator 不一致。
  当时 CLI 测试仅证明 SIGTERM 到注入清理函数，尚未覆盖实际 probe finally 与自有进程组
  生命周期完整链路；当时 SIGINT 只有代码接线证据。这些早期缺口均已由后续离线
  合同与独立审查关闭。真实 native 恢复能力仍待新的受控协议探针证明。
- 当前等待完成新环境认证后运行固定 Codex 版本的重启协议探针。新的协议探针、targeted run、最终 A–J run
  均尚未执行，尚未冻结最终候选；历史 CI / live 结果不能证明本轮改动。
- 文件规则审计发现服务 publish 暂存未显式排除本地 secrets 与生成的 Production
  配置，须在发布前补齐排除和最终文件清单门禁。未读取实际配置内容，也没有新的
  暴露证据。Desktop ASAR 已有严格正向文件清单，实际打包时继续验证该门禁。
- 新一轮运行须重建独立 CODEX_HOME、Desktop profile、数据库、bearer、设备身份、
  allowed root、运行目录、owner marker 和 launchd labels；旧资源及登录不得复用。

以下是保留的原 Phase 9B 历史结果；其 `LIVE_PARTIAL` 状态未重新标记为 PASS。

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
