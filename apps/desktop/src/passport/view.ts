import type { PassportController } from "./controller.ts";
import type {
  AgentViewModel,
  AiPassportPanelViewModel,
  CapabilityViewModel,
  ManagedAgentViewModel,
  PassportSettingsViewModel,
  RemotePassportViewModel,
  ResourceTone,
  ResourceViewModel
} from "./view-model.ts";

const codexIconUrl = new URL("../../assets/codex-status.png", import.meta.url).href;

export function createAiPassportPanel(viewModel: AiPassportPanelViewModel): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "teti-header-panel teti-ai-status-panel";
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
  controller?: PassportController
): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "teti-header-panel teti-sharing-panel";
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
  const registry = document.createElement("div");
  registry.className = "teti-settings-identity-row";
  const registryKey = document.createElement("span");
  registryKey.className = "teti-settings-label";
  registryKey.textContent = "公开状态";
  const registryValue = document.createElement("span");
  registryValue.className = `teti-settings-identity-value is-${viewModel.registryTone}`;
  registryValue.textContent = viewModel.registryLabel;
  registry.append(registryKey, registryValue);
  overview.append(identity, registry);
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
  return panel;
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
      empty.textContent = "当前没有启用的 Agent 定义。";
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
  for (const resource of viewModel.resources) container.append(createRemoteResource(resource));
  for (const agent of viewModel.agents) container.append(createRemoteAgent(agent));
  if (viewModel.capabilities.length > 0) {
    const capabilities = document.createElement("div");
    capabilities.className = "teti-peer-capabilities";
    for (const capability of viewModel.capabilities) {
      capabilities.append(createCapabilityChip(capability));
    }
    container.append(capabilities);
  }
  return container;
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

function createRemoteResource(resource: ResourceViewModel): HTMLElement {
  const row = document.createElement("div");
  row.className = "teti-peer-ai-tool";
  row.append(createResourceMark(resource));
  const text = document.createElement("span");
  text.textContent = `${resource.productName} ${resource.planLabel}${
    resource.remainingPercent === null ? "" : ` ${Math.round(resource.remainingPercent)}%`
  }`;
  row.append(text);
  if (resource.remainingPercent !== null) row.append(progressTrack(resource.remainingPercent, true));
  return row;
}

function createRemoteAgent(agent: AgentViewModel): HTMLElement {
  const row = document.createElement("div");
  row.className = `teti-peer-agent is-${agent.tone}`;
  const mark = document.createElement("span");
  mark.className = "teti-peer-agent-mark";
  mark.setAttribute("aria-hidden", "true");
  const text = document.createElement("span");
  text.className = "teti-peer-agent-copy";
  text.textContent = [agent.name, agent.detailLabel].filter(Boolean).join(" · ");
  const status = document.createElement("span");
  status.className = "teti-peer-agent-status";
  status.textContent = agent.statusLabel;
  row.append(mark, text, status);
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
  mark.append(image);
  if (stale) {
    const badge = document.createElement("span");
    badge.className = "teti-codex-stale-dot";
    badge.setAttribute("aria-hidden", "true");
    mark.append(badge);
  }
  return mark;
}

function progressTrack(percent: number | null, compact = false): HTMLElement {
  const track = document.createElement("span");
  track.className = `teti-ai-progress${compact ? " is-compact" : ""}`;
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
