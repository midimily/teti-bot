# Teti 0.5.1-beta.1 — Structured Task Memory + Shadow Retrieval

## 目标与边界

本版本在 `0.5.0` 持续协作 SQLite 账本之上增加本地 Shadow Retrieval：每次新的
长期协作阶段准备调用本地 Agent 时，Sidecar 按 `task`、`workspace`、`peer` 三个
精确范围生成候选并保存不可变选择 manifest。

Shadow 的含义是“计算并审计，但不使用”。本版本不会把候选内容、Memory ID、
manifest、查询或排序原因写入 `CallableAdapterTaskRequest`，不会改变 Execution
Authority，也不会向 Peer、Connector、CLI 或 Provider 发送 Memory 审计信息。

## SQLite schema v2

数据库仍为 Profile 内的 `collaboration-memory-v2.sqlite`，继续由 Sidecar 单写，
保持父目录 `0700`、文件 `0600`、短事务、`synchronous=FULL`、完整性检查和安全
错误投影。

schema v2 在 v1 上原地、事务化迁移：

- `long_horizon_task_memory_fts`：FTS5 本地索引；迁移时回填 v1 阶段记录，新阶段
  与主记录在同一事务写入；
- `long_horizon_task_memory` 按 `child_agent_id + task/workspace/peer` 建立三个范围索引，
  先完成精确隔离再进入排序；
- `memory_shadow_manifests`：执行 ID、当前 Task、范围键、Query Digest、预算、
  候选计数和 manifest Digest；不保存 Query 或拼接后的 Prompt；
- `memory_shadow_candidates`：Memory ID、来源 Task、匹配范围、版本、rank、score、
  机器可读 reason、条目 Digest 与候选字节数；不复制内容；
- 两张 Shadow 表禁止 `UPDATE`。同一 execution ID 再次请求时返回原 manifest，
  不因数据库后来变化而改写历史选择证据；若同一 execution ID 被不同 Task、Peer、
  Workspace、Child 或 Query Digest 重用，则以 `MEMORY_SOURCE_CONFLICT` 拒绝。

未知未来 schema、迁移 checksum 不匹配、完整性失败或 FTS/manifest 读取异常均失败
关闭为 `MEMORY_STORE_UNAVAILABLE`；Task 与 CLI 执行本身不被 Memory 故障阻断。

## 候选合同

候选只来自相同本地 Child Agent 的 `0.5.0` 阶段记录，并按最窄范围去重：

1. 当前 Task ID 相同：`task` / `exact_task`；
2. 其他 Task、Workspace ID 相同：`workspace` / `exact_workspace`；
3. 其他 Task、Peer Teti ID 相同：`peer` / `exact_peer`。

优先级固定为 `task > workspace > peer`。同一条记录只属于最窄命中的一个范围，
不同 Child、Workspace 和 Peer 不会因关键词相同而越界。排序由范围、
`stage_handoff` 类型、FTS 关键词、新近度、创建时间和 Memory ID 组成；相同输入的
顺序与 Digest 可复现。

manifest 使用未来上下文预算进行影子裁剪：最多 8 条、候选原文合计最多 12 KiB。
manifest 自身不含原文，只记录实际候选的 `contentBytes` 与 `itemDigest`。未入预算的
记录仍反映在三范围候选计数中，便于后续评估召回和裁剪质量。

## 默认不注入的硬边界

- manifest 固定 `mode=shadow`、`cliInjectionEnabled=false`；
- SQLite 对 `cli_injection_enabled=0` 和
  `eligible_for_cli_injection=0` 使用 `CHECK` 约束；
- TypeScript DTO 对应字段为字面量 `false`；
- Task Runtime 在 `executor.execute(...)` 之前旁路生成 manifest，但原有
  `execution.input.text/images` 不读取 manifest，也没有 Context Composer；
- Shadow 失败被本地降级，不阻断阶段开始；
- Task、Passport、Chatmail、Application Envelope 和网络协议没有 schema 变化。

因此本版本只能说明“如果未来开启注入，本次会考虑哪些候选”，不能说明 CLI 或
Agent 已看到、采用或遵循这些记忆。

## 本版本明确不做

- 不把自动捕获的 `peer_originated_reference` 提升为用户确认记忆；
- 不提供 decision / constraint / handoff 草稿编辑、pin、supersede 或 relation UI；
- 不打开 Workspace / Peer 注入授权，不提供执行前注入预览；
- 不实现 reference-data envelope 或真实 Context Composer；
- 不引入 Embedding、向量数据库、独立 Graph 数据库或云端检索。

## 验收证据

- 同一输入重复 500 次，manifest、顺序、Digest 和预算完全一致；
- `task`、`workspace`、`peer` 各一条候选按固定优先级出现，不同 Peer / Workspace /
  Child 的同关键词记录不出现；
- v1 数据库迁移到 v2 后 FTS 回填可召回原阶段记录；未知 v3 失败关闭且文件保留；
- 4 条各 4 KiB 候选只选择 3 条，严格保持 12 KiB；
- Runtime 集成夹具让 Shadow 命中带有秘密标记的 Peer 历史，同时证明实际 CLI
  request 不含该文本或 Memory ID；
- manifest 与候选表中的注入位均为 `0`，快照只暴露无原文 manifest。
- 5,000 条同范围阶段记录的独立严格基准通过：2026-08-21 本机验证冷查询
  `44.85 ms`、暖查询 P95 `21.76 ms`，低于计划的 `150/40 ms` 门槛；全量并行测试
  使用宽松退化阈值，严格门槛由 `TETI_STRICT_MEMORY_BENCHMARK=1` 独立执行。
- macOS Rust check/test 与 `x86_64-pc-windows-msvc` Rust shell cross-check 均通过；
  SQLite/Shadow 逻辑保持在共享 TypeScript Sidecar，不引入平台分叉。
