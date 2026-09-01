# Jarvis 开源本地唤醒词方案调研

调研日期：2026-09-01

## 结论

Porcupine 的 GitHub 仓库确实采用 Apache-2.0，但这不等于当前产品没有许可服务依赖：仓库中的跨平台核心以预编译库/WASM 形式分发，Web SDK 初始化仍强制传入 AccessKey；官方说明 AccessKey 同时承担身份认证、授权和账户用量校验，当前 Terms 也将免费使用描述为可限制或撤销的 Free Trial。因此，它更准确的定位是“Apache-2.0 的公开 SDK、绑定和二进制分发 + 受 AccessKey/服务条款控制的产品”，不是无需厂商授权体系的完全自主开源引擎。

当前项目最终选择 **sherpa-onnx KWS**，并把唤醒词改为中文“贾维斯”。它支持无需重新训练的 open-vocabulary keyword spotting，所选 WenetSpeech 3.3M 模型以 partial pinyin 建模，更符合主要使用中文交流的场景。实现使用约 4.9 MB 的 INT8 模型切片、约 14 MB 的 sherpa-onnx WASM 运行时和 macOS arm64 麦克风绑定；推理与麦克风音频都留在 Electron 主进程本地，不再需要账户或 AccessKey。

所选模型归档内的 model card 明确声明 Apache License 2.0，并在仓库记录了下载地址、归档 SHA-256 和实际打包的模型变体。正式对外分发前仍应复核上游声明是否变化。

## “Porcupine 是开源的”应如何理解

- [当前官方仓库 LICENSE](https://github.com/Picovoice/porcupine/blob/master/LICENSE) 是标准 Apache-2.0，这一点没有问题。
- 仓库也公开了 TypeScript 等各平台绑定，但 [`lib/` 目录](https://github.com/Picovoice/porcupine/tree/master/lib) 分发的是各平台的预编译核心库和 WASM，并没有公开核心引擎的可构建实现源码。
- [Web binding 文档](https://github.com/Picovoice/porcupine/tree/master/binding/web#accesskey) 明确要求初始化时提供有效 AccessKey。
- [官方 Porcupine 介绍](https://picovoice.ai/docs/porcupine/) 说明 AccessKey 不仅是凭据，还会验证是否超出账户额度。
- [当前 Terms of Use](https://picovoice.ai/docs/terms-of-use/) 说明免费试用的范围、期限和用量可由 Picovoice 决定，并可能被修改或撤销；正式使用也可能要求支付适用费用。

所以，“仓库有 Apache-2.0”与“运行时仍受 AccessKey 和服务条款约束”可以同时成立。对 Jarvis 来说，真正需要评估的不是能否查看仓库，而是能否在不依赖 Picovoice 账户、额度与授权服务的情况下持续分发和运行。

## 候选比较

| 方案 | 开源/模型许可 | 自定义 `Jarvis` | Electron 接入 | 体积与运行成本 | 结论 |
| --- | --- | --- | --- | --- | --- |
| [Rustpotter](https://github.com/GiviMAD/rustpotter) + [Worklet](https://github.com/GiviMAD/rustpotter-worklet) | 代码与 Worklet 均 Apache-2.0，无 AccessKey | 3–8 个录音可生成 reference；也支持训练小模型 | 最直接：WASM + AudioWorklet，运行在 renderer | 官方列出 Tiny/Small/Medium/Large 模型档位；reference 计算量随样本数增加，仍需本机测量 | 当前最轻的无厂商依赖试验方案 |
| [sherpa-onnx KWS](https://k2-fsa.github.io/sherpa/onnx/kws/index.html) | 引擎 Apache-2.0；所选 WenetSpeech 归档的 model card 同样声明 Apache-2.0 | open vocabulary，无需为每个关键词重新训练 | WASM 推理运行在主进程，`node-cpal` 提供 macOS arm64 麦克风输入 | 实际打包模型约 4.9 MB，WASM 运行时约 14 MB | 当前采用方案；中文模型、无账号依赖，代价是包体大于 Porcupine |
| [openWakeWord](https://github.com/dscripka/openWakeWord) | 代码 Apache-2.0；仓库内预训练模型为 CC BY-NC-SA 4.0，不可商用 | 已自带英文 `hey jarvis`，也支持训练自定义模型 | 官方主路径是 Python + ONNX/TFLite；Web 示例是把音频流送到后端，不能直接替代当前 renderer 内处理 | 官方称单个 Raspberry Pi 3 核可实时跑 15–20 个模型 | 个人项目可用；当前自包含 Electron 和未来商用不优先 |
| [Mycroft Precise](https://github.com/MycroftAI/mycroft-precise) | Apache-2.0 | 可训练，但需要较多训练数据和 Python/TensorFlow 工具链 | 官方只承诺 Linux，稳定版仅提供 Linux x86_64/armv7 二进制 | 老式 RNN/Python 依赖，最新 release 为 2019 年 | 不建议用于当前 macOS Electron 项目 |

## 对当前 Jarvis 的建议

1. 已移除 Porcupine SDK、模型文件、AccessKey 后端配置与响应字段。
2. 已通过现有 `WakeWordDetector` 接口接入 sherpa-onnx，不改变 Realtime 的单轮唤醒与回答后重新静音状态机。
3. 已验证 INT8 模型在开发构建和打包后的 Electron Node 24 环境加载成功，静音不触发，macOS `Tingting` 合成的“贾维斯”能够触发。
4. 仍需由实际使用者在同一台 Mac、同一麦克风验证：空闲 CPU、正常/远场/噪声下的漏唤醒，以及连续背景语音下的误唤醒。

建议的替换验收线：连续背景音频误唤醒不高于 0.5 次/小时，20 次近场和 20 次远场唤醒分别统计漏唤醒率，并记录 30 分钟空闲 CPU 的平均值和峰值。这些是项目验收建议，不是各引擎之间已被统一基准验证的官方结论。

## 限制

当前验证覆盖模型加载、合成中文正样本、静音负样本和 macOS arm64 打包，不等同于真人声学验收，也不构成法律意见。模型许可在正式分发前仍应再次核对。
