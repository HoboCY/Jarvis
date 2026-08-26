# Phase 6 实施报告：可靠性、可观测性、桌面发布与服务验收

## 结果

Phase 6 代码交付完成。Backend、Device Node 和 Desktop 继续以认证 HTTP API、SQLite、TaskExecution/lease、Notification/Outbox 作为事实来源；retry/circuit、trace/log、SignalR、tray、overlay、Electron 进程状态均不是持久化事实来源。

- 外部 HTTP 客户端接入集中 timeout、受限 retry 和 circuit breaker。默认只重试安全读取；内部写请求只有在显式稳定幂等语义下才允许 retry，未知提交结果不会自动重放。
- Backend/Device Node 提供 correlation ID、Activity/Meter、可选 OTLP、运行时/HTTP instrumentation 和安全 JSON 日志。日志 scope 中的对象、路径、命令和敏感值经过统一脱敏；指标只使用有限枚举 label。
- API 增加 liveness/readiness 和 loopback + Local bearer 保护的 diagnostics。有效 bearer 但非 loopback 仍返回 403；诊断 DTO 只返回有限聚合，不包含 token、credential、正文、命令或绝对路径。
- Desktop Main/Preload/Renderer 保持 Renderer 无 bearer/Node；增加安全诊断代理、tray、独立 always-on-top overlay、通知投影/去重和断线补拉。macOS tray 使用真实 16x16 与 32x32 template PNG，不使用空图标占位。
- Backend/Device Node 支持 darwin-arm64 publish、launchd plist、显式 install/uninstall/status/smoke。服务使用独立临时 label/目录，API 与 Device Node 均可独立于 Desktop 运行。
- launchd install/uninstall 可重复执行：同 label install 会先停止已加载服务；不存在服务时只忽略精确 not-found 响应，其它 launchctl 错误仍失败。
- Electron Forge 固定 Electron `44.0.0`、Forge `7.11.2`，macOS 最低版本 `13.0`，目标 `darwin/arm64`。无 Apple 凭据时产物明确标记为 unsigned test。
- `tests/e2e` 提供 8 个具名可执行场景，使用 TestServer、SQLite、SignalR、fake worker/Responses、Fake Codex JSONL 子进程和持久 execution/identity seam；性能直接测 typed-message P95、TaskId 接受和 notification publish/pull budget。

## TDD 与实际验证

公共 seam 的 RED/GREEN 顺序覆盖 resilience、observability/diagnostics、Desktop 生命周期、服务脚本和 8 个 E2E 场景。最后一次 Release build 期间曾由 E2E 场景命名下划线触发 CA1707；恢复 `TestApplicationFactory` 单一 public constructor 并将命名规则豁免限定在 E2E test project 后通过。

```text
dotnet restore Jarvis.sln --locked-mode                                      PASS
dotnet build Jarvis.sln --configuration Release --no-restore                 PASS (0 warning, 0 error)
dotnet test Jarvis.sln --configuration Release --no-build --no-restore       PASS (206/206)
  Infrastructure 23; Domain 14; Architecture 4; DeviceNode 27;
  Application 17; API integration 113; E2E 8
dotnet format Jarvis.sln --no-restore --verify-no-changes                    PASS
dotnet list Jarvis.sln package --vulnerable --include-transitive              PASS (no vulnerable packages)
dotnet ef migrations has-pending-model-changes ...                            PASS

pnpm typecheck                                                               PASS
pnpm lint                                                                    PASS
pnpm --filter @jarvis/desktop test                                             PASS (57 TS tests + 5 build tests)
pnpm test                                                                      PASS (recursive: contracts 4 + realtime 12 + api-client 3 + Desktop 57 + build 5 + Mobile 49; 130 individual tests)
pnpm build                                                                   PASS
pnpm generate:openapi && pnpm check:openapi                                  PASS (byte-for-byte stable)
pnpm check:codex-schema && pnpm check:codex-schema-canonical                 PASS (275 schema files)
pnpm test:codex-schema-canonical                                             PASS (2/2)
pnpm check:secrets && pnpm test:secret-scan                                  PASS
pnpm test:service-manifest                                                   PASS (14/14)
git diff --check                                                             PASS

bash tests/e2e/run-e2e.sh                                                    PASS
  named E2E 8/8; API scenario regression 77/77; DeviceNode 27/27
```

`tests/e2e/run-e2e.sh` 的 TRX 报告默认写入 `artifacts/test-reports/phase6-e2e`，runner 会读取 TRX 并验证 `scenarios.json` 中的每一项确实执行；该目录为生成物并已忽略。

## macOS 服务与发布证据

实际本机 smoke 使用一次性唯一 label，在当前用户 domain 从 self-contained bundle 解包后完成 API health、Device heartbeat、API bootout/bootstrap 后 SQLite 中 Device/Notification 保留、Device restart 后 heartbeat 继续推进和认证 control-plane probe，然后清理进程、plist、数据库、日志和临时目录。最近一次输出为：

```text
API health live/ready passed on http://127.0.0.1:40579.
API restart retained SQLite device (1 online) and notification 01a03d37-38d1-7426-8a61-60d63655db38.
Device heartbeat, secure identity reload, restart, and authenticated control-plane probe passed.
```

命令：

```text
bash eng/scripts/publish-macos-arm64.sh
bash eng/scripts/launchd-smoke-macos.sh
```

服务清单：`artifacts/releases/services-version-manifest.json`（生成物，`unsigned-test` / `not-run`）。最近一次 self-contained publish 的 SHA-256（完整隔离 bundle，包含 .NET runtime、依赖 DLL、runtimeconfig 与 native SQLite）：

```text
artifacts/services/Jarvis.Api-darwin-arm64.tar.gz
fa694a385b5a6c02e19746bc4bd37b309e9eef208b202e7e2acb7265360a6b35
size: 50909909 bytes

artifacts/services/Jarvis.DeviceNode-darwin-arm64.tar.gz
ae74b0c205df929164ea6e8b39a0afe8172ec7877829474e48bf75030d55583d
size: 50664871 bytes
```

发布脚本在隔离临时源树中执行 runtime-specific restore，并以 locked restore 和 `--no-restore` publish 作为门禁；不会改写仓库 tracked `packages.lock.json`。launchd smoke 从上述 bundle 解包后安装和启动，不依赖目标机预装 .NET runtime。
相同输入连续执行两次 publish 时，上述两个完整 bundle 均通过 byte-for-byte 比较；归档入口顺序、mtime、uid/gid、权限、扩展属性和 gzip 参数均固定。

Device Node 生产默认使用 macOS Security.framework Keychain store；同步调用会先禁止用户交互，需要 UI 时以 `errSecInteractionNotAllowed` fail closed，ACL 只授予专用 self-contained `Jarvis.DeviceNode` apphost，不授予通用 `/usr/bin/security` CLI 或共享 `dotnet` host。由于无人值守 smoke 中 Keychain 可能触发 ACL UI，本阶段 smoke 显式使用 owner-only `0600` credential file seam。该 seam 已检查路径、目录/文件权限并原子写入，但不是 Keychain、硬件保护或生产凭据证明；报告不将它宣称为 Keychain 验证。

## Desktop 产物证据

`bash eng/scripts/package-desktop-macos.sh` 会先通过 `pnpm build` 生成自包含的 main/preload/renderer bundle，再构建 Forge package；启动前由 `scripts/assert-package.mjs` 精确校验 ASAR 文件集合、条目类型和 bundle imports。脚本随后复制 `.app` 到唯一临时安装目录，创建 `install_root/user-data` 的 owner-only `0700` profile 并通过 `--user-data-dir` 启动 `Contents/MacOS/Jarvis`，不复用正常 profile 或 single-instance lock。仅在受限临时路径 marker 环境开启时，主进程等待 renderer load，并用固定 `executeJavaScript` 检查 `#root` 已有子节点后写入 `renderer.ready` marker；脚本同时校验 marker 的事件、PID 和进程存活，最后退出并清理安装目录。最近一次真实安装/启动 smoke：

```text
Desktop install/start smoke passed: Jarvis.app pid 52508 mounted the renderer.
```

该 smoke 与一个不带 `--user-data-dir` 的默认 profile Jarvis 进程并发执行；默认 profile PID 52368 在整个打包和安装启动期间保持存活，证明隔离 profile 不会争用正常 single-instance lock。

版本清单：`artifacts/releases/version-manifest.json`（生成物，`signatureStatus=unsigned-test`、`notarizationStatus=not-run`，二者均为 UNVERIFIED）。本次 ASAR 只包含 `package.json` 和 9 个必要的 dist entry/HTML/PNG 文件；不包含 `node_modules`、workspace symlink、source 或测试文件。构建输出的 main bundle 仅保留 Electron/Node builtins external，renderer bundle 无 bare external import。

```text
artifact: src/clients/desktop/out/make/zip/darwin/arm64/Jarvis-darwin-arm64-0.1.0.zip
size: 131584746 bytes
sha256: 07fd2aba70c20953aa9a150d1b4a6d1763d12a4f9938074d93db0c9ca7804e95
```

该 zip 已独立用 `shasum -a 256` 复核，包含 arm64 `Jarvis.app/Contents/MacOS/Jarvis` 与 `app.asar`。CI 的 macOS job 固定 `macos-15`，会执行同一 package/install/start smoke、service publish/smoke 并上传报告和清单。

## 影响、回滚与残余风险

- 可通过显式 service `uninstall` 回滚隔离 launchd 服务，先 bootout 再删除对应 plist/目录；不会触碰其他 label。Desktop 回滚为安装上一版本包。数据库事实不因回滚日志、tray 或 exporter 而删除。
- 当前本机 Node 为 `25.0.0`，仓库锁定 `24.19.0`，pnpm 命令有 engine warning；固定 Node 24.19.0 的 CI/macOS job 仍是发布门禁。
- 本机 package 与 launchd smoke 是 unsigned test；未验证 Developer ID 签名、notarization、自动更新或生产安装器。
- 未执行真实 OpenAI 账户/provider、生产数据库、线上认证基础设施、生产 OTLP collector 或公网性能证明；fake provider/Codex 只证明受控本地 seam。
- Keychain 默认实现只在 native 同步调用前后检查 caller cancellation，并禁止会话交互；本 smoke 走明确的 0600 文件 fallback，因此真实 Keychain ACL、用户登录钥匙串策略和硬件保护仍需独立发布门禁验证。该路径不宣称可中断任意已进入 Security.framework 的同步调用。
