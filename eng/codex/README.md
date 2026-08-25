# Codex App Server 契约

Phase 0 固定 Codex App Server `0.146.0`，并将实际运行
`codex app-server generate-json-schema --out artifacts/codex-schema/0.146.0` 的产物纳入版本控制。

生成后必须执行确定性规范化：

```text
codex app-server generate-json-schema --out <schema-dir>
node eng/scripts/canonicalize-codex-schema.mjs <schema-dir>
```

规范化递归排序所有 JSON object 的键，保持 array 顺序，统一为 2 空格缩进和一个尾换行。这样可以消除同一 Codex 版本生成过程中仅由 object 键顺序造成的字节差异。

本地检查：

```text
pnpm check:codex-schema
pnpm check:codex-schema-canonical
pnpm test:codex-schema-canonical
```

`check:codex-schema` 会解析目录下所有 JSON，读取权威 `ClientRequest.json` 的 request method union，并精确校验 `initialize`、`thread/start`、`turn/start`、`turn/interrupt` 的 params 引用、必需字段和关键属性结构；`check:codex-schema-canonical` 保证固定版本目录的 275 个 JSON 文件均已规范化；测试包含未规范化负例。业务适配器属于后续 Device Node 阶段。
