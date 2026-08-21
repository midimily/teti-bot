# Teti 0.5.2-beta.1 — 用户可控的真实上下文注入

## 本次切片

`0.5.2-beta.1` 在 0.5.1 Shadow Retrieval 之上打开第一条真实注入路径，但注入默认
仍为关闭。只有接收端本地持续协作任务满足以下完整证据链时，SQLite 条目才会进入
本地 Agent CLI：

1. 本机成功阶段已经成为 SQLite source；
2. 本地用户把 source 确认为结构化条目，并可编辑标题、正文、类型、范围与 pin；
3. `workspace` / `peer` 范围获得“精确范围键 + 精确 Child”的本地授权；
4. 用户看到下一次执行的只读候选、原因、大小和预算结果，可临时排除条目；
5. 用户显式勾选“仅为下一次执行注入”并批准预览；
6. Host 在同一 Task、Peer、Workspace、Child、Query Digest 和有效期下消费一次批准。

任一步缺失、过期、被编辑、删除、撤销或不一致，都无条件降级为原有无记忆执行。
Memory UI、SQLite 或预览批准失败不得阻塞 Task 的批准或继续。

## SQLite schema v3

- `structured_memory_items` 保存 source、Task、Peer、Workspace、Child、当前版本与本地
  确认信任；活跃条目上限 5,000。
- `structured_memory_versions` 保存不可更新的版本；编辑追加版本，不覆盖旧版本。
- `structured_memory_items_fts` 只索引当前活跃版本，并与编辑/删除处于同一事务。
- `structured_memory_authorizations` 以 `workspace/peer + scope_key + child_agent_id`
  精确授权；Peer 和 Workspace 默认关闭，撤销持久化。
- `structured_memory_previews` 与候选表保存内容无关的批准证据、范围快照、Digest、
  排序、临时排除结果和 10 分钟有效期。
- `structured_memory_injection_manifests` 与候选表不可更新，只保存 ID、版本、范围、
  原因、Digest 和字节数，不复制正文。
- `structured_memory_deletions` 只留下 memory/source ID、删除前 Digest、时间、actor 与
  reason；正文、所有版本和 FTS 行在同一事务删除。

数据库仍由 Sidecar 单写，保留 `0700/0600`、`synchronous=FULL`、迁移 checksum、
integrity/foreign-key 检查和未知未来 schema 失败关闭。

## 检索与注入合同

候选必须属于同一 Child，并依次通过 `task > workspace > peer` 的精确范围筛选。
Workspace/Peer 没有授权记录即为关闭。排序使用范围、类型、pin、FTS 关键词、新近度
和稳定 ID；预览最多展示 16 条，实际最多注入 8 条，候选正文合计最多 12 KiB，最终
拼接后的 CLI 输入还必须小于 Task 输入硬上限。

临时排除只写入本次预览，不修改条目。批准后若版本、Digest、类型、范围或授权变化，
预览会被标记失效。消费成功生成 immutable injection manifest，并将预览标记为已消费；
下一次执行必须重新预览和批准。

Context Composer 使用固定的 `[TETI_STRUCTURED_MEMORY_V1]` JSON-lines reference-data
信封，明确声明历史内容不是系统指令；当前 Task 放在独立 `[CURRENT_TASK]` 段。记忆
不会改变 Execution Authority、Workspace grant、Child、Connector、Tool 或模型。
确定性 Delegation 子步骤在本切片中始终无记忆执行。

## 本地 UI 与协议边界

持续协作详情页提供：source 整理、版本化编辑、pin、二次确认删除、三范围卡片、
只读预览、临时排除、刷新以及单次注入开关。Renderer 不接收真实 Peer/Workspace
授权键；它只提交 Task、Child、范围和受限编辑字段，Host 从本地任务记录解析真实键。

新增 `task.memory.*` lifecycle 方法只存在于本机 App ↔ Sidecar 边界，不进入 Task、
Passport、Chatmail 或 Application Envelope。所有请求使用字段 allow-list、4 KiB 正文、
80 字标题、16 个排除 ID 和安全 ID/Child 规则。

## Beta.1 验收

- 未确认 source、默认关闭的 Peer/Workspace、不同 Peer/Workspace/Child 均不可见；
- 临时排除不进入 manifest，其余候选可补位；
- 编辑追加版本并使已批准预览失效，删除清除正文/FTS 且保留无正文审计；
- 一次批准只消费一次，重启后撤销仍生效；
- 真实 executor request 含固定 reference-data 信封，而 Task 记录不含本地记忆正文；
- Shadow 默认路径保持不注入；Delegation 保持不注入；
- 预览批准失败时 Task 仍正常批准并按无记忆执行；
- v1 数据库可依次迁移到 v2/v3，未知 v4 失败关闭且不重建文件。

## 后续 0.5.2 子版本

本切片不宣称完成路线图里的 supersede/关系编辑、0600 导出、到期策略、隐私仪表和
100 次并发/重启竞争夹具。这些继续留在 0.5.2 后续 beta，且不得放宽本切片已经建立的
“本地确认—精确授权—预览—单次批准—失败关闭”门禁。
