import { convertFileSrc } from "@tauri-apps/api/core";
import { ArrowLeft, Download, ExternalLink, FolderOpen, ImagePlus, Plus, X, createElement } from "lucide";
import { taskArtifactImages, taskInputImages, taskInputText } from "../../../../core/task/types.ts";
import type { PassportConnectionSnapshot } from "../../../../core/passport/snapshot.ts";
import type {
  CallablePassportAgent,
  ComputeOffer,
  TetiCapability,
  TetiCapabilityPassport
} from "../../../../core/passport/types.ts";
import { delegationTargetKey, type TaskController, type TaskControllerSnapshot } from "./controller.ts";
import type { MemoryController } from "../memory/controller.ts";
import type {
  DelegationArtifactProvenance,
  DelegationPlanState,
  DelegationStepState
} from "../../../../core/delegation/types.ts";

export function createTaskWorkspace(
  controller: TaskController,
  connections: readonly PassportConnectionSnapshot[],
  localPassport?: TetiCapabilityPassport,
  memoryController?: MemoryController
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
    body.append(createTaskDetail(controller, snapshot, connections, localPassport, memoryController));
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
    && availableTaskOffers(connection).length > 0
  );
  const selectedPeer = peers.find((peer) => peer.requestId === snapshot.draft.connectionRequestId) ?? peers[0];
  const offers = selectedPeer ? availableTaskOffers(selectedPeer) : [];
  const selectedOffer = offers.find((offer) => offer.offerId === snapshot.draft.offerId)
    ?? offers.find((offer) => offer.capability.id === snapshot.draft.capabilityId)
    ?? offers[0];
  const selectedCapability = selectedOffer?.capability;
  if (selectedPeer && snapshot.draft.connectionRequestId !== selectedPeer.requestId) {
    controller.updateDraft({ connectionRequestId: selectedPeer.requestId });
  }
  if (selectedOffer && (snapshot.draft.capabilityId !== selectedCapability?.id
    || snapshot.draft.offerId !== selectedOffer.offerId)) {
    controller.updateDraft({
      offerId: selectedOffer.offerId,
      capabilityId: selectedOffer.capability.id
    });
  }

  const selectors = document.createElement("div");
  selectors.className = "teti-task-selectors";
  const peerSelect = labeledSelect("发送给", peers.map((peer) => ({
    value: peer.requestId,
    label: peer.identity.displayName || shortTetiId(peer.identity.tetiId)
  })), selectedPeer?.requestId ?? "");
  peerSelect.select.addEventListener("change", () => {
    const peer = peers.find((candidate) => candidate.requestId === peerSelect.select.value);
    const offer = peer ? availableTaskOffers(peer)[0] : undefined;
    controller.updateDraft({
      connectionRequestId: peerSelect.select.value,
      offerId: offer?.offerId ?? "",
      capabilityId: offer?.capability.id ?? ""
    });
    controller.openCompose();
  });
  const capabilitySelect = labeledSelect("调用能力", offers.map((offer) => ({
    value: offer.offerId,
    label: offer.compute ? `${offer.capability.name} · 本地算力` : offer.capability.name
  })), selectedOffer?.offerId ?? "");
  capabilitySelect.select.addEventListener("change", () => {
    const offer = offers.find((candidate) => candidate.offerId === capabilitySelect.select.value);
    controller.updateDraft({
      offerId: offer?.offerId ?? "",
      capabilityId: offer?.capability.id ?? ""
    });
    controller.openCompose();
  });
  const modeSelect = labeledSelect("协作模式", [
    { value: "single_stage", label: "单次调用" },
    { value: "long_horizon", label: "持续协作" }
  ], snapshot.draft.executionMode);
  modeSelect.select.addEventListener("change", () => {
    controller.updateDraft({
      executionMode: modeSelect.select.value === "long_horizon" ? "long_horizon" : "single_stage"
    });
    controller.openCompose();
  });
  selectors.append(peerSelect.label, capabilitySelect.label, modeSelect.label);

  const prompt = document.createElement("textarea");
  prompt.className = "teti-task-prompt";
  prompt.placeholder = "清楚描述希望对方 AI 完成的任务…";
  prompt.value = snapshot.draft.text;
  prompt.maxLength = 6_000;
  prompt.disabled = snapshot.busy || !selectedCapability;
  prompt.setAttribute("aria-label", "任务内容");

  const supportsImages = snapshot.draft.executionMode !== "long_horizon" && Boolean(selectedPeer && selectedCapability
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
  hint.textContent = snapshot.draft.executionMode === "long_horizon"
    ? "持续协作 · 仅文字 · 每阶段由 Host 显式推进 · 最多 16 阶段"
    : selectedOffer?.compute
    ? "接收端本地算力 · 仅文字 · 并发 1 · 每次授权"
    : returnsImages
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
    || (snapshot.draft.executionMode === "long_horizon" && returnsImages)
    || (snapshot.draft.images.length > 0 && !supportsImages);
  const syncSendState = (): void => {
    controller.updateDraft({ text: prompt.value });
    send.disabled = !controller.canSendDraft()
      || (snapshot.draft.executionMode === "long_horizon" && returnsImages)
      || (snapshot.draft.images.length > 0 && !supportsImages);
  };
  prompt.addEventListener("input", syncSendState);
  footer.append(hint, send);
  form.append(selectors, prompt, attachments);
  if (snapshot.draft.images.length >= 2) {
    const warning = document.createElement("p");
    warning.className = "teti-task-known-defect";
    warning.setAttribute("role", "status");
    warning.textContent = "0.2.10 延续已知限制：多图送达仍在实机复盘；若图片不完整，对方无法授权或执行任务。";
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
  localPassport?: TetiCapabilityPassport,
  memoryController?: MemoryController
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
  capability.textContent = record.request.offerId === "local.compute.general-text-assistance.v1"
    ? "通用文字协助 · 接收端本地算力"
    : record.request.offerId === "local.agent.osaurus-native-text.v1"
      ? "通用文字协助 · Osaurus Native Agent"
    : `Capability · ${record.request.capabilityId}`;
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

  if (snapshot.selectedExecution) {
    const execution = document.createElement("section");
    execution.className = "teti-task-scope teti-task-execution";
    const title = document.createElement("strong");
    title.textContent = `本机执行 · 第 ${snapshot.selectedExecution.executionEpoch} 轮`;
    const detail = document.createElement("span");
    detail.textContent = snapshot.selectedExecution.progress.message
      ?? executionProgressLabel(snapshot.selectedExecution.progress.state);
    execution.append(title, detail);
    content.append(execution);
  }

  if (record.longHorizon || record.peerLongHorizon) {
    content.append(createLongHorizonSection(controller, snapshot));
  }

  if (record.direction === "incoming"
    && record.approval === "pending"
    && record.request.executionMode === "long_horizon"
    && snapshot.delegationTargets.length > 0) {
    content.append(createDelegationApprovalSection(controller, snapshot));
  }

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
      : record.request.offerId === "local.compute.general-text-assistance.v1"
        ? "只执行本任务；接收端在本机解析 Runtime 与模型，不向对端公开端口、路径、硬件或凭据。"
        : record.request.offerId === "local.agent.osaurus-native-text.v1"
          ? "只执行本任务；使用接收端固定的 Osaurus Agent。Tools、原生 Memory、Host Workspace 与 Autonomous Exec 必须保持关闭。"
        : "只执行本任务；授权时重新校验 Agent，不开放文件、命令或持续权限。";
    scope.append(scopeTitle, scopeDetail);
    content.append(scope);
  }

  for (const [artifactIndex, artifact] of (record.artifacts ?? []).entries()) {
    const card = document.createElement("section");
    card.className = "teti-task-card teti-task-artifact";
    const title = document.createElement("strong");
    const localEntry = record.longHorizon?.artifacts.find((entry) => entry.artifactId === artifact.artifactId);
    const peerEntry = record.peerArtifactMetadata?.find((entry) => entry.artifactId === artifact.artifactId);
    const delegationEntry = record.delegationPlan?.artifacts.find((entry) =>
      entry.artifactId === artifact.artifactId
    );
    const isFinal = localEntry?.role === "final"
      || peerEntry?.role === "final"
      || delegationEntry?.role === "final"
      || record.peerLongHorizon?.finalArtifactId === artifact.artifactId;
    title.textContent = delegationEntry
      ? delegationArtifactTitle(delegationEntry, record.delegationPlan!)
      : `${isFinal ? "最终" : "中间"} Artifact · 阶段 ${localEntry?.stageIndex ?? peerEntry?.stageIndex ?? artifactIndex + 1}`;
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
  if (memoryController && snapshot.selectedExecution) {
    content.append(createTaskMemorySection(memoryController, snapshot));
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
  } else if (record.direction === "incoming"
    && record.state === "input_required"
    && snapshot.selectedExecution?.resumeCapability === "checkpoint_restart") {
    const resume = actionButton("从检查点重新开始", "primary", () => void controller.resume());
    resume.disabled = snapshot.busy;
    actions.append(resume);
  } else if (!["completed", "failed", "canceled", "rejected", "input_required"].includes(record.state)) {
    const cancel = actionButton(record.direction === "incoming" ? "停止任务" : "取消任务", "secondary", () => void controller.cancel());
    cancel.disabled = snapshot.busy || Boolean(record.cancelPending);
    actions.append(cancel);
  }
  content.append(actions);
  return content;
}

function createLongHorizonSection(
  controller: TaskController,
  snapshot: TaskControllerSnapshot
): HTMLElement {
  const record = snapshot.selectedTask!;
  const local = record.longHorizon;
  const peer = record.peerLongHorizon;
  const phase = local?.phase ?? peer?.phase ?? "working";
  const stageIndex = local?.currentStageIndex ?? peer?.currentStageIndex ?? 0;
  const workspaceRevision = local?.workspaceRevision ?? peer?.workspaceRevision ?? 1;
  const progress = local?.progress;
  const delegation = record.delegationPlan;
  const section = document.createElement("section");
  section.className = "teti-task-card teti-task-long-horizon";
  const heading = document.createElement("div");
  heading.className = "teti-task-long-horizon-head";
  const title = document.createElement("strong");
  title.textContent = delegation
    ? `Teti Host 委派 · 步骤 ${delegation.currentStepIndex}/${delegation.maximumChildCalls + 1}`
    : `持续协作 · 阶段 ${stageIndex}`;
  const state = document.createElement("span");
  state.textContent = longHorizonPhaseLabel(phase);
  heading.append(title, state);
  const meta = document.createElement("p");
  meta.textContent = `Workspace r${workspaceRevision} · 续期至 ${formatShortTimestamp(
    local?.continuationExpiresAt ?? peer?.continuationExpiresAt ?? record.request.expiresAt
  )}`;
  section.append(heading, meta);

  if (delegation) {
    const boundary = document.createElement("p");
    boundary.className = "teti-task-delegation-boundary";
    boundary.textContent = "确定性计划 · 深度 1 · Planner 关闭 · Child 不可联系远端或扩大 Workspace 权限";
    section.append(boundary);

    const planSteps = document.createElement("ol");
    planSteps.className = "teti-task-stage-list teti-task-delegation-plan";
    for (const step of delegation.steps) {
      const item = document.createElement("li");
      const label = document.createElement("strong");
      const detail = document.createElement("span");
      if (step.kind === "child_execution") {
        label.textContent = `步骤 ${step.stepIndex} · ${step.childAgentId}`;
        detail.textContent = `${step.capabilityId} · ${step.resourceBindingId} · ${delegationStepStateLabel(step.state)}`;
        const budget = document.createElement("small");
        budget.textContent = `Workspace r${step.workspaceRevision} · ${Math.round(step.budget.timeoutMs / 1_000)}s · 输出上限 ${Math.round(step.budget.maxOutputBytes / 1_024)} KiB`;
        item.append(label, detail, budget);
      } else {
        label.textContent = `步骤 ${step.stepIndex} · Teti Host`;
        detail.textContent = `Artifact 确定性汇总 · ${delegationStepStateLabel(step.state)}`;
        item.append(label, detail);
      }
      planSteps.append(item);
    }
    section.append(planSteps);
  }

  const progressText = progress?.message ?? peer?.progressMessage;
  if (progressText) {
    const status = document.createElement("p");
    status.className = "teti-task-long-horizon-progress";
    status.setAttribute("role", "status");
    status.textContent = progressText;
    section.append(status);
  }

  if (local?.stages.length) {
    const stages = document.createElement("ol");
    stages.className = "teti-task-stage-list";
    for (const stage of local.stages) {
      const item = document.createElement("li");
      const label = document.createElement("strong");
      label.textContent = `阶段 ${stage.stageIndex} · ${stage.childAgentId}`;
      const detail = document.createElement("span");
      detail.textContent = `${longHorizonPhaseLabel(stage.state)} · Workspace r${stage.workspaceRevision}`;
      item.append(label, detail);
      stages.append(item);
    }
    section.append(stages);
  }

  if (record.direction === "outgoing" && record.state === "input_required") {
    const form = document.createElement("form");
    form.className = "teti-task-stage-input";
    const input = document.createElement("textarea");
    input.maxLength = 6_000;
    input.placeholder = "补充下一阶段指令…";
    input.setAttribute("aria-label", "下一阶段补充指令");
    const submit = actionButton("发送补充指令", "primary", () => undefined);
    submit.type = "submit";
    submit.disabled = snapshot.busy || Boolean(record.inputPending);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (input.value.trim()) void controller.submitInput(input.value);
    });
    form.append(input, submit);
    section.append(form);
  }

  if (record.direction === "incoming" && local && !delegation) {
    const controls = document.createElement("div");
    controls.className = "teti-task-stage-controls";
    if (phase === "working") {
      controls.append(actionButton(local.pauseRequested ? "将在阶段边界暂停" : "阶段后暂停", "secondary", () => void controller.pause()));
    }
    if ((phase === "input_required" || phase === "paused") && local.pendingInput) {
      const instruction = document.createElement("p");
      instruction.className = "teti-task-stage-instruction";
      instruction.textContent = `补充指令：${local.pendingInput.instruction}`;
      section.append(instruction);
      const child = labeledSelect("继续使用 Child Agent", local.availableChildAgents.map((target) => ({
        value: target.childAgentId,
        label: `${target.childAgentId} · ${target.connectorId}`
      })), local.stages.at(-1)?.childAgentId ?? local.availableChildAgents[0]?.childAgentId ?? "");
      controls.append(child.label, actionButton("开始下一阶段", "primary", () => {
        void controller.continue(child.select.value || undefined);
      }));
    }
    if ((phase === "input_required" || phase === "paused") && local.artifacts.length > 0 && !local.pendingInput) {
      controls.append(actionButton("确认当前结果为最终结果", "primary", () => void controller.complete()));
    }
    if (phase === "input_required" || phase === "paused") {
      controls.append(actionButton("续期 1 小时", "secondary", () => void controller.renew()));
    }
    section.append(controls);

    const audit = document.createElement("details");
    audit.className = "teti-task-audit";
    const summary = document.createElement("summary");
    summary.textContent = `恢复与操作审计 · ${local.audit.length}`;
    const list = document.createElement("ol");
    for (const event of [...local.audit].reverse()) {
      const item = document.createElement("li");
      item.textContent = `${formatShortTimestamp(event.timestamp)} · ${event.action}${
        event.stageIndex ? ` · 阶段 ${event.stageIndex}` : ""
      }`;
      list.append(item);
    }
    audit.append(summary, list);
    section.append(audit);
  }
  if (delegation) {
    const audit = document.createElement("details");
    audit.className = "teti-task-audit";
    const summary = document.createElement("summary");
    summary.textContent = `Host 委派审计 · ${delegation.audit.length}`;
    const list = document.createElement("ol");
    for (const event of [...delegation.audit].reverse()) {
      const item = document.createElement("li");
      item.textContent = `${formatShortTimestamp(event.timestamp)} · ${event.action}${
        event.stepId ? ` · ${event.stepId}` : ""
      }`;
      list.append(item);
    }
    audit.append(summary, list);
    section.append(audit);
  }
  return section;
}

function createDelegationApprovalSection(
  controller: TaskController,
  snapshot: TaskControllerSnapshot
): HTMLElement {
  const section = document.createElement("section");
  section.className = "teti-task-card teti-task-delegation-approval";
  const heading = document.createElement("div");
  heading.className = "teti-task-delegation-heading";
  const title = document.createElement("strong");
  title.textContent = "Teti Host 委派计划";
  const badge = document.createElement("span");
  badge.textContent = "Planner 关闭";
  heading.append(title, badge);
  const note = document.createElement("p");
  note.textContent = "由你明确指定本机 Child Agent 顺序。每步独立预算、超时和权限，最多 4 步，最后由 Teti Host 汇总 Artifact。";
  const steps = document.createElement("ol");
  steps.className = "teti-task-delegation-editor";
  for (const [index, selection] of snapshot.delegationSelections.entries()) {
    const item = document.createElement("li");
    const target = labeledSelect(`步骤 ${index + 1}`, snapshot.delegationTargets.map((candidate) => ({
      value: delegationTargetKey(candidate),
      label: `${candidate.childAgentId} · ${candidate.capabilityId}`
    })), delegationTargetKey(selection));
    target.select.disabled = snapshot.busy;
    target.select.addEventListener("change", () => controller.setDelegationStep(index, target.select.value));
    const selectedTarget = snapshot.delegationTargets.find((candidate) =>
      delegationTargetKey(candidate) === delegationTargetKey(selection)
    );
    const detail = document.createElement("small");
    detail.textContent = selectedTarget
      ? `${selectedTarget.resourceBindingId} · ${workspacePolicyLabel(selectedTarget.workspacePolicy)} · ${Math.round(selectedTarget.timeoutMs / 1_000)}s`
      : "本机目标待重新检测";
    const remove = actionButton("移除", "secondary", () => controller.removeDelegationStep(index));
    remove.disabled = snapshot.busy || snapshot.delegationSelections.length <= 1;
    remove.setAttribute("aria-label", `移除委派步骤 ${index + 1}`);
    item.append(target.label, detail, remove);
    steps.append(item);
  }
  const controls = document.createElement("div");
  controls.className = "teti-task-delegation-controls";
  const add = actionButton("增加一步", "secondary", () => controller.addDelegationStep());
  add.disabled = snapshot.busy
    || snapshot.delegationSelections.length >= 4
    || snapshot.delegationTargets.length === 0;
  const approve = actionButton("按计划委派", "primary", () => void controller.approveDelegation());
  approve.disabled = snapshot.busy
    || snapshot.selectedTask?.attachmentsReady === false
    || snapshot.delegationSelections.length === 0;
  controls.append(add, approve);
  section.append(heading, note, steps, controls);
  return section;
}

function delegationArtifactTitle(
  entry: DelegationArtifactProvenance,
  plan: DelegationPlanState
): string {
  if (entry.producer.kind === "teti_host") {
    return `最终 Artifact · Teti Host 汇总 · Workspace r${entry.workspaceRevision}`;
  }
  const step = plan.steps.find((candidate) => candidate.stepId === entry.stepId);
  return `中间 Artifact · 步骤 ${step?.stepIndex ?? "?"} · ${entry.producer.childAgentId} · ${entry.producer.resourceBindingId} · Workspace r${entry.workspaceRevision}`;
}

function delegationStepStateLabel(state: DelegationStepState): string {
  if (state === "pending") return "待执行";
  if (state === "working") return "执行中";
  if (state === "completed") return "已完成";
  if (state === "failed") return "失败";
  if (state === "canceled") return "已取消";
  return "已中断";
}

function workspacePolicyLabel(policy: "snapshot" | "bounded_context" | "none"): string {
  if (policy === "snapshot") return "Workspace Snapshot";
  if (policy === "bounded_context") return "有界上下文";
  return "无 Workspace";
}

function createTaskMemorySection(
  controller: MemoryController,
  snapshot: TaskControllerSnapshot
): HTMLElement {
  const record = snapshot.selectedTask!;
  const execution = snapshot.selectedExecution!;
  const memory = controller.snapshot;
  const section = document.createElement("section");
  section.className = "teti-task-card teti-task-memory";
  const title = document.createElement("strong");
  title.textContent = "Child Memory";
  const note = document.createElement("p");
  note.textContent = "Task Memory 仅存在于本次执行。长期保存必须由你先开启范围授权，再单独保存完成结果。";
  section.append(title, note);

  if (record.direction !== "incoming" || record.state !== "completed" || !taskHasTextArtifact(record)) {
    const unavailable = document.createElement("small");
    unavailable.textContent = "本机 Child Agent 完成文字任务后，可选择保存；对端任务内容不会自动进入长期 Memory。";
    section.append(unavailable);
    return section;
  }

  section.append(createTaskMemoryScopeRow({
    controller,
    taskId: record.request.taskId,
    scope: "child_agent",
    workspaceId: null,
    childAgentId: execution.childAgentId,
    label: `${execution.childAgentId} 长期 Memory`,
    description: "仅供同一 Child Agent 后续任务检索"
  }));

  if (record.workspaceBinding?.mode === "durable_collaboration") {
    section.append(createTaskMemoryScopeRow({
      controller,
      taskId: record.request.taskId,
      scope: "workspace",
      workspaceId: record.workspaceBinding.workspaceId,
      childAgentId: execution.childAgentId,
      label: "Workspace Memory",
      description: "仅供此 Workspace 与此 Child Agent 检索"
    }));
  }
  if (memory.error) {
    const error = document.createElement("small");
    error.className = "teti-memory-error";
    error.setAttribute("role", "alert");
    error.textContent = memory.error;
    section.append(error);
  }
  return section;
}

function createTaskMemoryScopeRow(input: {
  controller: MemoryController;
  taskId: string;
  scope: "workspace" | "child_agent";
  workspaceId: string | null;
  childAgentId: string;
  label: string;
  description: string;
}): HTMLElement {
  const snapshot = input.controller.snapshot;
  const authorized = input.controller.isAuthorized(input.scope, input.workspaceId, input.childAgentId);
  const saved = input.controller.hasTaskMemory(input.taskId, input.scope);
  const row = document.createElement("div");
  row.className = "teti-task-memory-scope";
  const authorization = document.createElement("label");
  const copy = document.createElement("span");
  const name = document.createElement("strong");
  name.textContent = input.label;
  const description = document.createElement("small");
  description.textContent = input.description;
  copy.append(name, description);
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.checked = authorized;
  toggle.disabled = snapshot.busy;
  toggle.setAttribute("aria-label", `授权 ${input.label}`);
  toggle.addEventListener("change", () => void input.controller.setAuthorization({
    scope: input.scope,
    workspaceId: input.workspaceId,
    childAgentId: input.childAgentId,
    enabled: toggle.checked
  }));
  authorization.append(copy, toggle);
  const save = document.createElement("button");
  save.type = "button";
  save.className = "teti-memory-action";
  save.textContent = saved ? "已保存" : "保存结果";
  save.disabled = snapshot.busy || !authorized || saved;
  save.addEventListener("click", () => void input.controller.saveTask(input.taskId, input.scope));
  row.append(authorization, save);
  return row;
}

function taskHasTextArtifact(
  record: NonNullable<TaskControllerSnapshot["selectedTask"]>
): boolean {
  return (record.artifacts ?? []).some((artifact) => artifact.schemaVersion === 1
    ? Boolean(artifact.text.trim())
    : artifact.parts.some((part) => part.kind === "text" && Boolean(part.text.trim()))
  );
}

function executionProgressLabel(state: string): string {
  if (state === "queued") return "等待本机 Child Agent";
  if (state === "running") return "本机 Child Agent 正在执行";
  if (state === "interrupted") return "执行已中断";
  if (state === "completed") return "执行已完成";
  if (state === "canceled") return "执行已取消";
  if (state === "failed") return "执行失败";
  return "执行状态正在更新";
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

interface AvailableTaskOffer {
  offerId: string;
  capability: TetiCapability;
  compute?: ComputeOffer;
}

function availableTaskOffers(connection: PassportConnectionSnapshot): AvailableTaskOffer[] {
  const capabilities = availableCapabilities(connection);
  const offers = (connection.passport.computeOffers ?? []).flatMap((offer) => {
    const capability = capabilities.find((candidate) => candidate.id === offer.capability);
    return capability && connection.passport.state === "fresh"
      ? [{ offerId: offer.offerId, capability, compute: offer }]
      : [];
  });
  const offeredCapabilities = new Set(offers.map((offer) => offer.capability.id));
  return [
    ...offers,
    ...capabilities
      .filter((capability) => !offeredCapabilities.has(capability.id))
      .map((capability) => ({
        offerId: `capability:${capability.id}`,
        capability
      }))
  ];
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

function longHorizonPhaseLabel(phase: string): string {
  return {
    pending_approval: "等待批准",
    queued: "排队中",
    working: "执行中",
    input_required: "等待补充指令",
    paused: "已暂停",
    interrupted: "已中断",
    completed: "已完成",
    failed: "失败",
    canceled: "已取消",
    expired: "已过期"
  }[phase] ?? "状态更新中";
}

function formatShortTimestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
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
    executionMode: snapshot.draft.executionMode,
    imageIds: snapshot.draft.images.map((image) => image.part.attachmentId),
    busy: snapshot.busy,
    error: snapshot.error ?? ""
  });
}
