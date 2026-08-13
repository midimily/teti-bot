import type { PassportController } from "./controller.ts";
import type { MemoryController } from "../memory/controller.ts";
import type {
  AgentViewModel,
  AiPassportPanelViewModel,
  CapabilityViewModel,
  ManagedAgentViewModel,
  PassportSettingsViewModel,
  ProviderViewModel,
  RemotePassportViewModel,
  ResourceTone,
  ResourceViewModel
} from "./view-model.ts";

const codexIconUrl = new URL("../../assets/codex-status.png", import.meta.url).href;

export function createAiPassportPanel(viewModel: AiPassportPanelViewModel): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "teti-header-panel teti-ai-status-panel";
  panel.dataset.scrollKey = "passport";
  panel.hidden = !viewModel.open;
  const panelHeading = document.createElement("div");
  panelHeading.className = "teti-panel-heading";
  const heading = document.createElement("strong");
  heading.textContent = viewModel.title;
  const summary = document.createElement("small");
  summary.textContent = passportSummary(
    viewModel.resources.length,
    viewModel.agents.length,
    viewModel.capabilities.length
  );
  panelHeading.append(heading, summary);
  panel.append(panelHeading);
  if (viewModel.resources.length > 0) {
    const section = document.createElement("section");
    section.className = "teti-passport-section teti-resource-section";
    section.append(createSectionTitle("AI 资源", viewModel.resources.length));
    for (const resource of viewModel.resources) section.append(createResourceRow(resource));
    panel.append(section);
  }
  if (viewModel.agents.length > 0) {
    const section = document.createElement("section");
    section.className = "teti-passport-section teti-agent-section";
    section.append(createSectionTitle("可用 Agent", viewModel.agents.length));
    for (const agent of viewModel.agents) section.append(createAgentRow(agent));
    panel.append(section);
  }
  if (viewModel.capabilities.length > 0) {
    const section = document.createElement("section");
    section.className = "teti-passport-section teti-capability-section";
    section.append(createSectionTitle("可调用能力", viewModel.capabilities.length));
    const list = document.createElement("div");
    list.className = "teti-capability-list";
    for (const capability of viewModel.capabilities) list.append(createCapabilityChip(capability));
    section.append(list);
    panel.append(section);
  }
  return panel;
}

export function createPassportSettingsPanel(
  viewModel: PassportSettingsViewModel,
  controller?: PassportController,
  memoryController?: MemoryController,
  childAgents: readonly AgentViewModel[] = []
): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "teti-header-panel teti-sharing-panel";
  panel.dataset.scrollKey = "settings";
  panel.hidden = !viewModel.open;
  const panelHeading = document.createElement("div");
  panelHeading.className = "teti-panel-heading";
  const title = document.createElement("strong");
  title.textContent = viewModel.title;
  const caption = document.createElement("small");
  caption.textContent = "身份、分享与本机 Agent";
  panelHeading.append(title, caption);
  const overview = document.createElement("section");
  overview.className = "teti-settings-card teti-settings-overview";
  const identity = document.createElement("div");
  identity.className = "teti-settings-identity-row";
  const identityKey = document.createElement("span");
  identityKey.className = "teti-settings-label";
  identityKey.textContent = "我的 Teti";
  const identityValue = document.createElement("span");
  identityValue.className = "teti-settings-identity-value";
  identityValue.textContent = viewModel.identityLabel;
  identityValue.title = viewModel.identityLabel;
  identity.append(identityKey, identityValue);
  const networkIdentity = document.createElement("div");
  networkIdentity.className = "teti-settings-identity-row";
  const networkIdentityKey = document.createElement("span");
  networkIdentityKey.className = "teti-settings-label";
  networkIdentityKey.textContent = "Network 身份";
  const networkIdentityValue = document.createElement("span");
  networkIdentityValue.className = `teti-settings-identity-value is-${viewModel.networkIdentityTone}`;
  networkIdentityValue.textContent = viewModel.networkIdentityLabel;
  networkIdentity.append(networkIdentityKey, networkIdentityValue);
  overview.append(identity, networkIdentity);
  const networkEnvironment = document.createElement("section");
  networkEnvironment.className = "teti-settings-card teti-network-environment";
  networkEnvironment.setAttribute("aria-label", "Teti Network 环境");
  const networkToggle = document.createElement("label");
  networkToggle.className = "teti-toggle-row teti-network-environment-toggle";
  networkToggle.setAttribute("aria-busy", String(viewModel.networkEnvironmentBusy));
  const networkCopy = document.createElement("span");
  networkCopy.className = "teti-toggle-copy";
  const networkTitle = document.createElement("strong");
  networkTitle.textContent = "本机 Network 开发环境";
  const networkHint = document.createElement("small");
  networkHint.textContent = viewModel.useLocalDevelopmentNetwork
    ? "下次启动连接本机 teti-network"
    : "默认连接 network.teti.bot";
  networkCopy.append(networkTitle, networkHint);
  const networkInput = document.createElement("input");
  networkInput.type = "checkbox";
  networkInput.checked = viewModel.useLocalDevelopmentNetwork;
  networkInput.disabled = viewModel.networkEnvironmentBusy;
  networkInput.addEventListener("change", () => {
    void controller?.setLocalDevelopmentNetwork(networkInput.checked);
  });
  networkToggle.append(networkCopy, networkInput);
  const networkMeta = document.createElement("div");
  networkMeta.className = "teti-network-environment-meta";
  const networkState = document.createElement("small");
  networkState.className = `is-${viewModel.presenceTone}`;
  networkState.textContent = `${viewModel.networkEnvironmentActiveLabel} · ${viewModel.presenceLabel}`;
  const networkEndpoint = document.createElement("code");
  networkEndpoint.textContent = viewModel.networkEnvironmentEndpoint;
  networkMeta.append(networkState, networkEndpoint);
  if (viewModel.networkEnvironmentRestartRequired) {
    const restart = document.createElement("small");
    restart.className = "teti-network-environment-restart";
    restart.textContent = `设置已保存；重启后使用 ${viewModel.networkEnvironmentNextEndpoint}`;
    networkMeta.append(restart);
  }
  networkEnvironment.append(networkToggle, networkMeta);
  const label = document.createElement("label");
  label.className = "teti-toggle-row teti-settings-card teti-sharing-control";
  label.setAttribute("aria-busy", String(viewModel.busy));
  const toggleCopy = document.createElement("span");
  toggleCopy.className = "teti-toggle-copy";
  const text = document.createElement("strong");
  text.textContent = viewModel.toggleLabel;
  const hint = document.createElement("small");
  hint.textContent = "向已建联 Teti 分享当前 Passport";
  toggleCopy.append(text, hint);
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.checked = viewModel.enabled;
  toggle.addEventListener("change", () => void controller?.setResourceSharing(toggle.checked));
  label.append(toggleCopy, toggle);
  panel.append(panelHeading, overview, label);
  if (viewModel.error) {
    const error = document.createElement("small");
    error.className = "teti-sharing-error";
    error.textContent = viewModel.error;
    panel.append(error);
  }
  panel.append(createAgentManagementSection(viewModel, controller));
  if (viewModel.showOsaurusNativeConfiguration) {
    panel.append(createOsaurusNativeChildSection(viewModel, controller));
  }
  if (memoryController) panel.append(createChildMemorySection(memoryController, childAgents));
  if (viewModel.showLocalDevelopmentNetworkSwitch) {
    panel.append(networkEnvironment);
    if (viewModel.networkEnvironmentError) {
      const error = document.createElement("small");
      error.className = "teti-sharing-error";
      error.textContent = viewModel.networkEnvironmentError;
      panel.append(error);
    }
  }
  panel.append(createBuildInformation(viewModel, controller));
  return panel;
}

function createBuildInformation(
  viewModel: PassportSettingsViewModel,
  controller?: PassportController
): HTMLElement {
  const footer = document.createElement("footer");
  footer.className = "teti-build-information";
  footer.setAttribute("aria-label", "Teti 程序版本与构建信息");

  const versionLabel = document.createElement("span");
  versionLabel.textContent = "程序版本";
  const version = document.createElement("code");
  version.textContent = viewModel.appVersion;
  const logout = document.createElement("button");
  logout.type = "button";
  logout.className = "teti-local-logout";
  logout.dataset.focusKey = "settings-local-logout";
  logout.textContent = viewModel.localLogoutBusy
    ? "注销中"
    : viewModel.localLogoutConfirmationRequired
      ? "取消"
      : "注销";
  logout.disabled = viewModel.localLogoutBusy;
  logout.setAttribute(
    "aria-label",
    viewModel.localLogoutConfirmationRequired
      ? "取消注销本机 Teti Profile"
      : "注销并清理本机 Teti Profile"
  );
  logout.addEventListener("click", () => {
    if (viewModel.localLogoutConfirmationRequired) {
      controller?.cancelLocalProfileLogout();
    } else {
      controller?.requestLocalProfileLogout();
    }
  });

  const timestampLabel = document.createElement("span");
  timestampLabel.textContent = "构建时间（UTC）";
  const timestamp = document.createElement("time");
  timestamp.textContent = viewModel.buildTimestamp;
  if (Number.isFinite(Date.parse(viewModel.buildTimestamp))) {
    timestamp.dateTime = viewModel.buildTimestamp;
  }

  const networkVersionLabel = document.createElement("span");
  networkVersionLabel.textContent = "teti-network 版本";
  const networkVersion = document.createElement("code");
  networkVersion.textContent = viewModel.networkVersionLabel;
  const networkVersionSpacer = document.createElement("span");
  networkVersionSpacer.setAttribute("aria-hidden", "true");
  const timestampSpacer = document.createElement("span");
  timestampSpacer.setAttribute("aria-hidden", "true");

  footer.append(
    versionLabel,
    version,
    logout,
    networkVersionLabel,
    networkVersion,
    networkVersionSpacer,
    timestampLabel,
    timestamp,
    timestampSpacer
  );
  if (viewModel.localLogoutConfirmationRequired) {
    const confirmation = document.createElement("div");
    confirmation.className = "teti-local-logout-confirmation";
    confirmation.setAttribute("role", "group");
    confirmation.setAttribute("aria-label", "确认注销本机 Teti Profile");
    const warning = document.createElement("small");
    warning.textContent = "将清除本机 Profile、Network 凭据、建联缓存和消息数据；服务器身份暂不删除。";
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "teti-local-logout-confirm";
    confirm.textContent = "确认注销";
    confirm.addEventListener("click", () => void controller?.confirmLocalProfileLogout());
    confirmation.append(warning, confirm);
    footer.prepend(confirmation);
  }
  if (viewModel.localLogoutError) {
    const error = document.createElement("small");
    error.className = "teti-local-logout-error";
    error.setAttribute("role", "alert");
    error.textContent = viewModel.localLogoutError;
    footer.append(error);
  }
  return footer;
}

function createOsaurusNativeChildSection(
  viewModel: PassportSettingsViewModel,
  controller?: PassportController
): HTMLElement {
  const section = document.createElement("section");
  section.className = "teti-osaurus-native teti-settings-card";
  section.setAttribute("aria-label", "Osaurus Native Child Agent");
  const header = document.createElement("div");
  header.className = "teti-osaurus-native-header";
  const copy = document.createElement("span");
  const title = document.createElement("strong");
  title.textContent = "Osaurus Native Child";
  const hint = document.createElement("small");
  hint.textContent = "固定专用 Agent ID · 沿用本机 Agent 配置";
  copy.append(title, hint);
  const status = document.createElement("span");
  status.className = `teti-osaurus-native-status is-${
    viewModel.osaurusNativeStatus === "可调用"
      ? "ready"
      : viewModel.osaurusNativeStatus === "安全资格未通过"
        ? "blocked"
        : "pending"
  }`;
  status.textContent = viewModel.osaurusNativeStatus;
  if (viewModel.osaurusNativeReason) {
    status.title = viewModel.osaurusNativeReason;
    status.setAttribute("aria-label", `${viewModel.osaurusNativeStatus}：${viewModel.osaurusNativeReason}`);
  }
  header.append(copy, status);

  const form = document.createElement("form");
  form.className = "teti-osaurus-native-form";
  const input = document.createElement("input");
  input.type = "text";
  input.value = viewModel.osaurusNativeAgentId;
  input.placeholder = "Agent UUID";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.disabled = viewModel.osaurusNativeBusy;
  input.setAttribute("aria-label", "固定 Osaurus Agent UUID");
  const save = document.createElement("button");
  save.type = "submit";
  save.textContent = viewModel.osaurusNativeBusy ? "检查中" : "保存";
  const valid = () => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(input.value.trim());
  save.disabled = viewModel.osaurusNativeBusy || !valid();
  input.addEventListener("input", () => { save.disabled = viewModel.osaurusNativeBusy || !valid(); });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (valid()) void controller?.setOsaurusNativeChildAgentId(input.value.trim());
  });
  form.append(input, save);
  if (viewModel.osaurusNativeAgentId) {
    const clear = document.createElement("button");
    clear.type = "button";
    clear.textContent = "清除";
    clear.disabled = viewModel.osaurusNativeBusy;
    clear.addEventListener("click", () => void controller?.setOsaurusNativeChildAgentId(null));
    form.append(clear);
  }
  const policy = document.createElement("p");
  policy.textContent = "Teti 不修改 Tools、Osaurus Memory 与 Autonomous Exec；直接 Host Workspace 挂载仍被拒绝，且 Runtime 身份通过校验后才会进入 Passport。";
  section.append(header, form, policy);
  if (viewModel.osaurusNativeReason) {
    const reason = document.createElement("small");
    reason.className = `teti-osaurus-native-reason ${
      viewModel.osaurusNativeStatus === "可调用" ? "is-warning" : "is-error"
    }`;
    reason.textContent = viewModel.osaurusNativeReason;
    section.append(reason);
  }
  if (viewModel.osaurusNativeError) {
    const error = document.createElement("small");
    error.className = "teti-osaurus-native-error";
    error.setAttribute("role", "alert");
    error.textContent = viewModel.osaurusNativeError;
    section.append(error);
  }
  return section;
}

export function createChildMemorySection(
  controller: MemoryController,
  childAgents: readonly AgentViewModel[]
): HTMLElement {
  const snapshot = controller.snapshot;
  const section = document.createElement("section");
  section.className = "teti-child-memory";
  section.setAttribute("aria-label", "Child Agent Memory");

  const header = document.createElement("div");
  header.className = "teti-child-memory-header";
  const copy = document.createElement("span");
  const title = document.createElement("strong");
  title.textContent = "Child Memory";
  const hint = document.createElement("small");
  hint.textContent = "由 Teti 管理 · 默认关闭";
  copy.append(title, hint);
  const exportButton = document.createElement("button");
  exportButton.type = "button";
  exportButton.className = "teti-memory-action";
  exportButton.textContent = "导出";
  exportButton.disabled = snapshot.busy || snapshot.memory.records.length === 0;
  exportButton.addEventListener("click", () => void controller.export());
  header.append(copy, exportButton);
  section.append(header);

  const taskNote = document.createElement("p");
  taskNote.className = "teti-memory-note";
  taskNote.textContent = "Task Memory 只在一次执行中存在。长期 Memory 必须先授权，再从已完成任务中单独保存；对端不能触发写入。";
  section.append(taskNote);

  const agents = document.createElement("div");
  agents.className = "teti-memory-agent-list";
  for (const agent of childAgents) {
    const label = document.createElement("label");
    label.className = "teti-memory-agent-toggle";
    const agentCopy = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = agent.name;
    const description = document.createElement("small");
    description.textContent = "允许你把完成结果保存为此 Child Agent 的长期上下文";
    agentCopy.append(name, description);
    const memoryToggle = document.createElement("input");
    memoryToggle.type = "checkbox";
    memoryToggle.checked = controller.isAuthorized("child_agent", null, agent.id);
    memoryToggle.disabled = snapshot.busy;
    memoryToggle.setAttribute("aria-label", `${agent.name} Child Agent Memory`);
    memoryToggle.addEventListener("change", () => void controller.setAuthorization({
      scope: "child_agent",
      workspaceId: null,
      childAgentId: agent.id,
      enabled: memoryToggle.checked
    }));
    label.append(agentCopy, memoryToggle);
    agents.append(label);
  }
  if (childAgents.length === 0) {
    const empty = document.createElement("small");
    empty.className = "teti-memory-empty";
    empty.textContent = "检测到可用 Child Agent 后，可在这里单独授权长期 Memory。";
    agents.append(empty);
  }
  section.append(agents);

  if (snapshot.memory.records.length > 0) {
    const records = document.createElement("div");
    records.className = "teti-memory-records";
    const recordsTitle = document.createElement("strong");
    recordsTitle.textContent = `已保存记录 ${snapshot.memory.records.length}`;
    records.append(recordsTitle);
    for (const record of snapshot.memory.records) {
      const row = document.createElement("article");
      row.className = "teti-memory-record";
      const provenance = document.createElement("small");
      provenance.textContent = `${memoryScopeLabel(record.scope)} · ${record.childAgentId} · 来源任务 ${record.sourceTaskId} · Peer ${record.sourcePeerId}`;
      const preview = document.createElement("p");
      preview.textContent = record.contentPreview;
      const footer = document.createElement("div");
      const expiry = document.createElement("small");
      expiry.textContent = `到期 ${formatMemoryDate(record.expiresAt)}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "teti-memory-action is-delete";
      remove.textContent = "删除";
      remove.disabled = snapshot.busy;
      remove.addEventListener("click", () => void controller.delete(record.memoryId));
      footer.append(expiry, remove);
      row.append(provenance, preview, footer);
      records.append(row);
    }
    section.append(records);
  }
  if (snapshot.exportResult) {
    const exported = document.createElement("small");
    exported.className = "teti-memory-export-result";
    exported.textContent = `已导出 ${snapshot.exportResult.recordCount} 条：${snapshot.exportResult.path}`;
    section.append(exported);
  }
  if (snapshot.error) {
    const error = document.createElement("small");
    error.className = "teti-memory-error";
    error.setAttribute("role", "alert");
    error.textContent = snapshot.error;
    section.append(error);
  }
  return section;
}

function memoryScopeLabel(scope: string): string {
  return scope === "workspace" ? "Workspace Memory" : "Child Agent Memory";
}

function formatMemoryDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString() : "未知";
}

function createSectionTitle(label: string, count: number): HTMLElement {
  const title = document.createElement("div");
  title.className = "teti-agent-section-title";
  const text = document.createElement("span");
  text.textContent = label;
  const badge = document.createElement("span");
  badge.className = "teti-section-count";
  badge.textContent = String(count);
  title.append(text, badge);
  return title;
}

function passportSummary(resourceCount: number, agentCount: number, capabilityCount: number): string {
  const parts = [`${resourceCount} 项 AI 资源`];
  if (agentCount > 0) parts.push(`${agentCount} 个可用 Agent`);
  if (capabilityCount > 0) parts.push(`${capabilityCount} 项能力`);
  return parts.join(" · ");
}

function createAgentManagementSection(
  viewModel: PassportSettingsViewModel,
  controller?: PassportController
): HTMLElement {
  const management = viewModel.agentManagement;
  const section = document.createElement("section");
  section.className = "teti-agent-management";

  const header = document.createElement("div");
  header.className = "teti-agent-management-header";
  const copy = document.createElement("span");
  const title = document.createElement("strong");
  title.textContent = "Agent 管理";
  const status = document.createElement("small");
  status.textContent = management.statusLabel;
  copy.append(title, status);
  const rescan = document.createElement("button");
  rescan.className = "teti-agent-rescan";
  rescan.type = "button";
  rescan.textContent = management.scanning ? "扫描中" : "重新扫描";
  rescan.disabled = management.scanning;
  rescan.addEventListener("click", () => void controller?.rescanAgents());
  header.append(copy, rescan);
  section.append(header);

  if (!management.readyToDisplay) {
    const pending = document.createElement("div");
    pending.className = "teti-agent-discovery-pending";
    pending.setAttribute("role", "status");
    pending.textContent = "完成首次安全扫描后显示 Agent 列表。";
    section.append(pending);
  } else {
    const list = document.createElement("div");
    list.className = "teti-agent-management-list";
    for (const agent of management.agents) list.append(createManagedAgentRow(agent, controller));
    if (management.agents.length === 0) {
      const empty = document.createElement("small");
      empty.textContent = "当前未检测到已安装的 Agent。";
      list.append(empty);
    }
    section.append(list);
  }

  if (management.error) {
    const error = document.createElement("small");
    error.className = "teti-agent-management-error";
    error.textContent = management.error;
    section.append(error);
  }
  const privacy = document.createElement("small");
  privacy.className = "teti-agent-management-privacy";
  privacy.textContent = "仅检查安装、版本和运行状态；路径只保存在本机。";
  section.append(privacy);
  return section;
}

function createManagedAgentRow(
  agent: ManagedAgentViewModel,
  controller?: PassportController
): HTMLElement {
  const item = document.createElement("div");
  item.className = "teti-managed-agent";
  item.append(createAgentRow(agent));
  if (!agent.canOverride) return item;

  const details = document.createElement("details");
  details.className = "teti-agent-path-details";
  const summary = document.createElement("summary");
  summary.textContent = agent.pathOverride ? "自定义路径已启用" : "路径 override";
  const form = document.createElement("form");
  form.className = "teti-agent-path-form";
  const input = document.createElement("input");
  input.className = "teti-agent-path-input";
  input.type = "text";
  input.value = agent.pathOverride;
  input.placeholder = agent.pathPlaceholder;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.disabled = agent.busy;
  input.setAttribute("aria-label", `${agent.name} 自定义安装路径`);
  const save = document.createElement("button");
  save.type = "submit";
  save.textContent = agent.busy ? "保存中" : "保存";
  save.disabled = agent.busy;
  const clear = document.createElement("button");
  clear.type = "button";
  clear.textContent = "清除";
  clear.disabled = agent.busy || !agent.pathOverride;
  clear.addEventListener("click", () => void controller?.setAgentPathOverride(agent.id, ""));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void controller?.setAgentPathOverride(agent.id, input.value);
  });
  form.append(input, save, clear);
  details.append(summary, form);
  item.append(details);
  return item;
}

export function createRemotePassport(viewModel: RemotePassportViewModel): HTMLElement {
  const container = document.createElement("div");
  container.className = "teti-peer-ai-status";
  if (viewModel.note) return passportNote(container, viewModel.note, viewModel.stale);
  const agents = document.createElement("div");
  agents.className = "teti-peer-agent-summary";
  for (const [index, agent] of viewModel.summary.agents.entries()) {
    if (index > 0) agents.append(document.createTextNode(" · "));
    agents.append(createRemoteAgentSummary(agent));
  }
  if (viewModel.summary.agentOverflowCount > 0) {
    agents.append(createSummaryOverflow(viewModel.summary.agentOverflowCount, "Agent"));
  }

  const signals = document.createElement("div");
  signals.className = "teti-peer-signal-summary";
  if (viewModel.summary.resource) {
    signals.append(createRemoteResourceSignal(
      viewModel.summary.resource,
      viewModel.summary.resourceOverflowCount
    ));
  }
  const capabilities = document.createElement("div");
  capabilities.className = "teti-peer-capability-summary";
  for (const capability of viewModel.summary.capabilities) {
    capabilities.append(createRemoteCapabilityChip(capability));
  }
  if (viewModel.summary.capabilityOverflowCount > 0) {
    capabilities.append(createSummaryOverflow(
      viewModel.summary.capabilityOverflowCount,
      "Capability"
    ));
  }
  signals.append(capabilities);
  container.append(agents, signals);
  return container;
}

export function createRemotePassportDetails(viewModel: RemotePassportViewModel): HTMLElement {
  const details = document.createElement("div");
  details.className = "teti-peer-details-sections";
  details.setAttribute("aria-label", "AI Passport 完整详情");
  if (viewModel.note) return passportNote(details, viewModel.note, viewModel.stale);

  details.append(
    createRemoteDetailSection(
      "Resource",
      viewModel.resources.length,
      viewModel.resources.map(createRemoteResourceDetail)
    ),
    createRemoteDetailSection(
      "Agent",
      viewModel.agents.length,
      viewModel.agents.map(createRemoteAgentDetail)
    ),
    createRemoteDetailSection(
      "Provider",
      viewModel.providers.length,
      viewModel.providers.map(createRemoteProviderDetail)
    ),
    createRemoteDetailSection(
      "Capability",
      viewModel.capabilities.length,
      viewModel.capabilities.map(createRemoteCapabilityDetail)
    )
  );
  return details;
}

function createRemoteDetailSection(
  label: string,
  count: number,
  items: HTMLElement[]
): HTMLElement {
  const section = document.createElement("section");
  section.className = `teti-peer-detail-section is-${label.toLowerCase()}`;
  section.setAttribute("aria-label", `${label}，${count} 项`);
  const heading = document.createElement("div");
  heading.className = "teti-peer-detail-section-heading";
  const title = document.createElement("h3");
  title.textContent = label;
  const badge = document.createElement("span");
  badge.className = "teti-section-count";
  badge.textContent = String(count);
  badge.setAttribute("aria-label", `${count} 项`);
  heading.append(title, badge);
  section.append(heading);
  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "teti-peer-detail-empty";
    empty.textContent = "未分享此类信息";
    section.append(empty);
  } else {
    section.append(...items);
  }
  return section;
}

function createRemoteResourceDetail(resource: ResourceViewModel): HTMLElement {
  const item = document.createElement("article");
  item.className = `teti-peer-detail-item teti-peer-resource-detail${resource.stale ? " is-stale" : ""}`;
  const header = document.createElement("div");
  header.className = "teti-peer-detail-item-header";
  header.append(createResourceMark(resource));
  const identity = document.createElement("span");
  identity.className = "teti-peer-detail-item-identity";
  const name = document.createElement("strong");
  name.textContent = resource.productName;
  const provider = document.createElement("small");
  provider.textContent = resource.providerName;
  identity.append(name, provider);
  const status = detailStatus(resource.availabilityLabel, resource.stale);
  header.append(identity, status);
  const meta = detailMeta([
    resource.kindLabel,
    resource.planLabel,
    resource.assuranceLabel
  ]);
  const quotas = document.createElement("div");
  quotas.className = "teti-peer-detail-quotas";
  if (resource.quotas.length === 0) {
    const empty = document.createElement("span");
    empty.className = "teti-peer-detail-muted";
    empty.textContent = "未提供 Quota";
    quotas.append(empty);
  } else {
    for (const quota of resource.quotas) {
      const row = document.createElement("div");
      row.className = "teti-peer-detail-quota";
      const copy = document.createElement("span");
      copy.textContent = `${quota.periodLabel} · ${quota.windowLabel} · ${quota.resetLabel}`;
      const value = document.createElement("strong");
      value.textContent = `${quota.inferred ? "约 " : ""}${Math.round(quota.remainingPercent)}%`;
      row.append(
        copy,
        value,
        progressTrack(quota.remainingPercent, false, `${resource.productName} ${quota.periodLabel}剩余额度`)
      );
      quotas.append(row);
    }
  }
  item.append(header, meta, quotas);
  return item;
}

function createRemoteAgentDetail(agent: AgentViewModel): HTMLElement {
  const item = document.createElement("article");
  item.className = `teti-peer-detail-item teti-peer-agent-detail is-${agent.tone}`;
  const header = document.createElement("div");
  header.className = "teti-peer-detail-item-header";
  header.append(createProviderMark({
    id: agent.providerName.toLowerCase(),
    name: agent.providerName,
    logo: agent.providerName.toLowerCase() === "openai" ? "openai" : "generic",
    fallbackLabel: providerInitials(agent.providerName),
    resourceNames: [],
    agentNames: []
  }));
  const identity = document.createElement("span");
  identity.className = "teti-peer-detail-item-identity";
  const name = document.createElement("strong");
  name.textContent = agent.name;
  const provider = document.createElement("small");
  provider.textContent = agent.providerName || "Provider 未标注";
  identity.append(name, provider);
  header.append(identity, detailStatus(agent.statusLabel, agent.tone === "unknown"));
  const modes = [
    agent.versionLabel,
    agent.inputModeLabels.length > 0 ? `输入：${agent.inputModeLabels.join("、")}` : "",
    agent.outputModeLabels.length > 0 ? `输出：${agent.outputModeLabels.join("、")}` : ""
  ];
  item.append(header, detailMeta(modes));
  return item;
}

function createRemoteProviderDetail(provider: ProviderViewModel): HTMLElement {
  const item = document.createElement("article");
  item.className = "teti-peer-detail-item teti-peer-provider-detail";
  const header = document.createElement("div");
  header.className = "teti-peer-detail-item-header";
  header.append(createProviderMark(provider));
  const identity = document.createElement("span");
  identity.className = "teti-peer-detail-item-identity";
  const name = document.createElement("strong");
  name.textContent = provider.name;
  const summary = document.createElement("small");
  summary.textContent = `${provider.resourceNames.length} Resource · ${provider.agentNames.length} Agent`;
  identity.append(name, summary);
  header.append(identity);
  const associations = [
    provider.resourceNames.length > 0 ? `Resource：${provider.resourceNames.join("、")}` : "",
    provider.agentNames.length > 0 ? `Agent：${provider.agentNames.join("、")}` : ""
  ];
  item.append(header, detailMeta(associations));
  return item;
}

function createRemoteCapabilityDetail(capability: CapabilityViewModel): HTMLElement {
  const item = document.createElement("article");
  item.className = `teti-peer-detail-item teti-peer-capability-detail${capability.stale ? " is-stale" : ""}`;
  const header = document.createElement("div");
  header.className = "teti-peer-detail-item-header";
  const identity = document.createElement("span");
  identity.className = "teti-peer-detail-item-identity";
  const name = document.createElement("strong");
  name.textContent = capability.name;
  const category = document.createElement("small");
  category.textContent = capability.categoryLabel;
  identity.append(name, category);
  header.append(identity, detailStatus(capability.availabilityLabel, capability.stale));
  item.append(header);
  if (capability.description) {
    const description = document.createElement("p");
    description.className = "teti-peer-detail-description";
    description.textContent = capability.description;
    item.append(description);
  }
  if (capability.computeOffer) {
    item.append(detailMeta([
      capability.computeOffer.resourceLabel,
      capability.computeOffer.executionLabel,
      capability.computeOffer.concurrencyLabel,
      capability.computeOffer.approvalLabel
    ]));
  }
  const bindings = document.createElement("div");
  bindings.className = "teti-peer-detail-bindings";
  if (capability.bindings.length === 0) {
    const empty = document.createElement("span");
    empty.className = "teti-peer-detail-muted";
    empty.textContent = "未提供绑定";
    bindings.append(empty);
  } else {
    for (const binding of capability.bindings) {
      const row = document.createElement("div");
      row.className = "teti-peer-detail-binding";
      const status = document.createElement("strong");
      status.textContent = binding.statusLabel;
      const copy = document.createElement("span");
      const parts = [
        binding.agentNames.length > 0 ? `Agent：${binding.agentNames.join("、")}` : "",
        binding.resourceNames.length > 0 ? `Resource：${binding.resourceNames.join("、")}` : ""
      ].filter(Boolean);
      copy.textContent = parts.join(" · ") || "空绑定";
      row.append(status, copy);
      bindings.append(row);
    }
  }
  item.append(bindings);
  return item;
}

function detailMeta(values: string[]): HTMLElement {
  const meta = document.createElement("div");
  meta.className = "teti-peer-detail-meta";
  for (const value of values.filter(Boolean)) {
    const item = document.createElement("span");
    item.textContent = value;
    meta.append(item);
  }
  return meta;
}

function detailStatus(label: string, muted: boolean): HTMLElement {
  const status = document.createElement("span");
  status.className = `teti-peer-detail-status${muted ? " is-muted" : ""}`;
  const dot = document.createElement("span");
  dot.className = "teti-peer-detail-status-dot";
  dot.setAttribute("aria-hidden", "true");
  status.append(dot, document.createTextNode(label));
  return status;
}

function createProviderMark(provider: ProviderViewModel): HTMLElement {
  const mark = document.createElement("span");
  mark.className = `teti-provider-mark is-${provider.logo}`;
  mark.setAttribute("aria-hidden", "true");
  const fallback = document.createElement("span");
  fallback.className = "teti-provider-mark-fallback";
  fallback.textContent = provider.fallbackLabel;
  if (provider.logo === "openai") {
    const image = document.createElement("img");
    image.src = codexIconUrl;
    image.alt = "";
    fallback.hidden = true;
    image.addEventListener("error", () => {
      image.hidden = true;
      fallback.hidden = false;
    }, { once: true });
    mark.append(image, fallback);
  } else {
    mark.append(fallback);
  }
  return mark;
}

function providerInitials(name: string): string {
  const initials = name.trim().split(/\s+/).slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "").join("");
  return initials || "AI";
}

function createRemoteResourceSignal(
  resource: ResourceViewModel,
  overflowCount: number
): HTMLElement {
  const row = document.createElement("div");
  row.className = `teti-peer-resource-signal${resource.stale ? " is-stale" : ""}`;
  row.append(createResourceMark(resource));
  const label = document.createElement("span");
  label.className = "teti-peer-resource-label";
  label.textContent = resource.productName;
  const quota = document.createElement("span");
  quota.className = "teti-peer-resource-quota";
  quota.textContent = resource.remainingPercent === null
    ? ""
    : `${resource.inferred ? "≈" : ""}${Math.round(resource.remainingPercent)}%`;
  row.append(label);
  if (resource.remainingPercent !== null) {
    row.append(progressTrack(resource.remainingPercent, true), quota);
  }
  if (overflowCount > 0) row.append(createSummaryOverflow(overflowCount, "Resource"));
  row.title = [
    `${resource.productName} ${resource.planLabel}`,
    resource.availabilityLabel,
    resource.resetLabel
  ].join(" · ");
  return row;
}

function createRemoteAgentSummary(agent: AgentViewModel): HTMLElement {
  const name = document.createElement("span");
  name.className = `teti-peer-agent-name is-${agent.tone}`;
  name.dataset.agentId = agent.id;
  name.textContent = agent.name;
  name.title = `${agent.name} · ${agent.statusLabel}`;
  return name;
}

function createRemoteCapabilityChip(capability: CapabilityViewModel): HTMLElement {
  const chip = document.createElement("span");
  chip.className = `teti-peer-capability-chip${capability.stale ? " is-stale" : ""}`;
  chip.dataset.capabilityId = capability.id;
  chip.textContent = capability.computeOffer
    ? `${capability.name} · 本地算力`
    : capability.name;
  chip.title = `${capability.categoryLabel} · ${capability.availabilityLabel}`;
  return chip;
}

function createSummaryOverflow(count: number, entity: string): HTMLElement {
  const overflow = document.createElement("span");
  overflow.className = "teti-peer-summary-overflow";
  overflow.textContent = `+${count}`;
  overflow.title = `另有 ${count} 个 ${entity}`;
  overflow.setAttribute("aria-label", overflow.title);
  return overflow;
}

function createCapabilityChip(capability: CapabilityViewModel): HTMLElement {
  const chip = document.createElement("span");
  chip.className = `teti-capability-chip${capability.stale ? " is-stale" : ""}`;
  chip.dataset.capabilityId = capability.id;
  chip.textContent = capability.name;
  chip.title = `${capability.categoryLabel} · ${capability.availabilityLabel}`;
  return chip;
}

function createResourceRow(resource: ResourceViewModel): HTMLElement {
  const row = document.createElement("div");
  row.className = "teti-ai-tool-row";
  const identity = document.createElement("div");
  identity.className = "teti-ai-tool-identity";
  identity.append(createResourceMark(resource));
  const name = document.createElement("span");
  name.textContent = resource.productName;
  const plan = document.createElement("span");
  plan.className = `teti-ai-plan is-${resource.tone}`;
  plan.textContent = resource.planLabel;
  identity.append(name, plan);

  const quota = document.createElement("div");
  quota.className = "teti-ai-quota";
  const quotaLabel = document.createElement("span");
  quotaLabel.textContent = resource.resetLabel;
  const quotaValue = document.createElement("strong");
  quotaValue.textContent = resource.remainingPercent === null
    ? "--"
    : `${resource.inferred ? "约 " : ""}${Math.round(resource.remainingPercent)}%`;
  quota.append(quotaLabel, quotaValue, progressTrack(resource.remainingPercent));

  const detail = document.createElement("small");
  const details = [resource.inferred ? "按最长窗口推定" : "", resource.stale ? "数据可能已过期" : ""]
    .filter(Boolean);
  detail.textContent = details.join(" · ");
  detail.hidden = details.length === 0;
  row.append(identity, quota, detail);
  return row;
}

function createAgentRow(agent: AgentViewModel): HTMLElement {
  const row = document.createElement("div");
  row.className = `teti-agent-row is-${agent.tone}`;
  row.dataset.agentId = agent.id;

  const mark = document.createElement("span");
  mark.className = "teti-agent-mark";
  mark.setAttribute("aria-hidden", "true");

  const identity = document.createElement("span");
  identity.className = "teti-agent-identity";
  const name = document.createElement("strong");
  name.textContent = agent.name;
  identity.append(name);
  if (agent.detailLabel) {
    const detail = document.createElement("small");
    detail.textContent = agent.detailLabel;
    identity.append(detail);
  }

  const status = document.createElement("span");
  status.className = "teti-agent-status";
  status.textContent = agent.statusLabel;
  row.append(mark, identity, status);
  return row;
}

function createResourceMark(resource: Pick<ResourceViewModel, "icon" | "tone" | "stale">): HTMLElement {
  if (resource.icon === "generic") {
    const mark = document.createElement("span");
    mark.className = "teti-generic-tool-mark";
    mark.textContent = "AI";
    mark.setAttribute("aria-hidden", "true");
    return mark;
  }
  return createImageMark(resource.tone, resource.stale);
}

function createImageMark(tone: ResourceTone, stale: boolean): HTMLElement {
  const mark = document.createElement("span");
  mark.className = `teti-codex-mark is-${tone}${stale ? " is-stale" : ""}`;
  const image = document.createElement("img");
  image.src = codexIconUrl;
  image.alt = "";
  image.setAttribute("aria-hidden", "true");
  const fallback = document.createElement("span");
  fallback.className = "teti-codex-mark-fallback";
  fallback.textContent = "AI";
  fallback.hidden = true;
  image.addEventListener("error", () => {
    image.hidden = true;
    fallback.hidden = false;
  }, { once: true });
  mark.append(image, fallback);
  if (stale) {
    const badge = document.createElement("span");
    badge.className = "teti-codex-stale-dot";
    badge.setAttribute("aria-hidden", "true");
    mark.append(badge);
  }
  return mark;
}

function progressTrack(percent: number | null, compact = false, label = "剩余额度"): HTMLElement {
  const track = document.createElement("span");
  track.className = `teti-ai-progress${compact ? " is-compact" : ""}`;
  track.setAttribute("role", "progressbar");
  track.setAttribute("aria-label", label);
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", "100");
  if (percent !== null) track.setAttribute("aria-valuenow", String(Math.round(percent)));
  const value = document.createElement("span");
  value.style.width = `${percent === null ? 0 : Math.max(0, Math.min(100, percent))}%`;
  track.append(value);
  return track;
}

function passportNote(container: HTMLElement, text: string, stale = false): HTMLElement {
  container.classList.toggle("is-stale", stale);
  const note = document.createElement("span");
  note.className = "teti-peer-ai-note";
  note.textContent = text;
  container.append(note);
  return container;
}
