# Teti 0.5.3 物理双机 Memory RC 验收记录

状态：**待执行**。本模板不代表 Mac↔Mac 或 Mac↔Windows 已通过。

禁止记录 Memory 正文、Prompt、姓名、Teti ID、邮件地址、token、数据库路径或其他可逆
标识。设备用 `A` / `B`，任务用本记录内不可关联的序号。

## 构建身份

- 版本：`0.5.3-rc.1`
- commit：待填写
- Mac 包 SHA-256：待填写
- Windows 包 SHA-256：待填写 / Mac↔Mac 场景填 N/A
- 执行日期与签署人：待填写

## 场景一：Mac↔Mac

- [ ] 两台物理 Mac，均使用上方同一 RC commit 的发布包
- [ ] 持续协作完成 ≥9 个阶段
- [ ] 阶段边界重启 App 与 Sidecar 后可继续，未重复注入
- [ ] Agent 执行中重启 App 与 Sidecar；旧 execution epoch 未写 Memory 或成功使用记录
- [ ] Workspace revision 冲突后旧结果未发布，下一次重新生成 preview/manifest
- [ ] 撤销 Workspace/Peer 授权后下一次执行无相应候选
- [ ] 临时排除和删除后下一次 manifest 无对应条目
- [ ] 到期后立即不检索；显式维护后正文、FTS 与来源文本清理
- [ ] schema 1/2/3 升级备份、0.5.3→0.5.2 只读回退、备份恢复均无 Task 丢失
- [ ] 边界/Agent 重启次数：待填写 / 待填写
- [ ] 阶段数：待填写
- [ ] integrity / foreign key：待填写
- [ ] cold / warm P95 / RSS / DB bytes：待填写
- [ ] Agent 质量分数与失败码：待填写
- 结论：待执行

## 场景二：Mac↔Windows

- [ ] 一台物理 Mac 与一台 Windows 11 x64，使用上方同一 RC commit 的发布包
- [ ] 持续协作完成 ≥9 个阶段
- [ ] 阶段边界重启 App 与 Sidecar 后可继续，未重复注入
- [ ] Agent 执行中分别重启 Host；旧 execution epoch 未写 Memory 或成功使用记录
- [ ] 0.4.1 Peer 与 0.5.3 Peer 的 Task 协作保持兼容，Memory 没有进入网络消息
- [ ] Workspace revision 冲突、撤销、临时排除、删除、到期均符合本地 manifest
- [ ] Windows ACL、Mac `0600/0700`、WAL 恢复、升级/回退和备份恢复通过
- [ ] 两端严格 5,000 条性能门槛通过，未关闭范围检查、FULL 同步或扩大 Prompt
- [ ] 边界/Agent 重启次数：待填写 / 待填写
- [ ] 阶段数：待填写
- [ ] 两端 integrity / foreign key：待填写
- [ ] 两端 cold / warm P95 / RSS / DB bytes：待填写
- [ ] 各真实 Agent 质量分数与失败码：待填写
- 结论：待执行

## 泄露与证据审计

- [ ] Task、Passport、Chatmail、网络诊断、普通日志、崩溃投影均无 Memory 正文
- [ ] evidence 只有计数、布尔结果、版本、hash、耗时、字节数和稳定错误码
- [ ] 每次实际注入有 immutable manifest；无 manifest 的执行为 memory-free
- [ ] 每次 durable 用户条目写入可追溯到本地确认；对端不能搜索、读取或删除

## RC 决策

- Mac↔Mac：待执行
- Mac↔Windows：待执行
- Security / privacy：待执行
- Agent quality：待执行
- 发布决定：保持 RC
