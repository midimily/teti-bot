# Teti Beta 0.5 — SQLite 与结构化协作任务记忆路线图

状态：`0.5.0` 的收窄实施切片已完成代码接入，正在进入发布质量门禁。Beta 0.5
以 `0.4.1-beta.2` 的跨平台 Runtime 基线为前置条件；不改变既有 Task、Passport、
Chatmail 或 Application Envelope 的网络协议。

> 2026-08-20 实施决策：为降低首版复杂度，`0.5.0` 不迁移、不读取、不兼容
> `child-memory-v1.json`，也不交付 FTS、关系、向量或跨任务检索。它只为新版本
> 创建 SQLite，并把接收端本机成功提交的 `long_horizon` 阶段作为 task-scope、
> `peer_originated_reference` 本地记录。该自动记录不能进入 CLI 上下文；后续版本
> 仍须经过结构化确认与有界选择，才能成为可注入记忆。数据库首次启用时间之前的
> 任务不会补录。此实施决策覆盖下文中原先针对 `0.5.0` 的 v1 迁移设想。

> 2026-08-21 实施决策：`0.5.1` 先交付 **Shadow Retrieval**，用 `0.5.0`
> 已落库的 `peer_originated_reference` 阶段记录评估精确 `task` / `workspace` /
> `peer` 候选、FTS5、确定性排序、预算和不可变 manifest。Shadow manifest 只保存
> ID、Digest、范围、理由和字节预算，`cli_injection_enabled` 与每个候选的注入资格
> 均由数据库约束固定为关闭；Task Runtime 不改变 Connector / CLI 请求。用户确认
> 的结构化提升、关系编辑、授权 UI、执行前预览和真正的 Context Composer 注入仍在
> 后续显式开启版本完成。本决策覆盖下文 `0.5.1` 原计划中“直接注入”的部分。

## 产品目标

让一个长期协作在多个阶段、重启和多次与同一对端的任务之间保持连续性，
同时让用户始终知道：哪些历史被保存、为什么本次会被引用、以及如何立即
停止或删除它。

本系列将现有 `Child Memory v1` 从一个小型、时间倒序的 JSON 列表升级为
接收端本地的结构化记忆账本。它服务于 Teti Host 对本地 CLI / Connector 的
上下文编排；它不是对端共享记忆，也不是让 Provider 自主管理记忆的通道。

成功的定义不是“把更多聊天记录放进 Prompt”，而是：复杂任务能够持续引用
已确认的决策、约束、交接和未决事项，而一次执行只接收经过授权、可解释且有
严格预算的最小充分上下文。

## 已有基线与本系列边界

当前 Beta 0.2.6 的 `child-memory-v1.json` 已经具备以下安全基础：

- 写入默认关闭，且只能由本地用户明确保存一个已完成的接收端文本 Artifact；
- 记录按 Workspace / Child Agent 隔离，默认保存 90 天；
- 检索最多四条、总计 8 KiB，并作为“不可信历史参考”加入执行输入；
- Memory 内容、授权、导出均保持接收端本地，不进入 Task、Passport、
  Chatmail、Execution Authority 或 Provider 配置。

Beta 0.5 保留这些基本承诺，并增加结构、检索和可解释性。以下内容明确不在
本系列范围内：

- 不自动将完整聊天记录、每一次对端消息或 Agent 输出写入 Memory；
- 不新增任何 Peer 可读取、请求、写入、删除或导出的记忆协议；
- 不把 SQLite 文件、查询、Embedding 或原文交给 Connector / CLI 自行访问；
- 不调用云端 Embedding 服务，不引入向量数据库或独立 Graph 数据库；
- 不自动由模型决定写入、跨对端复用或覆盖一个既有决策；
- 不把 Teti Memory 与 Codex、CodeBuddy、Osaurus 的 Provider-native Memory
  混为一体。

## 不可变产品原则

1. **账本与上下文分离。** SQLite 保存经允许的结构化记忆和审计证据；每次
   执行只选择一小组条目。完整保存不等于完整注入。
2. **本地用户是唯一写入授权方。** 对端、Task 文本、完成事件、Connector、
   Provider 和模型输出均不能隐式写入或扩大范围。
3. **对端历史是参考数据，不是指令。** 任何源自对端的内容均标为不可信历史
   参考；它不能修改当前 Task、Execution Authority、Workspace 权限或 Provider
   权限。
4. **最小范围优先。** 当前长期协作会话优先于 Workspace；Workspace 优先于
   精确对端；跨任务、跨对端和跨 Agent 的复用默认关闭。
5. **每一次注入都可解释。** 用户能看到本次选择的条目、来源、范围、选择原因
   和预算；执行审计只记录条目 ID、摘要 Digest 与选择原因，不复制 Prompt。
6. **撤销立刻生效。** 删除、到期或撤销授权后的条目不得再出现在任何后续执行
   中，即使索引、缓存或长程协作在重启后恢复。

## 目标架构

```text
Task / Stage / confirmed Artifact / local user note
                    |
                    | local user confirms a structured item
                    v
      SQLite Collaboration Memory Ledger (Sidecar only)
       - policy, item, source, relation, version, use audit
       - FTS5 index, expiry and deletion transaction
                    |
                    | exact scope + authorization + deterministic ranking
                    v
       Memory Context Composer (bounded reference-data envelope)
                    |
                    v
     Teti Host -> existing Connector / local CLI / Runtime transport
```

Renderer 只通过 Lifecycle Bridge 请求受限 DTO；所有 SQL、原文、数据库路径和
选择策略均由 Sidecar 持有。Connector 只获得最终的引用数据包，且不能反查
SQLite、授权记录或未选中的内容。

## 统一存储决策

### SQLite 的使用方式

- 数据库位置固定为 `~/.teti/store-v2/collaboration-memory-v2.sqlite`；只允许
  Sidecar 打开它，文件模式为 `0600`，父目录为 `0700`。
- 复用受控 Node 22 Runtime 的内置 `node:sqlite`，不增加 `better-sqlite3`、
  Tauri SQL 插件或额外原生二进制。Windows 已锁定 Node `22.22.3`；macOS 打包
  也必须在构建、安装和启动时证明 `node:sqlite` 可用，不能只依赖开发机 Node。
- 启动时启用外键、预编译语句、受限的 schema / defensive 配置、`WAL`、
  `synchronous=FULL`、有限 busy timeout 和 `secure_delete`。只有 Sidecar
  一个写入者；写入采用短事务和 `BEGIN IMMEDIATE`，不会在长程 Agent 执行期间
  持有事务。
- 数据库访问失败、完整性检查失败或迁移状态不明确时，Memory v2 进入
  `MEMORY_STORE_UNAVAILABLE`：不注入任何 v2 内容，不自动删除、重建或“修复”
  文件，并提供本地诊断与恢复入口。

SQLite 文件受现有本机账户文件权限保护；Beta 0.5 不把“文件权限”误称为端到端
加密。若产品后续引入静态数据加密，必须作为独立的 Profile / 密钥生命周期特性，
而非悄悄改变 Memory 格式。

### 为什么暂不引入向量库或独立图数据库

Beta 0.5 首先要解决范围、出处、撤销、冲突和上下文预算，而不是语义召回率。
SQLite FTS5 与结构化过滤足以支撑首版检索；`memory_relations` 用一跳关系表达
“支持、替代、冲突、阻塞、派生于”。

检索层会定义 `MemoryCandidateRetriever` 接口，输出候选 ID、分数和可解释原因。
这样未来可增加本地 Embedding 的混合检索，而不改变授权、上下文 Composer 或
网络协议。独立 Graph DB 只有在跨大量实体的多跳查询已成为已验证的产品瓶颈时
才重新评估。

## 数据模型 v2

所有表均在同一个 SQLite 事务中写入；外键约束开启。文本字段使用 UTF-8，
ID 保持既有安全 ID 规则。每条 Memory 项最大 4 KiB；活跃项上限 5,000 条、
源引用上限 20,000 条、关系上限 10,000 条、数据库逻辑配额 64 MiB。超过配额
时只允许用户删除、导出或等待到期清理，绝不静默淘汰仍活跃的决策。

| 表 | 关键字段 | 用途与约束 |
| --- | --- | --- |
| `schema_migrations` | `version`, `applied_at`, `checksum` | 单调迁移记录；未知未来版本只读拒绝，不降级写入。 |
| `memory_policies` | `scope`, `peer_teti_id`, `workspace_id`, `child_agent_id`, `state`, `authorized_at`, `revoked_at` | 授权是精确范围的 allow-list；撤销不删除内容，但立即使其不可检索。 |
| `memory_items` | `memory_id`, `kind`, `scope`, `peer_teti_id`, `workspace_id`, `long_horizon_task_id`, `child_agent_id`, `state`, `trust`, `pinned`, `created_at`, `expires_at` | 记忆主记录；所有范围键、Child 和状态均由 CHECK / 外键 / 服务校验共同保证。 |
| `memory_versions` | `memory_id`, `version`, `title`, `content`, `content_digest`, `editor`, `created_at` | 追加式版本。修改或总结创建新版本，不能就地改写历史。 |
| `memory_sources` | `memory_id`, `source_kind`, `task_id`, `artifact_id`, `source_digest`, `captured_at` | 指向已有 Task、阶段 Artifact 或本地笔记；不复制完整 Chatmail 历史。 |
| `memory_relations` | `from_memory_id`, `relation`, `to_memory_id`, `created_at` | 仅支持 `supports`、`supersedes`、`contradicts`、`blocks`、`derived_from`；禁止任意关系名。 |
| `memory_context_uses` | `execution_id`, `memory_id`, `rank`, `reason`, `item_digest`, `selected_at` | 可解释的本地审计；不存执行 Prompt、Task 正文或全文副本。 |
| `memory_deletions` | `memory_id`, `deleted_at`, `actor`, `reason_code` | 只保留不含原文的删除证据，支持 UI 与故障调查。 |
| `memory_fts` | 当前活跃版本的受控搜索字段 | FTS5 辅助索引；与主记录在同一事务更新和删除。 |

`kind` 的初始枚举为 `decision`、`constraint`、`fact`、`open_question`、
`handoff`、`summary`、`local_note`。`trust` 只有 `local_user_confirmed` 与
`peer_originated_reference`；后者不能自动提升为前者。

范围规则如下：

- `task`：必须匹配精确的长期协作任务和本地 Child；只用于该协作的后续阶段。
- `workspace`：必须匹配精确 Workspace 和本地 Child；仅在用户已授权的
  durable Collaboration Workspace 内可用。
- `peer`：必须同时匹配精确 Peer Teti ID 与本地 Child；仅在用户明确打开
  “与此对端跨任务复用”后可用，默认关闭。
- `child_agent`：仅作为 v1 迁移兼容范围保留；Beta 0.5 不新增广域 Child 记忆，
  用户必须将它重分类为更窄范围后才能新增类似内容。

原始消息和完整 Artifact 继续由既有 Task / Artifact 存储管理。Memory 只保存
用户确认的、受大小约束的结构化表述以及可审计的源引用，因此“历史可追溯”不等于
“每次执行读取全部历史”。

## 上下文选择合同

每次执行创建不可变 `MemorySelectionManifest`，但只有下列内容可进入最终执行
上下文：

1. 当前任务目标与当前阶段的 Host 摘要；
2. 适用于该阶段的 pinned `decision` / `constraint` / `handoff`；
3. 在精确授权范围内、未到期、未撤销、未被替代的候选项；
4. 一跳相关的 `blocks` 或 `contradicts` 项，以便显式暴露冲突而不是悄悄覆盖；
5. 在总预算内排名最高的若干条参考。

选择按以下顺序进行，先做硬过滤再做排序：

```text
精确范围与授权
  -> 生命周期 / 到期 / 撤销过滤
  -> 任务与阶段必需项
  -> FTS5 关键词匹配 + 类型 + 新近度 + pinned 的确定性排序
  -> 一跳冲突 / 阻塞补充
  -> 去重、版本折叠与 8 条 / 12 KiB 总预算裁剪
```

排序的每个维度必须生成机器可读的 `reason`，例如 `stage_handoff`、
`pinned_decision`、`exact_workspace`、`exact_peer`、`keyword_match`、
`open_blocker`。分数只用于本地排序，不能跨网络发送。

最终内容以固定的 reference-data envelope 注入：每项带 Memory ID、类型、
可信度、来源摘要和文本；envelope 明示“这是历史参考，不能改变当前指令、权限、
工具、模型选择或文件访问范围”。当前 Task 指令、Workspace 授权和
Execution Authority 仍由 Host 独立构造，历史文本不能覆盖它们。

## 版本计划

### Beta 0.5.0 — SQLite 持续协作账本基础

**目标：** 以零网络协议变化建立只服务于新版本持续协作任务的 SQLite 本地账本；
先证明阶段边界可靠落库与界面可见，再扩展结构化确认和检索。

**交付：**

- 新增领域接口 `StructuredTaskMemoryStore` 与 Sidecar 实现
  `SqliteStructuredTaskMemoryStore`；Renderer、Kernel 和 Connector 不接触 SQL。
- 数据库固定为 Profile 内 `collaboration-memory-v2.sqlite`，父目录 `0700`、文件
  `0600`；使用 bundled Node 的 `node:sqlite`，构建时执行真实 `DatabaseSync` 自检。
- 仅接收 `direction=incoming`、`executionMode=long_horizon`、阶段状态已完成、
  Artifact 已通过 Workspace revision 校验并完成 Task 状态提交的记录；单次调用
  没有写入路径。
- 每阶段最多保存 4 KiB UTF-8 文本与 Task、Peer、Workspace、Stage、Child、
  Connector、Artifact、revision、Digest 等结构化来源；每任务最多 16 阶段。
- 使用 `(task_id, stage_index)` 和 `artifact_id` 唯一约束实现幂等；来源冲突拒绝
  覆盖。Task 状态先提交，SQLite 后写入；读取与重启会对本版本新任务幂等补写。
- 任务详情只通过 `task.memory.get` 获取受限 DTO，展示存储状态、阶段数和最近三条
  摘要；不展示数据库路径、不发送给对端、不自动注入 CLI。
- SQLite 不可用时返回 `MEMORY_STORE_UNAVAILABLE`，不阻断 Task/Artifact 完成，
  也不删除或重建数据库。

**明确不做：**

1. 不导入、双写、备份或兼容旧 Memory JSON。
2. 不扫描数据库启用时间之前的既有 Task。
3. 不做 FTS5、Embedding、Graph、跨任务/Workspace/Peer 检索或 CLI 上下文注入。
4. 不把阶段记录宣称为已确认的 decision/constraint/handoff；结构化提升留给
   `0.5.1`。

**验收标准：**

- SQLite 单元测试通过：schema 创建、短事务、幂等、冲突拒绝、UTF-8 4 KiB
  边界、重启持久化、首次启用时间隔离、文件权限和完整性检查。
- Runtime 集成测试证明：持续协作成功阶段写入一条；同任务重读不重复；单次调用
  为零条；Workspace 冲突、过期、失败阶段均为零条。
- Lifecycle Bridge 与任务详情测试证明：只有持续协作请求本地 Memory DTO，读取
  与 Execution/图片/Delegation 并行，数据库失败投影不暴露路径或内容。
- macOS 与 Windows 打包 App 在真实 bundled Node 中均通过 SQLite self-test；没有
  额外未签名原生模块或动态数据库依赖。
- `PRAGMA integrity_check`、外键检查、文件权限、只读目录和 busy timeout 均有稳定
  的安全错误投影；本切片单写者使用 DELETE journal，不引入 WAL 恢复复杂度。
- 现有 Child Memory、长程任务、Workspace、Codex、CodeBuddy、Osaurus、Task、
  Passport 和跨平台安装回归测试全绿；Task / Passport / Chatmail schema diff 为零。

### Beta 0.5.1 — 结构化任务记忆与可解释检索

**目标：** 让长期任务在阶段边界保存并选择“决策、约束、交接、未决事项”，而不是
按时间把完整历史塞进 CLI。

**本次实施切片：** 只生成可解释的 Shadow candidates 与 manifest，不把候选原文
拼接进 CLI。它用于验证范围隔离、召回、顺序和预算，为后续用户确认与注入开关
收集本地质量证据；不能宣称 Agent 已经使用这些记忆。

**交付：**

- 引入 v2 结构化条目、版本、来源、关系和精确 `task` / `workspace` / `peer`
  授权；所有新写入仍需用户确认。
- 长程协作阶段完成时生成一个**待确认**的本地 Memory draft，包含来源、建议类型、
  上限 4 KiB 文本和初始范围；未确认的 draft 在任务详情可编辑或丢弃，不能检索。
  draft 由规则化的 Artifact / Host 状态抽取，不调用模型自动总结。
- 实现确定性的 `MemoryCandidateRetriever`：精确 scope、授权、状态、FTS5、类型、
  pinned、新近度和一跳阻塞 / 冲突查询；每个候选均返回解释原因。
- 实现 `MemoryContextComposer` 与不可变选择 manifest。默认最多 8 条、12 KiB；
  超限时按规则裁剪，绝不裁掉当前阶段 handoff 或已 pinned 的安全约束而不向用户
  报告。
- 保存本次执行所选条目的 ID、版本、Digest、rank、reason 和时间；不保存拼接后的
  Prompt，不给 Provider 发送审计记录。
- 扩展 Host / Kernel 合同，使 Context Composer 在 Connector 前完成；Connector
  继续只有最终 reference-data envelope，无法要求“再多一些 Memory”。

**验收标准：**

- 500 次同输入的选择结果、顺序、Digest 和预算完全一致；FTS 关键词不同但范围
  不同的记录绝不互相召回。
- 同一 Peer 的历史只能在该 Peer + Child 的 `peer` 授权打开后被检索；换 Peer、
  换 Workspace、换 Child、撤销授权、到期、删除或 supersede 后均立即不可见。
- 注入内容永远不超过 8 条 / 12 KiB；执行输入始终包含当前 Task 的独立指令，且
  历史 envelope 中不能出现 Workspace 路径、Execution Authority、Provider token、
  Peer 联系方式或未选中条目。
- `contradicts` 与 `blocks` 条目在预算内可见，并以参考数据呈现；产品不得声称
  已自动消解冲突。
- 历史提示注入夹具证明 Composer 的分隔、可信度标识和 Host 权限不受记忆文本
  影响；模型输出不可被保证，但执行权限、工具和路径边界必须保持不变。
- 5,000 条活跃记忆、20,000 条来源、10,000 条关系的标准夹具上，暖查询 P95
  不超过 40 ms、冷查询 P95 不超过 150 ms，且 Sidecar 事件循环无超过 50 ms 的
  未解释阻塞。

### Beta 0.5.2 — 对端连续性、用户控制与可见性

**目标：** 把“与这个协作对端的历史可以作为本地 CLI 上下文”做成显式、可预览、
可撤销的产品能力，而非隐藏的自动记忆。

**交付：**

- 在 Memory 设置和长期任务详情提供范围卡片：本任务、当前 Workspace、此对端；
  每张卡显示默认状态、授权时间、Child、到期和条目数。`peer` 范围始终默认关闭。
- 在执行前提供只读“本次将使用的记忆”预览：条目标题、类型、来源、范围、选择
  原因、大小和冲突警告。用户可临时排除一条，临时排除不修改永久记录。
- 支持本地用户创建 / 编辑 / pin / unpin / supersede / delete 结构化条目，并要求
  编辑后保留旧版本、来源和 Digest。
- 删除在同一事务中移除活跃文本、FTS 索引、关系可达性和后续检索资格；只留下
  不含原文的删除审计。导出只能由本地用户触发，导出文件为 `0600` 并包含版本和
  来源，而非其他 Peer 的可访问 API。
- 对端范围明确展示：内容从此前的本地协作记录而来，只会在本机调用本地 Agent
  时作为参考；对端不会收到“被记住了”的网络回执，也无法读取、搜索或删除它。
- 增加本地隐私仪表与诊断：只显示数量、状态和稳定错误码，不显示原文或选择
  内容。中英文文案、键盘操作、屏幕阅读器标签和窄窗口行为必须与 0.4.1 共享
  UI 基线一致。

**验收标准：**

- 用户在执行前能解释每一条被注入的条目；删除或“本次排除”后下一次执行的
  manifest 不包含该条目。
- 关闭 Peer 授权、切换 Child 或清除对端历史后，不论 FTS、关系或缓存命中，
  该内容均不会进入 CLI 输入；重启 Sidecar 后结论不变。
- 导出、删除、过期和撤销的竞争操作在 100 次并发 / 重启夹具下无幽灵条目、
  重复关系或丢失的删除事件。
- Memory UI 的失败不能阻塞 Task、Passport、连接、应用启动或现有 v1 / v2 数据
  的只读查看；所有本地错误安全地映射为稳定的本地错误码。
- 自动化检查证明 Task、Passport、Chatmail、网络诊断、日志和崩溃投影不包含
  `memory_items.content`、FTS 查询、选择的文本或 SQLite 文件路径。

### Beta 0.5.3 — 恢复、性能与发布候选

**目标：** 将结构化协作记忆从“功能可演示”推进到跨 Mac / Windows、长程任务、
升级和故障条件下可交付的 Beta 能力。

**交付：**

- 完成 v2 备份 / 导出 / 恢复流程、只读故障模式、WAL checkpoint 策略、数据库
  配额预警和受控的过期清理。清理只删除已到期或已删除内容，绝不按使用频率
  静默遗忘。
- 在长程任务重启、暂停、继续、Stage 变更和 Workspace revision 冲突时重建选择
  manifest；晚到的旧 execution epoch 不能写入记忆、覆盖版本或记录一次成功使用。
- 补齐跨版本兼容矩阵：0.4.1 Peer 与 0.5.x Peer 继续协作；0.5 的本地 Memory
  不影响对端协议能力；未知未来 SQLite schema 进入安全只读模式。
- 为安全和产品质量增加本地计数指标：候选数、选中数、预算拒绝、范围拒绝、
  删除成功、迁移状态和安全错误码。任何指标都不得包含文本、名称、Peer ID 或
  可逆标识。
- 发布候选附带迁移回归工件、性能报告、数据库完整性报告和人工双机长程任务
  记录；这些均为本地 / CI 证据，不进入用户的协作消息。

**发布验收标准：**

- 全量单元、SQLite 集成、Kernel、Lifecycle Bridge、UI、跨平台打包、迁移、
  故障注入和安全回归测试通过；不存在被临时跳过的 Memory 测试。
- 至少完成以下物理验收：Mac↔Mac、Mac↔Windows 各一条超过 8 个阶段的长期
  协作；在阶段边界和执行中各做一次 Sidecar / App 重启；验证继续、撤销、删除、
  到期和版本回退后的上下文均符合 manifest。
- 在发布候选从 v1 升级、发生磁盘满 / 只读 / 非正常退出、再升级或回退的
  矩阵中，用户的 Task 和现有 v1 备份均不丢失；不完整 v2 数据永远不会被注入。
- 性能基准、内存占用和数据库配额在 macOS Apple Silicon 与 Windows x64 的
  发布包中达到 0.5.1 门槛；超过门槛不能以关闭范围检查、扩大 Prompt 或禁用
  `synchronous=FULL` 的方式换取通过。
- 安全评审确认：所有 durable 写入都有本地用户授权证据；所有执行选择都有
  manifest；撤销即时性、范围隔离、路径 / token 不泄露和 Memory-free 网络协议
  均有自动化证据。

## 质量把关矩阵

| 层级 | 必须验证的内容 | 失败时的产品行为 |
| --- | --- | --- |
| 模型与校验 | scope 键、枚举、来源、版本、关系、Digest、期限、预算 | 拒绝输入，不写库，不注入。 |
| SQLite 仓储 | 事务、外键、迁移幂等、WAL 恢复、完整性、权限、配额 | 进入 `MEMORY_STORE_UNAVAILABLE`，保留文件和诊断。 |
| 检索与 Composer | 精确范围、排序确定性、冲突可见、预算、reference-data 分隔 | 失败关闭为“无历史记忆”，当前 Task 仍可执行。 |
| Host / Connector | Context 只由 Host 交付，Connector 无数据库能力 | 拒绝执行规范，禁止 Provider 扩大上下文。 |
| 生命周期与 UI | 预览、临时排除、授权、撤销、删除、导出、重启 | 不影响非 Memory 的 Task / Passport 主路径。 |
| 网络与隐私 | Task / Passport / Chatmail / 日志 / 诊断零内容泄露 | 构建或测试失败，不能发布。 |
| 物理验收 | 双机、跨平台、长程重启、升级、故障与恢复 | 保持 Beta / RC 状态，不宣称生产可用。 |

每项验收测试都必须采用真实 `TetiHostAgent` / Lifecycle Sidecar 边界或可重复的
SQLite 故障夹具；不能只用 mock 来替代权限、事务、重启或网络投影验证。对模型
无法保证的历史提示注入风险，要测试 Host 的确定性边界和清晰 UI 标识，而不是
以“模型总会服从”作为安全证据。

## 后续版本的决策门

Beta 0.5 完成后，只有同时满足下列信号才评估本地向量检索：

1. 用户和产品测试证实 FTS + 结构化过滤在同义表达、跨语言或长历史中持续漏召回；
2. 范围、删除、到期、导出与 explainability 已稳定运行；
3. 可在本机生成 Embedding，或对任何外部处理获得单独、可撤销的用户授权；
4. 新检索器能在同一 scope / manifest / 审计合同下运行，并可一键关闭回退到
   FTS。

独立 Graph DB 则需额外证明：单 SQLite `memory_relations` 的一跳 / 少量查询已
无法满足经验证的多跳关系问题，且其运维、删除与导出成本不会破坏本地优先原则。
在这些证据出现前，Beta 0.5 的优先级是可靠、可控、可解释的 SQLite 结构化记忆，
而不是追求数据库类型的复杂度。
