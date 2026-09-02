# Phase 8 实施报告：Desktop 集成验收与发布边界

## 结果

Phase 8 的代码和本机自动化验收已完成到可复核的 unsigned test artifact。离线
sherpa-onnx 真实模型、单轮唤醒、Desktop control panel、隔离安装/重启和现有
Control Plane 合同均已在本机验证；本报告不把这些结果扩大为真实 OpenAI、真人
声学、签名公证、生产部署或硬件保证。

当前发布结论：`代码/自动化 gate = PASS`，`正式发布 = UNVERIFIED`。目标发布环境
仍须使用 Node `24.19.0`，而本机是 Node `25.0.0`；所有 pnpm 命令因此出现
engine warning，不能作为等价 CI 证明。

## 交付模块与提交

| Ticket | 模块/交付 | 提交或证据 |
| --- | --- | --- |
| #2 | Desktop 真实 sherpa-onnx 离线唤醒词 acceptance、固定模型/fixture SHA | `8432f15 feat(desktop): add real wake-word acceptance` |
| #3 | packaged single-turn wake lifecycle 与回静音 | `fcd8002 feat(desktop): harden the single-turn wake loop` |
| #4 | local bearer 加密、owner-only 存储与重启恢复 | `c2951db feat(desktop): harden local bearer bootstrap` |
| #5 | truthful control panel、IPC envelope、action/retry/feed、真实 DOM recovery | `67a4a38 feat(desktop): make the control panel truthful` |
| #6 | root lint 基线、bounded CPU probe、package gate、声学 worksheet、本报告 | 当前工作树；由主代理在独立审查后生成 scoped commit |

本票只改动必要的 lint/package/acceptance seam 与 `docs/phases/` 文档；没有修改
Backend 业务代码、生成的 OpenAPI/Schema 或用户运行时数据。

## TDD RED → GREEN 证据

### Root lint 基线

RED：在本票变更前执行 `pnpm lint`，发现 4 个错误：renderer
`csp.test.ts` 的 `node:fs` 被生产 renderer restricted-import 规则拦截，且
`realtime-recovery-scenario.tsx` 存在一个 `prefer-const` 和两个未使用回调参数。

GREEN：为单个 `src/clients/desktop/src/renderer/csp.test.ts` 配置仅允许其读取
静态 HTML fixture 的窄规则覆盖；生产 renderer 源码仍保留 `fs`、`node:fs`、
`child_process` 和 `node:child_process` 的完整限制。将 recovery harness 的
runner 改为 `const`，并移除未使用的 session factory 参数后，`pnpm lint` 通过。

### Bounded CPU probe

RED：新增 CLI 测试首先因缺少
`src/clients/desktop/scripts/wake-word-cpu-probe.mjs` 而失败（3/3）。

GREEN：`runCpuProbe` 复用同一 production KWS 配置、锁定 runtime/model 和固定
fixture，限制 measured iterations 为 `1..10`、warmup 为 `0..3`，只输出脱敏
JSON；每次 stream 和 KWS 都在 `finally` 中释放。CLI 限制、未知参数不回显秘密和
真实模型测量均通过（3/3）。

实际生成的临时证据（均不提交）：

- `/tmp/jarvis-phase8-cpu-source.json`：source runtime/model，3 次 measured +
  1 次 warmup，`status=passed`，三次 silence 均未检测到唤醒词，`cpuTimeMs=402.58`、
  `wallTimeMs=163.61`。
- `/tmp/jarvis-phase8-cpu-dist.json`：`dist` runtime/model，1 次 measured、0 次
  warmup，`status=passed`，silence 未检测到唤醒词，`cpuTimeMs=205.7`、
  `wallTimeMs=91.28`。

`process.cpuUsage` 是进程聚合 CPU 时间，native runtime 的多线程可能使 CPU 时间
高于墙钟时间；该值用于重复性对照，不是 30 分钟空闲 CPU 结论。

## 实际验证命令与结果

命令均在 `/Users/hobo/projects/jarvis` 执行；Node `v25.0.0` / pnpm `10.24.0`，
仓库要求 Node `24.19.0`。

| 命令 | 结果 |
| --- | --- |
| `node --test src/clients/desktop/scripts/wake-word-cpu-probe.test.mjs` | PASS，3/3 |
| `node --test src/clients/desktop/scripts/wake-word-acceptance.test.mjs` | PASS，14/14 |
| `pnpm --filter @jarvis/desktop run typecheck` | PASS |
| `pnpm --filter @jarvis/desktop run lint` | PASS |
| `pnpm --filter @jarvis/desktop run test` | PASS，149 TS + 17 script + 14 build/package tests |
| `pnpm --filter @jarvis/desktop run build` | PASS |
| `pnpm --filter @jarvis/desktop run check:package` | PASS；dist build/contract、4 fixture 离线 acceptance，以及外部/source CPU probe 对 packaged-equivalent `dist` runtime/model 的测量均通过；该命令不生成或验证 ASAR |
| `pnpm typecheck` | PASS，contracts/realtime/api-client/Desktop/Mobile |
| `pnpm lint` | PASS |
| `pnpm build` | PASS，5 个 workspace build |
| `pnpm test` | PASS，255 个 TypeScript/脚本/构建测试 |
| `pnpm check:openapi` | PASS，生成结果 byte-for-byte unchanged |
| `pnpm check:codex-schema` | PASS，275 files、90 ClientRequest/70 ServerNotification/10 ServerRequest |
| `pnpm check:codex-schema-canonical` | PASS，275 files |
| `pnpm test:codex-schema-canonical` | PASS，2/2 |
| `pnpm check:secrets` | PASS |
| `pnpm test:secret-scan` | PASS，1/1 |
| `pnpm test:service-manifest` | PASS，20/20 |
| `pnpm check:package-audit` | PASS，3 个 high advisory 按仓库显式 ignore policy 忽略 |
| `pnpm --filter @jarvis/mobile bundle:android` | PASS，Metro release bundle |
| `pnpm --filter @jarvis/mobile bundle:ios` | PASS，Metro release bundle |
| `pnpm check:mobile-native-config -- --require-bundles` | PASS |
| `dotnet restore Jarvis.sln --locked-mode` | PASS |
| `dotnet build Jarvis.sln --configuration Release --no-restore` | PASS，0 warning/0 error |
| `dotnet test Jarvis.sln --configuration Release --no-build --no-restore --logger 'console;verbosity=minimal'` | PASS，285/285 |
| `dotnet format Jarvis.sln --no-restore --verify-no-changes` | PASS |
| `dotnet list Jarvis.sln package --vulnerable --include-transitive` | PASS，无 vulnerable package |
| `dotnet ef migrations has-pending-model-changes --project src/backend/Jarvis.Infrastructure/Jarvis.Infrastructure.csproj --startup-project src/backend/Jarvis.Api/Jarvis.Api.csproj --context Jarvis.Infrastructure.Data.JarvisDbContext` | PASS，无 pending model changes |
| `bash eng/scripts/package-desktop-macos.sh` | PASS，unsigned arm64 artifact、隔离安装、renderer mount、bearer restart smoke |
| `git diff --check` | PASS（文档变更后需由主代理再执行一次） |

## macOS artifact 与进程隔离证据

`bash eng/scripts/package-desktop-macos.sh` 完成了：

- Electron Forge `darwin/arm64` package 和精确 ASAR 文件/import contract；
- 安装到唯一临时目录，user-data 目录 owner-only `0700`，凭据文件 owner-only
  `0600` 且未出现 plaintext bearer；
- renderer marker、进程存活、退出后清理和使用已保存 bearer 的第二次启动；
- smoke 输出无 bearer，临时 profile/进程组已回收。

ASAR contract 只由上述 `bash eng/scripts/package-desktop-macos.sh` 中的
`assert-package.mjs` 对实际 `app.asar` 验证；`check:package` 的 CPU probe 是
仓库外部/source 脚本，使用 packaged-equivalent 的 `dist` runtime/model，不会被
打进 ASAR。

artifact identity：

```text
path: src/clients/desktop/out/make/zip/darwin/arm64/Jarvis-darwin-arm64-0.1.0.zip
size: 139969501 bytes
sha256: de83b3a274a15e47a0633d50c9c0072f0d677e5cb0e274cc76f56bee4746b84a
manifest: artifacts/releases/version-manifest.json
signatureStatus: unsigned-test
notarizationStatus: not-run
```

执行前后确认既有用户进程保持不变：Desktop PID `48837` 和 API PID `93331` 仍在
运行；未发现本票 package smoke 残留进程。上述 artifact、manifest、`dist`、
`out` 与报告 JSON 均属于生成物，不作为用户数据提交。

## Review 状态

本次独立 Standards/Spec review 已完成：同一 reviewer 在修正证据归因 P2 和
canonical SHA 后复核，结论为无 P1/P2、可提交。同一 verifier 最终 PASS；前轮发现
CPU probe 使用 63 位 `archiveSha256` 的 FAIL 已闭环，最终临时运行证据目录为
`/tmp/jarvis-phase8-ticket6-verify-final.eTP8S6`。该目录仅是运行时证据，不属于提交
内容。

## 已验证 gates 与未验证 gates

### 已验证

- 固定 sherpa-onnx `1.13.7`、ONNX Runtime identity、WenetSpeech KWS 模型和四个
  离线 fixture 的 SHA/检测结果；
- package 内的 renderer/main/preload/asset contract 和真实模型 dist 路径；CPU
  probe 为外部/source 脚本，不进入 ASAR；精确 ASAR contract 仍排除 scripts、tests
  和 source；
- `check:package` 的 dist build/contract、离线 acceptance，以及对 packaged-equivalent
  dist runtime/model 的 bounded CPU probe；
- Desktop control panel 的自动化真实 DOM scenario：正常/最小支持窗口、键盘
  focus-visible、reduced motion、任务/审批/通知/读回执/retry、Realtime persistence
  和 wake retry；
- owner-only isolated profile、encrypted bearer absence/persistence/restart、
  renderer mount 和 smoke process cleanup；
- 当前 backend、OpenAPI、Codex schema、EF drift、format、secret 和 package audit
  gates；
- Mobile TypeScript、Metro Android/iOS bundle 和 native config 静态 gate。

### 明确未验证或不等价

- Node `24.19.0` 重现性 gate：本机为 `25.0.0`，engine warning 不能静默视为等价；
- `pnpm install --frozen-lockfile`：本票禁止安装依赖，未重复执行；
- 真实 OpenAI/Realtime 或其它 provider 账号、网络、配额、音频往返和线上认证；
- 真人近场 20 次、远场 20 次、背景误唤醒和 30 分钟空闲 CPU/RSS；详见
  [`phase-8-acoustic-acceptance.md`](phase-8-acoustic-acceptance.md)，四项均为
  `UNVERIFIED`；
- 物理麦克风/扬声器/耳机路由、长时间硬件稳定性和真实设备音频；
- Developer ID 签名、notarization、自动更新、应用商店发布、生产部署、生产
  数据库/OTLP/公网性能；
- 本机 iOS native build（`pod` 不可用）和 Android native build；Metro bundle
  不替代原生编译或真机证据。

## 风险与回滚

- CPU probe 只接受固定 fixture 和有限迭代，不能推出真人声学质量、误唤醒率或
  30 分钟 idle 预算；回滚时删除 CPU probe/package gate 即可恢复 #5 前的离线
  acceptance 路径。
- Node 版本差异会影响 Electron/Metro/脚本的可重现性；发布前应在 Node `24.19.0`
  环境重新执行本报告的命令集。
- 当前 artifact 为 unsigned test；回滚发布时安装已知的上一版 signed/unsigned
  artifact，不删除 Control Plane 的持久化 Task、Notification、Conversation 或
  credential 事实。
- 声学目标和背景误唤醒阈值需在目标硬件上完成 worksheet 后再决定是否调整模型或
  阈值，不以本次离线结果直接放宽上线标准。

## 下一阶段前置条件

进入正式发布/下一阶段前，必须在固定 Node `24.19.0` 的 CI/macOS runner 上重跑
全门禁，完成目标 Mac 的真人 worksheet，取得真实 provider/认证环境的独立证据，
并补齐签名、notarization、生产部署和回滚演练记录。任何一项未完成，都继续保持
本报告的 `UNVERIFIED` 标记。
