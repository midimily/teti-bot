import { convertFileSrc } from "@tauri-apps/api/core";
import { ArrowLeft, Download, ExternalLink, FolderOpen, ImagePlus, Plus, X, createElement } from "lucide";
import { taskArtifactImages, taskInputImages, taskInputText } from "../../../../core/task/types.ts";
import type { PassportConnectionSnapshot } from "../../../../core/passport/snapshot.ts";
import type {
  CallablePassportAgent,
  TetiCapability,
  TetiCapabilityPassport
} from "../../../../core/passport/types.ts";
import type { TaskController, TaskControllerSnapshot } from "./controller.ts";

export function createTaskWorkspace(
  controller: TaskController,
  connections: readonly PassportConnectionSnapshot[],
  localPassport?: TetiCapabilityPassport
): HTMLElement {
  const snapshot = controller.snapshot;
  const island = document.createElement("section");
  island.className = "teti-island teti-island--expanded teti-task-workspace";
  island.setAttribute("aria-label", "Teti 协作任务");
  if (snapshot.screen === "compose") {
    island.dataset.taskComposeKey = taskComposeRenderKey(snapshot);
  }
  island.append(createTaskHeader(controller, snapshot));
  const body = document.createElement("main");
  body.className = "teti-task-body";
  if (snapshot.screen === "compose") body.append(createComposer(controller, snapshot, connections));
  else if (snapshot.screen === "detail" && snapshot.selectedTask) {
    body.append(createTaskDetail(controller, snapshot, connections, localPassport));
  }
  else body.append(createInbox(controller, snapshot, connections));
  island.append(body);
  return island;
}

function createTaskHeader(controller: TaskController, snapshot: TaskControllerSnapshot): HTMLElement {
  const header = document.createElement("header");
  header.className = "teti-task-header";
  const back = iconButton(ArrowLeft, snapshot.screen === "inbox" ? "返回留海屏" : "返回任务列表", () => controller.back());
  const title = document.createElement("div");
  title.className = "teti-task-title";
  const heading = document.createElement("strong");
  heading.textContent = snapshot.screen === "compose" ? "发起协作" : snapshot.screen === "detail" ? "任务详情" : "协作任务";
  const count = document.createElement("span");
  count.textContent = snapshot.summary.pendingIncomingCount > 0
    ? `${snapshot.summary.pendingIncomingCount} 个待确认`
    : "Task · A2A 语义";
  title.append(heading, count);
  const compose = iconButton(Plus, "发起新任务", () => controller.openCompose());
  compose.disabled = snapshot.busy;
  header.append(back, title, compose);
  return header;
}

function createInbox(
  controller: TaskController,
  snapshot: TaskControllerSnapshot,
  connections: readonly PassportConnectionSnapshot[]
): HTMLElement {
  const content = document.createElement("div");
  content.className = "teti-task-scroll teti-task-inbox";
  if (snapshot.summary.tasks.length === 0) {
    const empty = document.createElement("div");
    empty.className = "teti-task-empty";
    const title = document.createElement("strong");
    title.textContent = "还没有协作任务";
    const note = document.createElement("p");
    note.textContent = "从已建联 Teti 的 Passport 选择能力，发送文字或图片任务。";
    const action = document.createElement("button");
    action.type = "button";
    action.className = "teti-task-primary";
    action.textContent = "发起任务";
    action.addEventListener("click", () => controller.openCompose());
    empty.append(title, note, action);
    content.append(empty);
    return content;
  }
  const list = document.createElement("div");
  list.className = "teti-task-list";
  for (const task of snapshot.summary.tasks) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `teti-task-row is-${task.state}${task.direction === "incoming" && task.approval === "pending" ? " is-awaiting-decision" : ""}`;
    const copy = document.createElement("span");
    copy.className = "teti-task-row-copy";
    const peer = document.createElement("strong");
    peer.textContent = taskPeerHeading(
      task.direction,
      task.peerTetiId,
      task.createdAt,
      connections
    );
    const preview = document.createElement("small");
    preview.textContent = task.textPreview;
    copy.append(peer, preview);
    const meta = document.createElement("span");
    meta.className = "teti-task-row-meta";
    meta.textContent = `${task.imageCount
      ? `${task.receivedImageCount}/${task.imageCount} 图 · `
      : ""}${taskStatusLabel(task)}`;
    row.append(copy, meta);
    row.addEventListener("click", () => void controller.select(task.taskId));
    list.append(row);
  }
  content.append(list);
  if (snapshot.error) content.append(errorText(snapshot.error));
  return content;
}

function createComposer(
  controller: TaskController,
  snapshot: TaskControllerSnapshot,
  connections: readonly PassportConnectionSnapshot[]
): HTMLElement {
  const form = document.createElement("form");
  form.className = "teti-task-scroll teti-task-composer";
  const peers = connections.filter((connection) =>
    connection.connectionState === "Confirmed"
    && connection.compatibility === "compatible"
    && availableCapabilities(connection).length > 0
  );
  const selectedPeer = peers.find((peer) => peer.requestId === snapshot.draft.connectionRequestId) ?? peers[0];
  const capabilities = selectedPeer ? availableCapabilities(selectedPeer) : [];
  const selectedCapability = capabilities.find((capability) => capability.id === snapshot.draft.capabilityId)
    ?? capabilities[0];
  if (selectedPeer && snapshot.draft.connectionRequestId !== selectedPeer.requestId) {
    controller.updateDraft({ connectionRequestId: selectedPeer.requestId });
  }
  if (selectedCapability && snapshot.draft.capabilityId !== selectedCapability.id) {
    controller.updateDraft({ capabilityId: selectedCapability.id });
  }

  const selectors = document.createElement("div");
  selectors.className = "teti-task-selectors";
  const peerSelect = labeledSelect("发送给", peers.map((peer) => ({
    value: peer.requestId,
    label: peer.identity.displayName || shortTetiId(peer.identity.tetiId)
  })), selectedPeer?.requestId ?? "");
  peerSelect.select.addEventListener("change", () => {
    const peer = peers.find((candidate) => candidate.requestId === peerSelect.select.value);
    controller.updateDraft({
      connectionRequestId: peerSelect.select.value,
      capabilityId: peer ? availableCapabilities(peer)[0]?.id ?? "" : ""
    });
    controller.openCompose();
  });
  const capabilitySelect = labeledSelect("调用能力", capabilities.map((capability) => ({
    value: capability.id,
    label: capability.name
  })), selectedCapability?.id ?? "");
  capabilitySelect.select.addEventListener("change", () => {
    controller.updateDraft({ capabilityId: capabilitySelect.select.value });
    controller.openCompose();
  });
  selectors.append(peerSelect.label, capabilitySelect.label);

  const prompt = document.createElement("textarea");
  prompt.className = "teti-task-prompt";
  prompt.placeholder = "清楚描述希望对方 AI 完成的任务…";
  prompt.value = snapshot.draft.text;
  prompt.maxLength = 6_000;
  prompt.disabled = snapshot.busy || !selectedCapability;
  prompt.setAttribute("aria-label", "任务内容");

  const supportsImages = Boolean(selectedPeer && selectedCapability
    && capabilityAcceptsImages(selectedPeer, selectedCapability.id));
  const returnsImages = Boolean(selectedPeer && selectedCapability
    && capabilityReturnsImages(selectedPeer, selectedCapability.id));
  const attachments = document.createElement("div");
  attachments.className = "teti-task-attachments";
  for (const image of snapshot.draft.images) {
    attachments.append(imagePreview(image.path, image.part.attachmentId, () => {
      controller.removeDraftImage(image.part.attachmentId);
    }));
  }
  if (supportsImages && snapshot.draft.images.length < 4) {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "teti-task-add-image";
    add.append(createElement(ImagePlus, { width: 18, height: 18, "aria-hidden": "true" }), document.createTextNode(" 添加图片"));
    add.disabled = snapshot.busy;
    add.addEventListener("click", () => void controller.attachImages());
    attachments.append(add);
  }

  const footer = document.createElement("div");
  footer.className = "teti-task-actionbar";
  const hint = document.createElement("small");
  hint.textContent = returnsImages
    ? `${supportsImages ? "PNG/JPEG · 最多 4 张 · " : ""}结果必须返回图片`
    : supportsImages ? "文字必填 · PNG/JPEG · 最多 4 张" : "该能力当前仅接受文字";
  const send = document.createElement("button");
  send.type = "submit";
  send.className = "teti-task-primary";
  send.textContent = snapshot.busy ? "处理中…" : "发送任务";
  send.disabled = snapshot.busy
    || !selectedPeer
    || !selectedCapability
    || !snapshot.draft.text.trim()
    || (snapshot.draft.images.length > 0 && !supportsImages);
  const syncSendState = (): void => {
    controller.updateDraft({ text: prompt.value });
    send.disabled = !controller.canSendDraft()
      || (snapshot.draft.images.length > 0 && !supportsImages);
  };
  prompt.addEventListener("input", syncSendState);
  footer.append(hint, send);
  form.append(selectors, prompt, attachments);
  if (snapshot.draft.images.length >= 2) {
    const warning = document.createElement("p");
    warning.className = "teti-task-known-defect";
    warning.setAttribute("role", "status");
    warning.textContent = "0.2.1 已知限制：多图送达仍在实机复盘；若图片不完整，对方无法授权或执行任务。";
    form.append(warning);
  }
  if (snapshot.error) form.append(errorText(snapshot.error));
  form.append(footer);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void controller.send();
  });
  return form;
}

function createTaskDetail(
  controller: TaskController,
  snapshot: TaskControllerSnapshot,
  connections: readonly PassportConnectionSnapshot[],
  localPassport?: TetiCapabilityPassport
): HTMLElement {
  const record = snapshot.selectedTask!;
  const content = document.createElement("div");
  content.className = "teti-task-scroll teti-task-detail";
  const identity = document.createElement("div");
  identity.className = "teti-task-detail-head";
  const peer = document.createElement("div");
  const peerTitle = document.createElement("strong");
  peerTitle.textContent = taskPeerHeading(
    record.direction,
    record.peerTetiId,
    record.createdAt,
    connections
  );
  const capability = document.createElement("small");
  capability.textContent = `Capability · ${record.request.capabilityId}`;
  peer.append(peerTitle, capability);
  const status = document.createElement("span");
  status.className = `teti-task-status is-${record.state}`;
  status.textContent = detailStatusLabel(record);
  identity.append(peer, status);

  const prompt = document.createElement("section");
  prompt.className = "teti-task-card";
  const promptTitle = document.createElement("strong");
  promptTitle.textContent = "完整任务";
  const text = document.createElement("p");
  text.textContent = taskInputText(record.request.input);
  prompt.append(promptTitle, text);
  const images = taskInputImages(record.request.input);
  const receivedInputImages = (record.attachmentDiagnostics ?? []).filter((item) =>
    item.purpose === "input"
    && (record.direction === "incoming" ? item.state === "stored" : item.state === "acknowledged")
  ).length;
  if (images.length > 0) {
    const gallery = document.createElement("div");
    gallery.className = "teti-task-detail-images";
    for (const image of images) {
      const path = snapshot.selectedImagePaths[image.attachmentId];
      if (path) gallery.append(imagePreview(path, image.attachmentId));
      else {
        const pending = document.createElement("span");
        pending.className = "teti-task-image-pending";
        pending.textContent = record.attachmentsReady === false
          ? `图片接收中 ${receivedInputImages}/${images.length}…`
          : "图片不可用";
        gallery.append(pending);
      }
    }
    prompt.append(gallery);
  }
  content.append(identity, prompt);

  if (record.direction === "incoming" && record.approval === "pending") {
    const scope = document.createElement("section");
    scope.className = "teti-task-scope";
    const executionAgent = localAgentForTask(localPassport, record.request.capabilityId, images.length > 0);
    const scopeTitle = document.createElement("strong");
    scopeTitle.textContent = record.state === "auth_required"
      ? "Agent 登录后 · 再允许一次"
      : executionAgent ? `${executionAgent.name} · 仅允许一次` : "仅允许一次";
    const scopeDetail = document.createElement("span");
    scopeDetail.textContent = record.state === "auth_required"
      ? "Teti 不保存登录凭据；请先在本机完成 Agent 登录，再重新授权本任务。"
      : "只执行本任务；授权时重新校验 Agent，不开放文件、命令或持续权限。";
    scope.append(scopeTitle, scopeDetail);
    content.append(scope);
  }

  for (const artifact of record.artifacts ?? []) {
    const card = document.createElement("section");
    card.className = "teti-task-card teti-task-artifact";
    const title = document.createElement("strong");
    title.textContent = "结果 Artifact";
    const result = document.createElement("pre");
    result.textContent = artifact.schemaVersion === 1
      ? artifact.text
      : artifact.parts.filter((part) => part.kind === "text").map((part) => part.text).join("\n");
    card.append(title, result);
    const artifactImages = taskArtifactImages(artifact);
    if (artifactImages.length > 0) {
      const gallery = document.createElement("div");
      gallery.className = "teti-task-detail-images is-artifact";
      for (const image of artifactImages) {
        const path = snapshot.selectedImagePaths[image.attachmentId];
        if (path) gallery.append(artifactImagePreview(controller, path, image.attachmentId));
        else {
          const pending = document.createElement("span");
          pending.className = "teti-task-image-pending";
          pending.textContent = "结果图片接收中…";
          gallery.append(pending);
        }
      }
      card.append(gallery);
    }
    content.append(card);
  }
  if (record.safeErrorCode) {
    const code = document.createElement("p");
    code.className = "teti-task-safe-code";
    code.textContent = `状态代码：${record.safeErrorCode}`;
    content.append(code);
  }
  if (snapshot.error) content.append(errorText(snapshot.error));

  const actions = document.createElement("div");
  actions.className = "teti-task-actionbar is-detail";
  if (record.direction === "incoming" && record.approval === "pending") {
    const reject = actionButton("拒绝", "secondary", () => void controller.reject());
    const allow = actionButton(
      record.state === "auth_required" ? "登录后重试一次" : "仅允许一次",
      "primary",
      () => void controller.approve()
    );
    reject.disabled = snapshot.busy;
    allow.disabled = snapshot.busy || record.attachmentsReady === false;
    actions.append(reject, allow);
  } else if (!["completed", "failed", "canceled", "rejected"].includes(record.state)) {
    const cancel = actionButton(record.direction === "incoming" ? "停止任务" : "取消任务", "secondary", () => void controller.cancel());
    cancel.disabled = snapshot.busy || Boolean(record.cancelPending);
    actions.append(cancel);
  }
  content.append(actions);
  return content;
}

function availableCapabilities(connection: PassportConnectionSnapshot): TetiCapability[] {
  if (connection.passport.state === "disabled" || connection.passport.state === "unknown") return [];
  const callableIds = new Set(connection.passport.agents
    .filter(isCallableAgent)
    .filter((agent) => agent.availability === "available")
    .flatMap((agent) => agent.capabilityIds));
  return connection.passport.capabilities.filter((capability) =>
    capability.availability === "available" && callableIds.has(capability.id)
  );
}

function capabilityAcceptsImages(connection: PassportConnectionSnapshot, capabilityId: string): boolean {
  const agentIds = new Set(connection.passport.bindings
    .filter((binding) => binding.capabilityId === capabilityId)
    .flatMap((binding) => binding.agentIds));
  return connection.passport.agents.some((agent) =>
    isCallableAgent(agent)
    && agentIds.has(agent.id)
    && agent.capabilityIds.includes(capabilityId)
    && agent.inputModes.includes("image")
  );
}

function capabilityReturnsImages(connection: PassportConnectionSnapshot, capabilityId: string): boolean {
  const agentIds = new Set(connection.passport.bindings
    .filter((binding) => binding.capabilityId === capabilityId)
    .flatMap((binding) => binding.agentIds));
  return connection.passport.agents.some((agent) =>
    isCallableAgent(agent)
    && agentIds.has(agent.id)
    && agent.capabilityIds.includes(capabilityId)
    && agent.outputModes.includes("image")
  );
}

function isCallableAgent(agent: PassportConnectionSnapshot["passport"]["agents"][number]): agent is CallablePassportAgent {
  return "capabilityIds" in agent && "inputModes" in agent;
}

function localAgentForTask(
  passport: TetiCapabilityPassport | undefined,
  capabilityId: string,
  requiresImage: boolean
): CallablePassportAgent | undefined {
  if (!passport) return undefined;
  const boundAgentIds = new Set(passport.bindings
    .filter((binding) => binding.capabilityId === capabilityId)
    .flatMap((binding) => binding.agentIds));
  return passport.agents.find((agent) =>
    boundAgentIds.has(agent.id)
    && agent.availability === "available"
    && agent.capabilityIds.includes(capabilityId)
    && agent.inputModes.includes("text")
    && (!requiresImage || agent.inputModes.includes("image"))
  );
}

function labeledSelect(
  title: string,
  options: Array<{ value: string; label: string }>,
  selected: string
): { label: HTMLLabelElement; select: HTMLSelectElement } {
  const label = document.createElement("label");
  label.className = "teti-task-select-label";
  const caption = document.createElement("span");
  caption.textContent = title;
  const select = document.createElement("select");
  select.className = "teti-task-select";
  if (options.length === 0) {
    const option = document.createElement("option");
    option.textContent = "暂无可调用能力";
    option.value = "";
    select.append(option);
    select.disabled = true;
  } else {
    for (const item of options) {
      const option = document.createElement("option");
      option.value = item.value;
      option.textContent = item.label;
      option.selected = item.value === selected;
      select.append(option);
    }
  }
  label.append(caption, select);
  return { label, select };
}

function imagePreview(path: string, attachmentId: string, remove?: () => void): HTMLElement {
  const item = document.createElement("figure");
  item.className = "teti-task-image";
  const image = document.createElement("img");
  image.src = safeAssetUrl(path);
  image.alt = "任务图片";
  image.loading = "lazy";
  item.append(image);
  if (remove) {
    const button = iconButton(X, "移除图片", remove);
    button.classList.add("teti-task-image-remove");
    item.append(button);
  }
  item.dataset.attachmentId = attachmentId;
  return item;
}

function artifactImagePreview(
  controller: TaskController,
  path: string,
  attachmentId: string
): HTMLElement {
  const item = imagePreview(path, attachmentId);
  item.classList.add("is-artifact");
  const actions = document.createElement("figcaption");
  actions.className = "teti-task-image-actions";
  actions.append(
    iconButton(ExternalLink, "打开结果图片", () => void controller.openResultImage(path)),
    iconButton(FolderOpen, "在 Finder 中显示", () => void controller.revealResultImage(path)),
    iconButton(Download, "另存为", () => void controller.saveResultImage(path))
  );
  item.append(actions);
  return item;
}

function safeAssetUrl(path: string): string {
  try {
    return convertFileSrc(path);
  } catch {
    return "";
  }
}

function iconButton(
  icon: Parameters<typeof createElement>[0],
  label: string,
  action: () => void
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "teti-task-icon-button";
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);
  button.append(createElement(icon, { width: 18, height: 18, "stroke-width": 2, "aria-hidden": "true" }));
  button.addEventListener("click", action);
  return button;
}

function actionButton(label: string, tone: "primary" | "secondary", action: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = tone === "primary" ? "teti-task-primary" : "teti-task-secondary";
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}

function errorText(message: string): HTMLElement {
  const error = document.createElement("p");
  error.className = "teti-task-error";
  error.textContent = message;
  return error;
}

function taskStatusLabel(task: TaskControllerSnapshot["summary"]["tasks"][number]): string {
  if (task.cancelPending) return "正在取消";
  if (task.state === "auth_required") return "Agent 需要登录";
  if (task.direction === "incoming" && task.approval === "pending") {
    return task.attachmentsReady ? "等待你确认" : "正在接收图片";
  }
  if (task.direction === "outgoing" && task.state === "submitted") return "等待对方确认";
  if (task.direction === "outgoing" && task.state === "completed" && task.artifactCount === 0) {
    return "任务已完成 · 结果接收中";
  }
  return stateLabel(task.state);
}

function detailStatusLabel(record: NonNullable<TaskControllerSnapshot["selectedTask"]>): string {
  if (record.cancelPending) return "正在取消";
  if (record.state === "auth_required") return "Agent 需要登录";
  if (record.direction === "incoming" && record.approval === "pending") {
    return record.attachmentsReady === false ? "正在接收图片" : "等待你确认";
  }
  if (record.direction === "outgoing" && record.state === "submitted") return "等待对方确认";
  if (record.direction === "outgoing" && record.state === "completed"
    && (!(record.artifacts?.length) || record.artifactAttachmentsReady === false)) {
    return "任务已完成 · 结果接收中";
  }
  return stateLabel(record.state);
}

function stateLabel(state: string): string {
  return {
    submitted: "已提交",
    working: "工作中",
    completed: "已完成",
    failed: "失败",
    canceled: "已取消",
    rejected: "已拒绝",
    input_required: "需要输入",
    auth_required: "需要授权"
  }[state] ?? "状态未知";
}

function shortTetiId(tetiId: string): string {
  return tetiId.replace(/^teti_/, "");
}

export function taskPeerHeading(
  direction: "incoming" | "outgoing",
  peerTetiId: string,
  createdAt: string,
  connections: readonly PassportConnectionSnapshot[]
): string {
  const connection = connections.find((candidate) => candidate.identity.tetiId === peerTetiId);
  const name = connection?.identity.displayName?.trim() || shortTetiId(peerTetiId);
  return `${direction === "incoming" ? "来自" : "发送给"} ${name} 的协作请求【${formatTaskTimestamp(createdAt)}】`;
}

export function formatTaskTimestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间未知";
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}年${pad(date.getMonth() + 1)}月${pad(date.getDate())}日 ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function taskComposeRenderKey(snapshot: TaskControllerSnapshot): string {
  return JSON.stringify({
    connectionRequestId: snapshot.draft.connectionRequestId,
    capabilityId: snapshot.draft.capabilityId,
    imageIds: snapshot.draft.images.map((image) => image.part.attachmentId),
    busy: snapshot.busy,
    error: snapshot.error ?? ""
  });
}
