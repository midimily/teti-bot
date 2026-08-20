# Teti `0.5.0` 持续协作 SQLite 本地记忆

状态：核心实现与自动化回归已完成；真实 macOS 打包冒烟、Mac↔Mac 物理协作和
Windows 打包验证仍是发布门禁。

## 本次实施边界

`0.5.0` 只处理新版本的持续协作任务：接收端本机 Child Agent 成功完成一个
`long_horizon` 阶段，且该阶段 Artifact 已通过 Workspace revision 校验并提交到
Task Store 后，Runtime 将一条 task-scope 阶段记录写入 Profile 内的
`collaboration-memory-v2.sqlite`。

单次调用、失败/取消/过期阶段、Workspace 冲突结果和数据库首次启用前的旧任务均
不会写入。`child-memory-v1.json` 不读取、不迁移、不双写；本版本也不提供 FTS、
向量、图关系、跨任务检索或 CLI 上下文注入。

## 数据与一致性

- 每任务最多 16 条，每阶段最多 4 KiB UTF-8 文本。
- 保存 Task、Peer、Workspace、Stage、Child、Connector、Artifact、revision、
  execution epoch、内容 Digest 和时间；UI 只取得受限摘要 DTO。
- `(task_id, stage_index)` 与 `artifact_id` 唯一，重复写入幂等，不同来源冲突拒绝
  覆盖。
- Task JSON 先提交，SQLite 后写入；若后者暂时失败，Task 结果不回滚。后续详情
  读取或 Sidecar 重启会只对数据库启用后的任务执行幂等补写。
- SQLite schema 创建使用短 `BEGIN IMMEDIATE` 事务，`synchronous=FULL`、
  `trusted_schema=OFF`、`secure_delete=ON`、250 ms busy timeout 和 DELETE journal。
  单 Sidecar、最多 16 条的读写负载不需要 WAL 或独立数据库 Worker。
- 父目录权限 `0700`、数据库文件 `0600`。损坏、未知 schema 或打开失败统一投影
  `MEMORY_STORE_UNAVAILABLE`；不会自动删除、重建或在日志中输出数据库路径。

## 界面与协议边界

任务详情对本机接收的持续协作显示“本地持续协作记忆”：当前 SQLite 状态、已保存
阶段数和最近三条阶段摘要。Renderer 仅调用新的本地 Lifecycle 方法
`task.memory.get`；Task、Passport、Chatmail 和 Application Envelope 没有 schema
变化，对端不能读取或触发此接口。

原有手动 Child Memory 卡片不再出现在持续协作详情，避免把旧版跨任务授权与本次
task-scope 自动阶段账本混为一体。

## 已完成验证

- TypeScript typecheck 与中英文本地化守卫。
- SQLite 实库测试：创建、权限、持久化重开、幂等、来源冲突、UTF-8 边界和旧任务
  cutoff。
- 双 Peer Runtime 测试：持续协作成功阶段写入；同一 Runtime 完成的单次调用保持
  零记录。
- 长程协作既有回归：重启、补充输入、显式切换 Child、Delegation、Workspace
  revision 冲突和过期结果。
- 任务 Controller 回归：Memory、Execution、图片和 Delegation enrichment 不形成
  串行瀑布。
- Runtime bundle 在复制 Node 前执行内存 SQLite + STRICT table 自检；失败阻止构建。

## 发布前仍需完成

1. 已在 Apple Silicon macOS 完成实际 Runtime bundle 与 Renderer production build；
   仍需完成 Tauri build 与 ad-hoc App 启动冒烟，检查真实 Profile 数据库权限和
   重启恢复。
2. 完成一条 Mac↔Mac 双机持续协作，至少两个阶段；验证成功阶段数、失败阶段不写、
   App/Sidecar 重启后记录不重复。
3. 在 Windows x64 bundled Node `22.22.3` 完成相同 SQLite 自检与安装包冒烟。
4. 增加只读目录、busy timeout 与损坏/未来 schema 的发布级故障夹具；确认 UI 只
   显示稳定错误，不阻断 Task。
5. 全量 Desktop、Rust 与 release build 回归通过后，再更新应用 SemVer 和发布说明。
