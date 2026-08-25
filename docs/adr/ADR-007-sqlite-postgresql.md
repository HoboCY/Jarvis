# ADR-007：SQLite V1 / PostgreSQL 正式多设备

- 状态：已接受
- 决策：V1 单机使用 SQLite；多设备正式部署迁移 PostgreSQL；领域模型与 API 合同保持不变。
- 原因：SQLite 适合本机骨架和单用户部署，PostgreSQL 适合后续并发与常驻控制平面。
- 影响：时间以 UTC Unix 毫秒或明确 UTC 值保存；数据访问不使用泛型 Repository，以便保留关系数据库约束。
