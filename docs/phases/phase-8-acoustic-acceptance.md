# Phase 8 真人声学验收 worksheet

本 worksheet 只记录同一台目标 Mac、同一套已安装 Desktop 与同一麦克风上的
真人验收。离线 sherpa-onnx fixture、打包 smoke 和本表的真人结果必须分开记录；
任何未实际执行的格子保持 `UNVERIFIED`，不能用离线模型或合成音频代填。

## 当前状态

| Gate | 状态 | 说明 |
| --- | --- | --- |
| 近场唤醒 20 次 | `UNVERIFIED` | 尚未执行真人试验 |
| 远场唤醒 20 次 | `UNVERIFIED` | 尚未执行真人试验 |
| 背景音误唤醒 | `UNVERIFIED` | 尚未执行目标环境长时试验 |
| 空闲 30 分钟 | `UNVERIFIED` | 尚未执行目标硬件测量 |

## 固定环境

在开始每组试验前填写，不要在同一组中途更换设备或配置。

| 项目 | 记录 |
| --- | --- |
| 日期/时区 | `____________________________` |
| macOS 版本与机型 | `____________________________` |
| 麦克风设备/输入通道 | `____________________________` |
| 近场距离 | 建议 `0.3 m`；实际 `________ m` |
| 远场距离 | 建议 `2.0 m`；实际 `________ m` |
| 背景音源/平均 SPL | `____________________________` |
| Desktop 版本 | `____________________________` |
| artifact SHA-256 | `____________________________` |
| 唤醒词配置 | `贾维斯` / 16 kHz / CPU / 1 thread |
| 系统输入增益/降噪 | `____________________________` |
| 观察者 | `____________________________` |

开始前确认：没有启用录音保存、没有把系统语音听写结果当作检测结果，且
`data-wake-state` 的 `awake` 是唯一的唤醒判定。Realtime provider、回答质量和
麦克风硬件保证不属于本 worksheet 的证明范围。

## 近场：20 次

每次只说一次“贾维斯”，从 `standby` 开始，记录是否进入 `awake`、从发音结束到
检测的延迟，以及当次背景噪声。若试验失败，保留失败原因而不要重试覆盖原记录。

| 次数 | 结果（detected/missed） | 延迟 ms | 背景/干扰 | 备注 |
| ---: | --- | ---: | --- | --- |
| 01 | `UNVERIFIED` |  |  |  |
| 02 | `UNVERIFIED` |  |  |  |
| 03 | `UNVERIFIED` |  |  |  |
| 04 | `UNVERIFIED` |  |  |  |
| 05 | `UNVERIFIED` |  |  |  |
| 06 | `UNVERIFIED` |  |  |  |
| 07 | `UNVERIFIED` |  |  |  |
| 08 | `UNVERIFIED` |  |  |  |
| 09 | `UNVERIFIED` |  |  |  |
| 10 | `UNVERIFIED` |  |  |  |
| 11 | `UNVERIFIED` |  |  |  |
| 12 | `UNVERIFIED` |  |  |  |
| 13 | `UNVERIFIED` |  |  |  |
| 14 | `UNVERIFIED` |  |  |  |
| 15 | `UNVERIFIED` |  |  |  |
| 16 | `UNVERIFIED` |  |  |  |
| 17 | `UNVERIFIED` |  |  |  |
| 18 | `UNVERIFIED` |  |  |  |
| 19 | `UNVERIFIED` |  |  |  |
| 20 | `UNVERIFIED` |  |  |  |

小结：

```text
detected: ____ / 20
missed:   ____ / 20
漏唤醒率: ____%
组结论:   UNVERIFIED
```

## 远场：20 次

固定上面登记的远场距离和输入增益；说话人、语速和判定方式保持一致。

| 次数 | 结果（detected/missed） | 延迟 ms | 背景/干扰 | 备注 |
| ---: | --- | ---: | --- | --- |
| 01 | `UNVERIFIED` |  |  |  |
| 02 | `UNVERIFIED` |  |  |  |
| 03 | `UNVERIFIED` |  |  |  |
| 04 | `UNVERIFIED` |  |  |  |
| 05 | `UNVERIFIED` |  |  |  |
| 06 | `UNVERIFIED` |  |  |  |
| 07 | `UNVERIFIED` |  |  |  |
| 08 | `UNVERIFIED` |  |  |  |
| 09 | `UNVERIFIED` |  |  |  |
| 10 | `UNVERIFIED` |  |  |  |
| 11 | `UNVERIFIED` |  |  |  |
| 12 | `UNVERIFIED` |  |  |  |
| 13 | `UNVERIFIED` |  |  |  |
| 14 | `UNVERIFIED` |  |  |  |
| 15 | `UNVERIFIED` |  |  |  |
| 16 | `UNVERIFIED` |  |  |  |
| 17 | `UNVERIFIED` |  |  |  |
| 18 | `UNVERIFIED` |  |  |  |
| 19 | `UNVERIFIED` |  |  |  |
| 20 | `UNVERIFIED` |  |  |  |

小结：

```text
detected: ____ / 20
missed:   ____ / 20
漏唤醒率: ____%
组结论:   UNVERIFIED
```

## 背景音误唤醒

至少选择一个实际使用场景（例如键盘、会议、音乐或电视），记录背景音源、
持续时间、起止时刻和所有非目标 `awake`。背景音中不主动说“贾维斯”；任何误
唤醒都记录一次，不通过重启或清空日志抹掉。

| 场景 | 持续时间 | 起止时间 | 误唤醒次数 | 运行时错误 | 结论 |
| --- | ---: | --- | ---: | --- | --- |
| `________________` | `____ min` | `________` | `____` | `________` | `UNVERIFIED` |
| `________________` | `____ min` | `________` | `____` | `________` | `UNVERIFIED` |
| `________________` | `____ min` | `________` | `____` | `________` | `UNVERIFIED` |

研究建议中的 `不高于 0.5 次/小时` 只是待确认的产品目标，不是当前已通过的
门槛。需同时记录总暴露时长和误唤醒率，不能从 20 次主动唤醒推导。

## 空闲 30 分钟

停止主动说话，保持唤醒检测处于 `standby/listening`，每 5 分钟记录一次采样。
使用 macOS Activity Monitor 或统一的进程采样方式，并注明采样方法。这里的
CPU 数值是目标硬件上的空闲行为；离线 CPU probe 的数值不能代替它。

| 时间 | CPU % | RSS MB | wake state | 误唤醒累计 | 错误/重启 |
| ---: | ---: | ---: | --- | ---: | --- |
| 00:00 |  |  |  |  |  |
| 05:00 |  |  |  |  |  |
| 10:00 |  |  |  |  |  |
| 15:00 |  |  |  |  |  |
| 20:00 |  |  |  |  |  |
| 25:00 |  |  |  |  |  |
| 30:00 |  |  |  |  |  |

```text
平均 CPU:       ____%
峰值 CPU:       ____%
RSS 变化:       ____ MB
误唤醒总数:     ____
崩溃/重启次数:   ____
组结论:         UNVERIFIED
```

## 离线 probe 对照（不是真人验收）

如需保留可重复的机器证据，使用临时文件保存 JSON，不将个人环境数据提交到
仓库：

```sh
node src/clients/desktop/scripts/wake-word-cpu-probe.mjs \
  --fixture silence --iterations 3 --warmup-iterations 1 \
  > /tmp/jarvis-phase8-cpu-source.json
```

也可由打包 gate 指向 `dist/node_modules/sherpa-onnx` 和
`dist/assets/sherpa-kws-wenetspeech-3.3M`。该命令测量固定 PCM fixture 的真实
模型 CPU/墙钟时间，不测麦克风、真人声学、30 分钟稳定性或 OpenAI provider。

## 结论规则

只有所有必填记录已实际填写、artifact/config 可追溯且观察者签名后，才把相应
行的 `UNVERIFIED` 改成 `PASS` 或 `FAIL`。在此之前，Phase 8 报告必须继续把四个
真人 gate 标为 `UNVERIFIED`。
