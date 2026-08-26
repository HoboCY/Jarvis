# Phase 4 实施报告：Device Node、Codex App Server 与显式审批

## 结果

Phase 4 的本地代码范围已完成：Control Plane 现在持久化 Device、TaskExecution、Approval、任务 capability envelope 与租约事实；Device Node 使用独立设备凭据、心跳、原子 claim、续租和恢复接口驱动固定版本 Codex App Server；Desktop 通过显式按钮完成一次性批准或拒绝。Task、Execution、Approval、TaskEvent、Notification 与 Outbox 仍由数据库统一持有，SignalR 仅作提示。

固定的真实 Codex `0.146.0` 已完成一次只读、网络关闭、单目录 smoke，返回精确文本 `JARVIS_PHASE4_SMOKE_OK`，输入 SHA-256 与目录项均未变化。

## 主要改动

- Device 身份：新增注册、专用 credential hash、心跳、在线状态、能力与 allowed roots；UI bearer、Device bearer 和两个 Hub 的权限边界分离。macOS Device credential 通过 Keychain 适配器保存，注册响应中的明文 credential 只返回一次。
- Task 协调：新增 TaskExecution、30 秒 lease、原子单胜者 claim、续租、过期恢复、设备重启后的 `GET /api/v1/device-tasks/active` 补拉，以及 `task.available`/取消提示。
- 权限边界：Codex Task 创建时必须携带由 Control Plane 持久化的 capability envelope；领取结果是任务上限、设备注册能力和节点请求能力三者的交集，节点不能扩大 write、command、network 或 allowed roots。
- Codex 适配器：实现 stdio JSONL 的 `initialize`/`initialized`、`thread/start`/`thread/resume`、`turn/start`/`turn/interrupt`、通知与 server request 关联、最小环境、process supervisor 和有限退避恢复。协议遵循固定二进制对应的 [Codex App Server documentation](https://developers.openai.com/codex/app-server/)。
- 不确定执行保护：在非幂等 `turn/start` 前先持久化 `codex.turn.starting` 意图；节点若只看到意图但没有确认的 TurnId，会明确失败且拒绝自动重放。已知 Thread/Turn 恢复时只 resume，不创建第二个 turn。
- 审批：command、file change 和 permission 请求先落 Approval 并暂停执行；UI 决定只能发生一次，批准结果仍会与任务 capability policy 再求交集，拒绝或过期安全失败。Codex 原始 action JSON 只留在后端审计边界，不进入 Approval UI 合同、Preload 或 Renderer state。
- Artifact：Device Node 在文件实际所在机器验证 canonical regular file、symlink、size 与 SHA-256；Control Plane 验证声明格式和 execution allowed roots 后持久化 manifest，避免要求 API 主机共享设备文件系统。
- 诊断安全：Codex stderr 内容不再写入事件或日志，只保留“已脱敏”的存在性摘要；子进程仅继承 `PATH`、`LANG` 和显式安全环境项。
- Desktop/Realtime：新增 pending approval 补拉、ApprovalId 去重、批准一次/拒绝、稳定幂等键与固定 IPC 白名单；`delegate_task` 增加显式 nullable capability envelope。
- 合同与数据库：更新 OpenAPI、TypeScript 合同和三份 Phase 4 migration：`Phase4DeviceCoordinationV2`、`Phase4DeviceAllowedRoots`、`Phase4ReviewSecurityAndRecovery`。

## 独立审查修复

独立审查发现并已修复以下问题：Device claim 可扩大任务权限；`turn/start` 成功与映射落库之间存在重放窗口；command/file approval 未再次受 policy 约束；Renderer 保存 raw approval payload；API 主机错误地重算设备 artifact；stderr 可能进入持久事件；Device Node 重启缺少 active execution 补拉。所有修复均增加或扩展了公开 seam 测试。

## 实际验证

```text
dotnet restore Jarvis.sln --locked-mode                              PASS
dotnet list Jarvis.sln package --vulnerable --include-transitive     PASS (no vulnerable packages)
dotnet build Jarvis.sln -c Release --no-restore                      PASS (0 warning, 0 error)
dotnet test Jarvis.sln -c Release --no-build --no-restore            PASS (133/133)
  Infrastructure 2; Domain 12; Architecture 4; DeviceNode 13;
  Application 15; API integration 87
dotnet format Jarvis.sln --no-restore --verify-no-changes            PASS
dotnet ef migrations has-pending-model-changes ...                   PASS (no pending model changes)
pnpm install --frozen-lockfile                                       PASS
pnpm typecheck                                                       PASS
pnpm lint                                                            PASS
pnpm test                                                            PASS (66/66: 4 + 12 + 2 + 48)
pnpm build                                                           PASS
pnpm generate:openapi && pnpm check:openapi                          PASS (28 paths; byte-for-byte stable)
pnpm check:codex-schema                                              PASS (275 files; 90/70/10 unions)
pnpm check:codex-schema-canonical                                    PASS (275 files)
pnpm test:codex-schema-canonical                                     PASS (2/2)
pnpm check:secrets && pnpm test:secret-scan                          PASS
git diff --check                                                     PASS
```

真实 Codex smoke：

```text
Codex version: 0.146.0
Native SHA-256: ae1d3ffe6d48aec6a4dc3f50e7eb8e0d11962485a6a9406c5a7012139383da02
Thread: 01a03be7-4094-78d3-8988-17bce162e0d8
Turn: 01a03be7-4273-7f03-8f7a-df76b7a34227
Status: completed
Output: JARVIS_PHASE4_SMOKE_OK
Input SHA-256: 95e55c9eca13d7c0689193ee5ff6d9d41dbcbc68aebccfb1c9cb0bffdbea46db
Mutation check: input hash and directory entries unchanged
```

实际工具版本：.NET SDK `10.0.100`、pnpm `10.24.0`、Codex `0.146.0`。本机 Node 为 `25.0.0`，与仓库锁定的 `24.19.0` 不同，因此 pnpm 保留 engine warning，但所有门禁通过。

## 影响与回滚

- API 影响：Codex Task 的 `capabilityEnvelope` 现在是业务必填；未声明任务根目录和能力上限的本地任务会返回 400。普通 Internal/Responses Task 保持 `null`。
- 数据库影响：新增 Device/TaskExecution/Approval 关系及 Task capability envelope、Codex turn-start intent 字段。回滚前必须停止 Device Node，确认没有 Running/WaitingForApproval/Recovering execution，再按相反顺序执行 EF migration 回退并恢复旧二进制。
- 安全回滚：如果设备认证、审批或 artifact 边界异常，应先禁用 Device Node/Device bearer，保留 Control Plane 数据用于审计，不应通过放宽 policy 恢复服务。

## 未解决项与风险

- 未对真实 macOS Keychain 写入用户凭据，避免在验证中改变真实账户状态；已验证 Keychain 命令形状和 fake identity store，生产安装验收仍需真实设备执行。
- 未进行生产部署、真实多机 Control Plane/Device Node 网络、真实文件产物跨机体验或外部 provider 验证；当前证明是本机协议、真实 SQLite/TestServer、真实子进程和真实 Codex smoke。
- 固定 `0.146.0` 的 `readOnly` sandbox policy 不提供独立 `readableRoots` 字段；当前通过受限 cwd、任务指令、敏感路径拒绝、审批过滤和 artifact 边界约束读取行为，但还不是 OS 级“禁止读取根目录外文件”。若威胁模型要求强机密隔离，需要在发布阶段增加 macOS seatbelt/独立低权限账户或其他外部 sandbox，并做真实越界读取攻击测试。
- 本机 Node 版本偏差仍需在固定 Node `24.19.0` 的 CI/发布环境再次确认。

本阶段将由本地提交交付，不自动推送。Phase 5 可在保留 Control Plane 事实来源和现有 Task/Notification 合同的前提下实现 Responses Worker、摘要和显式记忆。
