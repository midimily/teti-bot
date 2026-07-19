import type { RemoteAiStatusSnapshot, AiToolStatusSnapshot } from "../../../../core/ai-status/types.ts";
import { presentCodexUsage, type CodexPlanTone } from "../codex-usage/presentation.ts";
import type { AiStatusController, AiStatusControllerSnapshot } from "./controller.ts";

const codexIconUrl = new URL("../../assets/codex-status.png", import.meta.url).href;

export function createCodexStatusPanel(
  snapshot: AiStatusControllerSnapshot
): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "teti-header-panel teti-ai-status-panel";
  panel.hidden = snapshot.openPanel !== "status";
  const presentation = presentCodexUsage(snapshot.usage);

  const heading = document.createElement("strong");
  heading.textContent = "AI 工具状态";
  const tool = document.createElement("div");
  tool.className = "teti-ai-tool-row";
  const identity = document.createElement("div");
  identity.className = "teti-ai-tool-identity";
  identity.append(createCodexMark(presentation.tone, presentation.stale));
  const name = document.createElement("span");
  name.textContent = "Codex";
  const plan = document.createElement("span");
  plan.className = `teti-ai-plan is-${presentation.tone}`;
  plan.textContent = presentation.planLabel;
  identity.append(name, plan);

  const quota = document.createElement("div");
  quota.className = "teti-ai-quota";
  const quotaLabel = document.createElement("span");
  quotaLabel.textContent = formatResetAt(presentation.resetAt);
  const quotaValue = document.createElement("strong");
  quotaValue.textContent = presentation.remainingPercent === null
    ? "--"
    : `${presentation.inferred ? "约 " : ""}${Math.round(presentation.remainingPercent)}%`;
  const track = progressTrack(presentation.remainingPercent);
  quota.append(quotaLabel, quotaValue, track);

  const detail = document.createElement("small");
  detail.textContent = statusDetail(presentation.stale, presentation.inferred);
  detail.hidden = !detail.textContent;
  tool.append(identity, quota, detail);
  panel.append(heading, tool);
  return panel;
}

export function createSharingPanel(
  snapshot: AiStatusControllerSnapshot,
  controller?: AiStatusController
): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "teti-header-panel teti-sharing-panel";
  panel.hidden = snapshot.openPanel !== "sharing";
  const title = document.createElement("strong");
  title.textContent = "设置";
  const label = document.createElement("label");
  label.className = "teti-toggle-row";
  label.setAttribute("aria-busy", String(snapshot.sharingBusy));
  const text = document.createElement("span");
  text.textContent = "状态共享";
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.checked = snapshot.statusSharing;
  toggle.addEventListener("change", () => void controller?.setStatusSharing(toggle.checked));
  label.append(text, toggle);
  panel.append(title, label);
  if (snapshot.sharingError) {
    const error = document.createElement("small");
    error.className = "teti-sharing-error";
    error.textContent = snapshot.sharingError;
    panel.append(error);
  }
  return panel;
}

export function createCodexMark(tone: CodexPlanTone, stale = false): HTMLElement {
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

export function createRemoteAiStatus(snapshot?: RemoteAiStatusSnapshot): HTMLElement {
  const container = document.createElement("div");
  container.className = "teti-peer-ai-status";
  if (!snapshot) return peerStatusNote(container, "暂无 AI 状态");
  if (snapshot.sharing === "disabled") return peerStatusNote(container, "未共享 AI 状态");
  if (Date.now() >= Date.parse(snapshot.expiresAt)) return peerStatusNote(container, "AI 状态已过期", true);

  for (const tool of snapshot.tools.slice(0, 2)) {
    container.append(createRemoteTool(tool));
  }
  if (snapshot.tools.length === 0) peerStatusNote(container, "暂无 AI 状态");
  if (snapshot.tools.length > 2) {
    const more = document.createElement("span");
    more.className = "teti-peer-ai-more";
    more.textContent = `+${snapshot.tools.length - 2}`;
    container.append(more);
  }
  return container;
}

function createRemoteTool(tool: AiToolStatusSnapshot): HTMLElement {
  const row = document.createElement("div");
  row.className = "teti-peer-ai-tool";
  const knownCodex = tool.toolId === "openai.codex";
  const tone = knownCodex ? toneForPlan(tool.plan.key, tool.status) : "unknown";
  row.append(knownCodex ? createCodexMark(tone, tool.status === "stale") : genericToolMark());
  const text = document.createElement("span");
  const quota = tool.quotas.find((candidate) => candidate.period === "week");
  text.textContent = `${knownCodex ? "Codex" : "AI 工具"} ${planLabel(tool.plan.key, tool.status)}${quota ? ` ${Math.round(quota.remainingPercent)}%` : ""}`;
  row.append(text);
  if (quota) row.append(progressTrack(quota.remainingPercent, true));
  return row;
}

function genericToolMark(): HTMLElement {
  const mark = document.createElement("span");
  mark.className = "teti-generic-tool-mark";
  mark.textContent = "AI";
  mark.setAttribute("aria-hidden", "true");
  return mark;
}

function peerStatusNote(container: HTMLElement, text: string, stale = false): HTMLElement {
  container.classList.toggle("is-stale", stale);
  const note = document.createElement("span");
  note.className = "teti-peer-ai-note";
  note.textContent = text;
  container.append(note);
  return container;
}

function toneForPlan(key: string | null, status: AiToolStatusSnapshot["status"]): CodexPlanTone {
  if (status === "unavailable") return "unavailable";
  return key === "free" || key === "plus" || key === "pro" ? key : "unknown";
}

function planLabel(key: string | null, status: AiToolStatusSnapshot["status"]): string {
  if (status === "unavailable") return "不可用";
  if (key === "free") return "Free";
  if (key === "plus") return "Plus";
  if (key === "pro") return "Pro";
  return "计划未知";
}

function progressTrack(percent: number | null, compact = false): HTMLElement {
  const track = document.createElement("span");
  track.className = `teti-ai-progress${compact ? " is-compact" : ""}`;
  const value = document.createElement("span");
  value.style.width = `${percent === null ? 0 : Math.max(0, Math.min(100, percent))}%`;
  track.append(value);
  return track;
}

export function formatResetAt(resetAt: string | null): string {
  if (!resetAt) return "重置时间暂不可用";
  const date = new Date(resetAt);
  if (Number.isNaN(date.getTime())) return "重置时间暂不可用";
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  return `${date.getMonth() + 1}/${date.getDate()} ${hours}:${minutes} 重置`;
}

function statusDetail(stale: boolean, inferred: boolean): string {
  const parts: string[] = [];
  if (inferred) parts.push("按最长窗口推定");
  if (stale) parts.push("数据可能已过期");
  return parts.join(" · ");
}
