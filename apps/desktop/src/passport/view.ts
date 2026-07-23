import type { PassportController } from "./controller.ts";
import type {
  AiPassportPanelViewModel,
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
  const heading = document.createElement("strong");
  heading.textContent = viewModel.title;
  panel.append(heading);
  for (const resource of viewModel.resources) panel.append(createResourceRow(resource));
  return panel;
}

export function createPassportSettingsPanel(
  viewModel: PassportSettingsViewModel,
  controller?: PassportController
): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "teti-header-panel teti-sharing-panel";
  panel.hidden = !viewModel.open;
  const title = document.createElement("strong");
  title.textContent = viewModel.title;
  const identity = document.createElement("div");
  identity.className = "teti-settings-identity-row";
  const identityKey = document.createElement("span");
  identityKey.textContent = "我的 Teti";
  const identityValue = document.createElement("span");
  identityValue.className = "teti-settings-identity-value";
  identityValue.textContent = viewModel.identityLabel;
  identityValue.title = viewModel.identityLabel;
  identity.append(identityKey, identityValue);
  const registry = document.createElement("div");
  registry.className = "teti-settings-identity-row";
  const registryKey = document.createElement("span");
  registryKey.textContent = "公开状态";
  const registryValue = document.createElement("span");
  registryValue.className = `teti-settings-identity-value is-${viewModel.registryTone}`;
  registryValue.textContent = viewModel.registryLabel;
  registry.append(registryKey, registryValue);
  const label = document.createElement("label");
  label.className = "teti-toggle-row";
  label.setAttribute("aria-busy", String(viewModel.busy));
  const text = document.createElement("span");
  text.textContent = viewModel.toggleLabel;
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.checked = viewModel.enabled;
  toggle.addEventListener("change", () => void controller?.setResourceSharing(toggle.checked));
  label.append(text, toggle);
  panel.append(title, identity, registry, label);
  if (viewModel.error) {
    const error = document.createElement("small");
    error.className = "teti-sharing-error";
    error.textContent = viewModel.error;
    panel.append(error);
  }
  return panel;
}

export function createRemotePassport(viewModel: RemotePassportViewModel): HTMLElement {
  const container = document.createElement("div");
  container.className = "teti-peer-ai-status";
  if (viewModel.note) return passportNote(container, viewModel.note, viewModel.stale);
  for (const resource of viewModel.resources) container.append(createRemoteResource(resource));
  return container;
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
