import type { AppMessages } from "../types.ts";

export const ZH_HANS_MESSAGES = {
  common: {
    appName: "Teti",
    unknown: "未知",
    unavailable: "暂不可用",
    actions: {
      cancel: "取消",
      close: "关闭",
      continue: "继续",
      delete: "删除",
      done: "完成",
      retry: "重试",
      save: "保存"
    },
    units: {
      items: { other: "# 项" },
      seconds: { other: "# 秒" },
      hours: { other: "# 小时" },
      days: { other: "# 天" }
    }
  },
  shell: {
    nameInputLabel: "Teti 名字",
    openTeti: "打开 Teti",
    openPendingTasks: { other: "打开 Teti 任务，# 个任务待确认" },
    openPendingConnections: { other: "打开 Teti 建联，# 个请求待确认" }
  },
  firstLaunch: {
    booting: { message: "正在醒来", progress: "正在醒来" },
    welcome: {
      title: "你好，主人。",
      message: "第一次见面，给我取个名字吧。",
      action: "下一步"
    },
    naming: {
      title: "给我一个名字。",
      message: "短一点会更适合留海屏。",
      action: "创建",
      placeholder: "名字"
    },
    creating: {
      title: "正在创建 Teti",
      phases: {
        preparing: { label: "正在醒来", message: "正在醒来" },
        provisioning_chatmail: { label: "正在创建身份", message: "正在创建身份" },
        persisting_account: { label: "正在保存", message: "正在这台 Mac 上保存" },
        registering_identity: { label: "正在连接", message: "正在连接" },
        verifying_account: { label: "正在检查", message: "正在检查" },
        finalizing: { label: "就绪", message: "Teti 准备好了。" }
      }
    },
    ready: { message: "我准备好了。", action: "完成", progress: "就绪" },
    idleMessage: "就在附近",
    recoverable: {
      title: "Teti 需要一点时间",
      titleWithCode: "Teti 需要一点时间 [{code}]",
      retryAction: "再试一次",
      retryConnectionAction: "再连接一次"
    },
    fatalTitle: "Teti 暂时不能继续",
    validation: {
      empty: "先给 Teti 一个名字。",
      tooLong: "名字最多 {maximum} 个字符。",
      controlCharacter: "名字不能包含控制字符。",
      generic: "名字暂时无法使用。"
    },
    errors: {
      temporaryAccountLoad: "Teti 暂时无法检查本机身份。",
      corruptAccount: "Teti 发现本机身份数据需要修复。",
      partialAccount: "Teti 的本机身份尚未完成。",
      chatmailProvisioning: "Chatmail 身份初始化未完成。",
      localPersistence: "Teti 无法安全保存本机身份。",
      networkIdentity: "Teti 暂时还没完成连接。",
      loadedAccountVerification: "Teti 无法验证本机身份。",
      runtimeStartup: "本机 Runtime 未能完成启动，请退出 Teti 后重试。",
      internalState: "Teti 遇到了内部设置问题。",
      unknown: "Teti 暂时还没完成。"
    }
  },
  updateBlocker: {
    title: "当前 Teti 需要升级",
    message: "本机版本已低于当前 Beta 支持门槛。请安装最新 Teti；其他已建联设备的版本状态不会锁定本机。",
    status: "本机 {currentVersion} · 最低支持 {minimumVersion} · 构建 {buildTimestamp}",
    unknownMinimumVersion: "待确认"
  },
  toolbar: {
    aiPassport: "查看 AI Passport：{plan}",
    aiPassportUnavailable: "暂时无法确认",
    passportSharingEnabled: "Passport 分享已开启",
    passportSettings: "打开 Passport 设置",
    collaborationTasks: "协作任务"
  },
  brand: {
    websiteLabel: "访问 {brand} 官网"
  },
  connections: {
    surfaceLabel: "连接其他 Teti",
    panel: {
      placeholder: "*********（teti.bot 社区 9 位 ID）",
      inputLabel: "Teti 社区 9 位 ID",
      connectAction: "建立连接",
      eyes: {
        open: "打开建联输入",
        connecting: "正在建立连接",
        transitioning: "建联输入正在切换",
        close: "收起建联输入"
      },
      messages: {
        connecting: "正在建立连接…",
        invalid_public_id: "请输入正确的 9 位 ID",
        request_sent: "建联请求已发送",
        approval_required: "对方正在等待你确认",
        connected: "已成功建联",
        already_connected: "你们已经建联",
        connection_timeout: "连接超时，请稍后重试",
        identity_not_found: "没有找到这个 Teti，请检查 ID",
        connection_failed: "暂时无法完成建联，请稍后重试"
      }
    },
    list: {
      label: "已建联 Teti 列表",
      unnamed: "未命名",
      idUnavailable: "ID 暂不可用",
      identity: "{name}（{id}）",
      identityWithoutId: "{name}（ID 暂不可用）",
      compatibility: {
        compatible: "兼容",
        upgradeRequired: "需要升级",
        checking: "版本检测中",
        upgradeHint: "仅暂停此节点协作",
        checkingHint: "本机功能保持可用"
      },
      reachability: {
        reachable: "在线",
        checking: "状态检测中",
        unreachable: "离线",
        peerStatus: "对方{status}"
      },
      accept: "接受建联",
      reject: "拒绝建联",
      accepting: "正在接受…",
      rejecting: "正在拒绝…",
      acceptFailed: "接受失败，请重试",
      rejectFailed: "拒绝失败，请重试",
      waitingApproval: "等待确认",
      rejected: "已拒绝",
      expandDetails: "展开 {identity} 的 AI Passport 详情",
      collapseDetails: "收起 {identity} 的 AI Passport 详情",
      unknownPeer: "该节点"
    },
    details: {
      fullDetailsLabel: "AI Passport 完整详情",
      sectionLabel: "{entity}，{count}",
      itemCount: { other: "# 项" },
      notShared: "未分享此类信息",
      quotaUnavailable: "未提供 Quota",
      approximatePrefix: "约 ",
      remainingQuota: "{product} {period}剩余额度",
      providerUnspecified: "Provider 未标注",
      inputModes: "输入：{modes}",
      outputModes: "输出：{modes}",
      listSeparator: "、",
      resourceAssociation: "Resource：{items}",
      agentAssociation: "Agent：{items}",
      bindingUnavailable: "未提供绑定",
      emptyBinding: "空绑定",
      localCompute: "本地算力",
      overflow: "另有 {count} 个 {entity}",
      notes: {
        stale: "AI Passport 已过期",
        disabled: "对方未分享 AI Passport",
        empty: "暂无 AI Passport"
      },
      resourceKinds: {
        subscription: "订阅资源",
        account: "账号资源",
        localModel: "本地模型",
        compute: "计算资源"
      },
      assurances: {
        providerObserved: "Provider 已观测",
        localObserved: "本机已观测",
        selfDeclared: "节点声明"
      },
      planUnavailable: "暂时无法确认",
      planUnknown: "计划未知",
      quotaPeriods: { week: "周额度", day: "日额度", hour: "小时额度" },
      windowUnknown: "窗口时长未知",
      daysWindow: { other: "# 天窗口" },
      hoursWindow: { other: "# 小时窗口" },
      secondsWindow: { other: "# 秒窗口" },
      modes: { image: "图片", text: "文本" },
      availability: {
        available: "可用",
        stale: "数据已过期",
        unavailable: "暂不可用",
        unknown: "暂时无法确认"
      },
      resetUnavailable: "重置时间暂不可用",
      resetAt: "{date} 重置",
      agent: {
        versionNotShared: "版本未共享",
        informationStale: "信息已过期",
        callable: "可调用",
        running: "运行中",
        installedUnknown: "已安装 · 状态未知",
        installed: "已安装",
        notFound: "未发现",
        unconfirmed: "未确认",
        versionUnknown: "版本未知",
        processes: { other: "# 个进程" }
      },
      binding: { complete: "绑定完整", incomplete: "绑定信息不完整" },
      computeOffer: {
        resource: "本地算力",
        execution: "接收端本机执行",
        concurrency: "并发 1",
        approval: "每次授权"
      },
      capabilityCategories: { coding: "编程", codeAnalysis: "代码分析" }
    }
  },
  passport: {
    title: "AI Passport",
    summary: {
      resources: { other: "# 项 AI 资源" },
      agents: { other: "# 个可用 Agent" },
      capabilities: { other: "# 项能力" }
    },
    sections: {
      resources: "AI 资源",
      agents: "可用 Agent",
      capabilities: "可调用能力"
    },
    usage: {
      remainingQuota: "剩余额度",
      approximatePrefix: "约 ",
      inferredFromLongestWindow: "按最长窗口推定",
      stale: "数据可能已过期",
      signedOut: "未登录",
      unavailable: "暂不可用",
      unknownPlan: "计划未知"
    },
    settings: {
      title: "设置",
      caption: "身份、分享与本机 Agent",
      myTeti: "我的 Teti",
      networkIdentity: "Network 身份",
      sharing: "Passport 分享",
      sharingHint: "向已建联 Teti 分享当前 Passport",
      language: {
        label: "Teti 界面语言",
        title: "语言",
        hint: "选择 Teti 界面使用的语言",
        options: {
          auto: "自动检测",
          chinese: "中文",
          english: "English"
        }
      },
      errors: {
        sharingSave: "Passport 分享设置暂时无法保存。",
        agentRescan: "Agent 重新扫描暂时失败。",
        agentPathSave: "路径无效或本机 Agent 配置暂时无法保存。",
        osaurusSave: "固定 Agent ID 无效，或本机配置暂时无法保存。",
        networkEnvironmentSave: "Network 开发环境设置暂时无法保存。",
        localReset: "无法重置本机 Teti，请退出 App 后重试。"
      },
      networkIdentityStatus: {
        active: "已连接 Network",
        checking: "检查中",
        synchronizing: "身份同步中",
        unavailable: "Network 暂不可用 [{code}]",
        unauthorized: "Network 身份认证失败",
        revoked: "Network 客户端已撤销",
        conflict: "Network 身份冲突"
      },
      networkVersion: {
        checking: "检测中",
        unavailable: "暂不可用",
        compatible: "Protocol {protocol} · Service {service}"
      },
      presence: {
        stopped: "尚未启动",
        sleeping: "系统睡眠 · 已暂停上报",
        checking: "正在连接",
        unavailable: "Network 暂不可用",
        unauthorized: "Network 身份认证失败",
        connected: "已连接 · {mode}",
        modes: {
          collaborating: "AI 协作中",
          viewingConnect: "正在查看建联面板",
          background: "后台在线",
          online: "在线"
        }
      },
      networkEnvironment: {
        label: "Teti Network 环境",
        title: "本机 Network 开发环境",
        localHint: "下次启动连接本机 teti-network",
        productionHint: "默认连接 network.teti.bot",
        localActive: "本机开发环境",
        productionActive: "生产环境",
        restartRequired: "设置已保存；重启后使用 {endpoint}"
      },
      build: {
        label: "Teti 程序版本与构建信息",
        appVersion: "程序版本",
        buildTimestamp: "构建时间（UTC）",
        networkVersion: "teti-network 版本",
        resetLocalTeti: "重置本机 Teti",
        resetting: "正在重置…",
        cancelReset: "取消重置",
        resetLabel: "重置本机 Teti 并清除本机 Profile",
        cancelResetLabel: "取消重置本机 Teti",
        confirmationLabel: "确认重置本机 Teti",
        warning: "这将永久清除本机 Teti Profile，包括 Network 凭据、建联缓存、消息、任务和 Child Memory。服务器端身份及数据不会被删除。",
        confirmReset: "清除并重置"
      },
      agentManagement: {
        title: "Agent 管理",
        found: { other: "已发现 #" },
        noneFound: "未发现本机 Agent",
        discovering: "正在发现本机 Agent…",
        rescanning: "正在重新扫描…",
        disabled: "Agent 发现已关闭",
        partiallyComplete: "{status} · 部分检测未完成",
        detectorWarning: "部分检测器未完成，不影响其他 Agent。",
        rescan: "重新扫描",
        scanning: "扫描中",
        pending: "完成首次安全扫描后显示 Agent 列表。",
        empty: "当前未检测到已安装的 Agent。",
        privacy: "仅检查安装、版本和运行状态；路径只保存在本机。",
        customPathEnabled: "自定义路径已启用",
        pathOverride: "路径 override",
        pathLabel: "{agent} 自定义安装路径",
        pathPlaceholder: "可执行文件绝对路径",
        saving: "保存中",
        save: "保存",
        clear: "清除"
      },
      osaurus: {
        label: "Osaurus Native Child Agent",
        title: "Osaurus Native Child",
        hint: "固定专用 Agent ID · 沿用本机 Agent 配置",
        statuses: {
          ready: "可调用",
          blocked: "安全资格未通过",
          checking: "安全资格检查中",
          unconfigured: "未配置"
        },
        statusWithReason: "{status}：{reason}",
        uuidLabel: "固定 Osaurus Agent UUID",
        uuidPlaceholder: "Agent UUID",
        checkingAction: "检查中",
        saveAction: "保存",
        clearAction: "清除",
        policy: "Teti 不修改 Tools、Osaurus Memory 与 Autonomous Exec；直接 Host Workspace 挂载仍被拒绝，且 Runtime 身份通过校验后才会进入 Passport。",
        insightsRetentionAccepted: "Osaurus Insights 会保留请求正文；已按本机 Agent 信任策略允许调用。"
      }
    }
  },
  memory: {
    label: "Child Agent Memory",
    title: "Child Memory",
    hint: "由 Teti 管理 · 默认关闭",
    exportAction: "导出",
    taskNote: "Task Memory 只在一次执行中存在。长期 Memory 必须先授权，再从已完成任务中单独保存；对端不能触发写入。",
    authorizationDescription: "允许你把完成结果保存为此 Child Agent 的长期上下文",
    authorizationLabel: "{agent} Child Agent Memory",
    emptyAgents: "检测到可用 Child Agent 后，可在这里单独授权长期 Memory。",
    savedRecords: { other: "已保存记录 #" },
    provenance: "{scope} · {agent} · 来源任务 {task} · Peer {peer}",
    expires: "到期 {date}",
    deleteAction: "删除",
    exported: "已导出 {count} 条：{path}",
    invalidDate: "未知",
    scopes: { workspace: "Workspace Memory", childAgent: "Child Agent Memory" },
    errors: {
      read_failed: "Child Memory 暂时无法读取。",
      authorization_required: "请先显式开启对应的长期 Memory 授权。",
      source_invalid: "当前任务没有可保存的本机文字结果。",
      scope_invalid: "当前 Workspace 不允许写入这类 Memory。",
      store_full: "Child Memory 已达到本机记录上限。",
      operation_failed: "本机 Child Memory 操作未完成，请检查授权与任务状态后重试。"
    },
    task: {
      note: "Task Memory 仅存在于本次执行。长期保存必须由你先开启范围授权，再单独保存完成结果。",
      unavailable: "本机 Child Agent 完成文字任务后，可选择保存；对端任务内容不会自动进入长期 Memory。",
      childLabel: "{agent} 长期 Memory",
      childDescription: "仅供同一 Child Agent 后续任务检索",
      workspaceLabel: "Workspace Memory",
      workspaceDescription: "仅供此 Workspace 与此 Child Agent 检索",
      authorizationLabel: "授权 {label}",
      saved: "已保存",
      saveResult: "保存结果"
    }
  },
  tasks: {
    surfaceLabel: "Teti 协作任务",
    header: {
      backToIsland: "返回留海屏",
      backToInbox: "返回任务列表",
      inbox: "协作任务",
      compose: "发起协作",
      detail: "任务详情",
      pending: { other: "# 个待确认" },
      semanticCaption: "Task · A2A 语义",
      newTask: "发起新任务"
    },
    peerHeading: {
      incoming: "来自 {name} 的协作请求【{date}】",
      outgoing: "发送给 {name} 的协作请求【{date}】",
      invalidTime: "时间未知"
    },
    inbox: {
      emptyTitle: "还没有协作任务",
      emptyNote: "从已建联 Teti 的 Passport 选择能力，发送文字或图片任务。",
      composeAction: "发起任务",
      imageProgress: "{received}/{total} 图"
    },
    composer: {
      peer: "发送给",
      capability: "调用能力",
      localCompute: "本地算力",
      mode: "协作模式",
      singleStage: "单次调用",
      longHorizon: "持续协作",
      promptPlaceholder: "清楚描述希望对方 AI 完成的任务…",
      promptLabel: "任务内容",
      addImages: "添加图片",
      hints: {
        longHorizon: "持续协作 · 仅文字 · 每阶段由 Host 显式推进 · 最多 16 阶段",
        localCompute: "接收端本地算力 · 仅文字 · 并发 1 · 每次授权",
        imageResultWithInput: "PNG/JPEG · 最多 4 张 · 结果必须返回图片",
        imageResult: "结果必须返回图片",
        images: "文字必填 · PNG/JPEG · 最多 4 张",
        textOnly: "该能力当前仅接受文字"
      },
      sending: "处理中…",
      send: "发送任务",
      multiImageWarning: "0.4.0 延续已知限制：多图送达仍在实机复盘；若图片不完整，对方无法授权或执行任务。",
      noCapabilities: "暂无可调用能力"
    },
    detail: {
      localComputeOffer: "通用文字协助 · 接收端本地算力",
      osaurusOffer: "通用文字协助 · Osaurus Native Agent",
      capability: "Capability · {capability}",
      fullTask: "完整任务",
      imageReceiving: "图片接收中 {received}/{total}…",
      imageUnavailable: "图片不可用",
      localExecution: "本机执行 · 第 {epoch} 轮",
      authorization: {
        loginTitle: "Agent 登录后 · 再允许一次",
        agentTitle: "{agent} · 仅允许一次",
        onceTitle: "仅允许一次",
        loginDetail: "Teti 不保存登录凭据；请先在本机完成 Agent 登录，再重新授权本任务。",
        localComputeDetail: "只执行本任务；接收端在本机解析 Runtime 与模型，不向对端公开端口、路径、硬件或凭据。",
        osaurusDetail: "只执行本任务；使用接收端固定的 Osaurus Agent。Tools、原生 Memory、Host Workspace 与 Autonomous Exec 必须保持关闭。",
        defaultDetail: "只执行本任务；授权时重新校验 Agent，不开放文件、命令或持续权限。"
      },
      artifact: {
        title: "{role} Artifact · 阶段 {stage}",
        final: "最终",
        intermediate: "中间",
        resultImageReceiving: "结果图片接收中…",
        hostFinal: "最终 Artifact · Teti Host 汇总 · Workspace r{revision}",
        childIntermediate: "中间 Artifact · 步骤 {step} · {agent} · {resource} · Workspace r{revision}"
      },
      safeCode: "状态代码：{code}",
      actions: {
        reject: "拒绝",
        retryAfterLogin: "登录后重试一次",
        allowOnce: "仅允许一次",
        resumeCheckpoint: "从检查点重新开始",
        stop: "停止任务",
        cancel: "取消任务"
      }
    },
    status: {
      canceling: "正在取消",
      agentLogin: "Agent 需要登录",
      awaitingConfirmation: "等待你确认",
      receivingImages: "正在接收图片",
      awaitingPeer: "等待对方确认",
      resultReceiving: "任务已完成 · 结果接收中",
      unknown: "状态未知",
      states: {
        submitted: "已提交",
        working: "工作中",
        completed: "已完成",
        failed: "失败",
        canceled: "已取消",
        rejected: "已拒绝",
        input_required: "需要输入",
        auth_required: "需要授权"
      }
    },
    executionProgress: {
      queued: "等待本机 Child Agent",
      running: "本机 Child Agent 正在执行",
      paused: "执行已暂停",
      interrupted: "执行已中断",
      canceling: "正在取消执行",
      canceled: "执行已取消",
      completed: "执行已完成",
      failed: "执行失败",
      unknown: "执行状态正在更新"
    },
    longHorizon: {
      delegationTitle: "Teti Host 委派 · 步骤 {current}/{total}",
      collaborationTitle: "持续协作 · 阶段 {stage}",
      workspaceExpiry: "Workspace r{revision} · 续期至 {date}",
      boundary: "确定性计划 · 深度 1 · Planner 关闭 · Child 不可联系远端或扩大 Workspace 权限",
      childStep: "步骤 {step} · {agent}",
      hostStep: "步骤 {step} · Teti Host",
      aggregationDetail: "Artifact 确定性汇总 · {state}",
      budget: "Workspace r{revision} · {seconds}s · 输出上限 {kib} KiB",
      stage: "阶段 {stage} · {agent}",
      structuredMemory: {
        title: "本地持续协作记忆",
        automaticNote: "仅将本机已成功提交的持续协作阶段写入 SQLite；不会读取或迁移旧版 Memory。",
        loading: "正在读取本地记忆状态…",
        unavailable: "本地记忆库暂不可用；任务结果仍保留，Runtime 会在后续读取时重试。",
        ready: "SQLite 已保存 {count} 个阶段",
        stage: "阶段 {stage} · {agent}"
      },
      phase: {
        pending_approval: "等待批准",
        queued: "排队中",
        working: "执行中",
        input_required: "等待补充指令",
        paused: "已暂停",
        interrupted: "已中断",
        completed: "已完成",
        failed: "失败",
        canceled: "已取消",
        expired: "已过期",
        unknown: "状态更新中"
      },
      progress: {
        queued: "阶段 {stage} 正在等待本机 Child Agent",
        running: "阶段 {stage} 正在执行 · {completed}/{total}",
        paused: "阶段 {stage} 已暂停",
        interrupted: "阶段 {stage} 已中断",
        canceling: "阶段 {stage} 正在取消",
        canceled: "阶段 {stage} 已取消",
        completed: "阶段 {stage} 已完成",
        failed: "阶段 {stage} 执行失败",
        unknown: "阶段 {stage} 状态正在更新"
      },
      nextInstructionPlaceholder: "补充下一阶段指令…",
      nextInstructionLabel: "下一阶段补充指令",
      sendInstruction: "发送补充指令",
      pauseRequested: "将在阶段边界暂停",
      pauseAfterStage: "阶段后暂停",
      supplementalInstruction: "补充指令：{instruction}",
      continueWithAgent: "继续使用 Child Agent",
      startNextStage: "开始下一阶段",
      acceptCurrentResult: "确认当前结果为最终结果",
      renewOneHour: "续期 1 小时",
      recoveryAudit: { other: "恢复与操作审计 · # 条" },
      delegationAudit: { other: "Host 委派审计 · # 条" },
      auditStage: "阶段 {stage}",
      auditActions: {
        session_created: "会话已创建",
        stage_started: "阶段已开始",
        progress_updated: "进度已更新",
        artifact_published: "Artifact 已发布",
        checkpoint_created: "检查点已创建",
        input_requested: "已请求输入",
        input_received: "已收到输入",
        pause_requested: "已请求暂停",
        paused: "已暂停",
        resumed: "已恢复",
        child_selected: "已选择 Child Agent",
        stage_failed: "阶段失败",
        renewed: "已续期",
        completed: "已完成",
        canceled: "已取消",
        expired: "已过期",
        restart_reconciled: "重启状态已协调"
      },
      delegationAuditActions: {
        plan_created: "计划已创建",
        plan_approved: "计划已批准",
        step_started: "步骤已开始",
        artifact_recorded: "Artifact 已记录",
        step_completed: "步骤已完成",
        step_failed: "步骤失败",
        aggregation_started: "汇总已开始",
        plan_completed: "计划已完成",
        plan_canceled: "计划已取消",
        restart_reconciled: "重启状态已协调"
      },
      approval: {
        title: "Teti Host 委派计划",
        plannerDisabled: "Planner 关闭",
        note: "由你明确指定本机 Child Agent 顺序。每步独立预算、超时和权限，最多 4 步，最后由 Teti Host 确定性汇总 Artifact。",
        step: "步骤 {step}",
        targetUnavailable: "本机目标待重新检测",
        remove: "移除",
        removeLabel: "移除委派步骤 {step}",
        add: "增加一步",
        approve: "按计划委派"
      },
      delegationStepStates: {
        pending: "待执行",
        working: "执行中",
        completed: "已完成",
        failed: "失败",
        canceled: "已取消",
        interrupted: "已中断"
      },
      workspacePolicies: {
        snapshot: "Workspace Snapshot",
        bounded_context: "有界上下文",
        none: "无 Workspace"
      }
    },
    images: {
      alt: "任务图片",
      remove: "移除图片",
      open: "打开结果图片",
      reveal: "在 Finder 中显示",
      saveAs: "另存为"
    },
    errors: {
      draft_incomplete: "请选择已建联的 Teti 和能力，并写明任务。",
      operation_timeout: "操作超时，Runtime 会继续保留任务状态。",
      transport_failed: "暂时无法处理这个任务。",
      result_image_unavailable: "这个任务结果图片暂时不可用。",
      result_image_invalid: "这个任务结果图片无效。",
      result_image_unsupported: "当前系统暂不支持这个图片操作。",
      result_image_open_failed: "暂时无法打开这个任务结果图片。",
      result_image_reveal_failed: "暂时无法在文件夹中显示这个任务结果图片。",
      result_image_save_failed: "暂时无法保存这个任务结果图片。",
      result_image_action_unsupported: "当前系统暂不支持这个图片操作。",
      operation_failed: "暂时无法处理这个任务。"
    }
  },
  nativeDialogs: {
    taskImages: {
      selectTitle: "选择任务图片",
      selectFilter: "图片",
      saveTitle: "保存结果图片",
      saveFilter: "图片"
    }
  }
} as const satisfies AppMessages;
