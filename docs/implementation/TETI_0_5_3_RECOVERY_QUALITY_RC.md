# Teti 0.5.3-rc.1 — Recovery & Quality RC

状态：代码与本机自动化门禁已完成；物理 Mac↔Mac、Mac↔Windows 验收尚未执行，
因此当前只能称为 RC 候选，不能宣称跨设备验收通过。

## 版本边界

0.5.3 不改变 Task、Passport、Chatmail 或对端协作协议。SQLite 仍然只存在于本地
Host，Connector 和协作对端没有数据库能力，也不会收到 Memory 回执。结构化记忆
schema 从 3 升到 4；应用版本为 `0.5.3-rc.1`。

## 恢复与回退

- 数据库切换为 WAL，保留 `synchronous=FULL`、`secure_delete=ON` 和
  `trusted_schema=OFF`，自动 checkpoint 为 256 页；正常关闭、显式删除和维护会做
  `TRUNCATE` checkpoint。
- schema 1/2/3 在第一次升级到 schema 4 前，先通过 SQLite Online Backup API 创建
  `0600` 的完整性校验备份；备份位于数据库同级受保护 recovery 目录，失败则不迁移。
- 显式导出会生成独立 SQLite 备份，校验 `integrity_check`、外键、文件尺寸与 SHA-256，
  且拒绝覆盖既有目标。
- 离线恢复要求 `--confirm`，拒绝仍存在 WAL/SHM 的活动数据库；覆盖前先生成当前库的
  safety backup。恢复中间文件采用同目录原子 rename，失败时恢复原库。
- 未知未来 schema 和迁移证据损坏不会重建文件，而是进入安全只读模式：阶段历史仍可
  查看，所有写入、检索 manifest 和 CLI 注入均关闭。
- 运维入口：

  ```sh
  npm run desktop:memory:recovery -- health --database <sqlite>
  npm run desktop:memory:recovery -- export --database <sqlite> --output <backup> --confirm
  npm run desktop:memory:recovery -- restore --database <sqlite> --backup <backup> --confirm
  npm run desktop:memory:recovery -- maintenance --database <sqlite> --confirm
  ```

## 删除、到期与配额

- 条目可在编辑器设置可选到期时间。到期后立即退出候选和注入资格；只有用户显式运行
  本地维护时才删除正文，不会按使用频率静默遗忘。
- 删除或到期清理在事务中移除当前条目、全部不可变版本、结构化 FTS、原始阶段 FTS，
  并把原始阶段正文清空。无正文 tombstone 阻止同一来源被隐式重新创建。
- 删除完成后 checkpoint；到期批量清理后执行 VACUUM、checkpoint、完整性和外键校验。
  删除审计仅保留 digest、时间、actor 和 reason code。
- 默认数据库硬配额为 64 MiB，80% 起报告 warning。达到硬上限后新增、编辑、预览和
  manifest 写入失败关闭；删除、撤销和恢复能力保留。
- 本地指标仅含候选数、选中数、预算拒绝、范围拒绝、删除、到期和安全错误计数，不含
  文本、名称、Task/Peer/Workspace ID、路径或可逆标识。

## 自动化 RC 门禁

统一命令：

```sh
npm run test:memory-recovery-rc
```

它默认启用严格的 5,000 条基准，并覆盖：

- schema 1→4 迁移、迁移前备份、未知 schema 和迁移证据损坏只读降级；
- 异常 Sidecar 退出后的 WAL 恢复、完整性、外键、显式导出和离线回退；
- 到期、删除物理清理、tombstone、防幽灵注入、100 路预览/删除竞争与重启；
- task/workspace/peer/Child 精确隔离、预览/批准/一次消费、Host Agent 实际输入边界；
- Lifecycle Bridge、Task UI、对端协议不携带本地 Memory 内容；
- Agent 结果质量的确定性评分：当前任务完成度 40%，已批准参考覆盖 60%，覆盖率至少
  80%、总分至少 88，并对矛盾、未批准引用和把参考当指令实行一票否决。

`cross-platform-ci.yml` 在 macOS 15 arm64 和 Windows x64 hosted runner 上运行同一门禁，
但显式设置 `TETI_STRICT_MEMORY_BENCHMARK=0`，使用 500 ms cold / 250 ms warm P95
的共享 runner 防退化线。共享云机器的负载和 I/O 无法作为稳定的 150 ms / 40 ms
发布认证证据。Windows 11 自托管认证显式设置为 `1`；本地不设置该变量时也默认严格，
继续使用 150 ms cold / 40 ms warm P95。Hosted runner 证明代码兼容与防止数量级退化，
不替代受控物理机性能认证和真实两台设备的协作验收。

### 2026-08-21 本机自动化证据

- Memory RC 专项：`113/113` 通过；其中 5,000 条 Shadow Retrieval 冷启动
  `43.23 ms`、热态 P95 `19.95 ms`，5,000 条真实授权预览冷启动 `77.06 ms`、
  热态 P95 `31.13 ms`。
- 完整 TypeScript 测试集合：共 `764` 项，在允许测试进程监听本机回环地址的环境中
  退出码为 `0`；`763` 项通过，`1` 项 Windows-only 用例在 macOS 按设计跳过。
  受限沙箱内同一集合的 6 个回环监听用例会以 `EPERM` 失败；两个所属测试文件在
  允许回环后 `13/13` 通过，不能把沙箱失败记作产品缺陷或悄悄删除这些测试。
- `tsc --noEmit`、本地化文案检查和 Vite production renderer build 通过；macOS
  Rust 单测 `32/32` 通过，Windows `x86_64-pc-windows-msvc` Rust shell 交叉检查通过。

GitHub hosted CI 已纳入上述兼容门禁；Windows 11 自托管认证只有在仓库变量
`TETI_WINDOWS_11_CI_ENABLED=true` 或手动触发时才运行。物理双机、严格受控机性能、
签名发布包 RSS/DB bytes 和真实 provider Agent 质量仍以验收模板中的“待执行”为准。

## Agent 质量证据

自动化能证明 prompt 分隔、manifest、授权、预算和确定性计分，但不能证明任意真实模型
总会正确使用历史。每个真实 Agent 场景必须由人工或 provider-specific evaluator 生成
以下不含正文的观察文件：

```json
{
  "schemaVersion": 1,
  "expectedReferenceCount": 5,
  "correctlyUsedReferenceCount": 4,
  "currentTaskSatisfied": true,
  "contradictionDetected": false,
  "unapprovedReferenceDetected": false,
  "instructionBoundaryViolated": false
}
```

再运行：

```sh
npm run desktop:memory:recovery -- quality --input <observation.json>
```

输出只含分数、覆盖率和稳定失败码。Codex、CodeBuddy、Osaurus Runtime/Native 中实际纳入
本次 RC 的 Connector 都必须分别通过，不能用 fake Agent 的通过代替真实 provider。

## 尚待物理签署

发布前必须填写
[0.5.3 物理双机验收记录](../qa/TETI_0_5_3_PHYSICAL_MEMORY_RC_EVIDENCE.md)：

- Mac↔Mac、Mac↔Windows 各完成一条至少 9 个阶段的持续协作；
- 每条在阶段边界和执行中各重启一次 App/Sidecar；
- 验证继续、撤销、删除、到期、Workspace revision 冲突、升级和版本回退；
- 两端发布包均记录性能、内存和数据库配额结果；
- 对每个真实 Agent 保存无正文质量观察和评分结果。

在两个 topology 都签署前，文档和产品状态必须保持 RC，不得写成“跨平台双机已通过”。
