import { convertFileSrc } from "@tauri-apps/api/core";
import { ArrowLeft, Download, ExternalLink, FolderOpen, ImagePlus, Plus, X, createElement } from "lucide";
import {
  taskArtifactImages,
  taskInputImages,
  taskInputText,
  type CollaborationTaskArtifact
} from "../../../../core/task/types.ts";
import { LONG_HORIZON_LIMITS } from "../../../../core/task/transport.ts";
import type { PassportConnectionSnapshot } from "../../../../core/passport/snapshot.ts";
import type {
  CallablePassportAgent,
  ComputeOffer,
  TetiCapability,
  TetiCapabilityPassport
} from "../../../../core/passport/types.ts";
import {
  delegationTargetKey,
  taskAttentionCount,
  type TaskController,
  type TaskControllerSnapshot,
  type TaskUiErrorCode
} from "./controller.ts";
import type { MemoryController } from "../memory/controller.ts";
import { memoryErrorMessage } from "../memory/message.ts";
import { createDesktopI18n, formatMessage, type DesktopI18n } from "../i18n/index.ts";
import type {
  DelegationArtifactProvenance,
  DelegationPlanState,
  DelegationStepState
} from "../../../../core/delegation/types.ts";

export function createTaskWorkspace(
  controller: TaskController,
  connections: readonly PassportConnectionSnapshot[],
  localPassport?: TetiCapabilityPassport,
  memoryController?: MemoryController,
  i18n: DesktopI18n = createDesktopI18n("zh-Hans")
): HTMLElement {
  const snapshot = controller.snapshot;
  const island = document.createElement("section");
  island.className = "teti-island teti-island--expanded teti-task-workspace";
  island.setAttribute("aria-label", i18n.messages.tasks.surfaceLabel);
  island.setAttribute("aria-busy", String(snapshot.busy));
  if (snapshot.screen === "compose") {
    island.dataset.taskComposeKey = taskComposeRenderKey(snapshot);
  }
  island.append(createTaskHeader(controller, snapshot, i18n));
  const body = document.createElement("main");
  body.className = "teti-task-body";
  if (snapshot.screen === "compose") {
    body.append(createComposer(controller, snapshot, connections, i18n));
  }
  else if (snapshot.screen === "detail" && snapshot.selectedTask) {
    body.append(createTaskDetail(
      controller,
      snapshot,
      connections,
      localPassport,
      memoryController,
      i18n
    ));
  }
  else body.append(createInbox(controller, snapshot, connections, i18n));
  island.append(body);
  return island;
}

function createTaskHeader(
  controller: TaskController,
  snapshot: TaskControllerSnapshot,
  i18n: DesktopI18n
): HTMLElement {
  const messages = i18n.messages.tasks.header;
  const header = document.createElement("header");
  header.className = "teti-task-header";
  const back = iconButton(
    ArrowLeft,
    snapshot.screen === "inbox" ? messages.backToIsland : messages.backToInbox,
    () => controller.back()
  );
  const title = document.createElement("div");
  title.className = "teti-task-title";
  const heading = document.createElement("strong");
  heading.setAttribute("role", "heading");
  heading.setAttribute("aria-level", "1");
  heading.textContent = messages[snapshot.screen];
  const count = document.createElement("span");
  const attentionCount = taskAttentionCount(snapshot.summary);
  count.textContent = attentionCount > 0
    ? i18n.formatPlural(attentionCount, messages.pending)
    : messages.semanticCaption;
  title.append(heading, count);
  const compose = iconButton(Plus, messages.newTask, () => controller.openCompose());
  compose.disabled = snapshot.busy;
  header.append(back, title, compose);
  return header;
}

function createInbox(
  controller: TaskController,
  snapshot: TaskControllerSnapshot,
  connections: readonly PassportConnectionSnapshot[],
  i18n: DesktopI18n
): HTMLElement {
  const messages = i18n.messages.tasks.inbox;
  const content = document.createElement("div");
  content.className = "teti-task-scroll teti-task-inbox";
  content.dataset.scrollKey = "tasks-inbox";
  if (snapshot.summary.tasks.length === 0) {
    const empty = document.createElement("div");
    empty.className = "teti-task-empty";
    const title = document.createElement("strong");
    title.textContent = messages.emptyTitle;
    const note = document.createElement("p");
    note.textContent = messages.emptyNote;
    const action = document.createElement("button");
    action.type = "button";
    action.className = "teti-task-primary";
    action.textContent = messages.composeAction;
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
    row.className = `teti-task-row is-${task.state}${task.direction === "incoming" && task.approval === "pending" ? " is-awaiting-decision" : ""}${task.hasUnreadTaskUpdate ? " is-unread-update" : ""}`;
    const copy = document.createElement("span");
    copy.className = "teti-task-row-copy";
    const peer = document.createElement("strong");
    peer.textContent = taskPeerHeading(
      task.direction,
      task.peerTetiId,
      task.createdAt,
      connections,
      i18n
    );
    const preview = document.createElement("small");
    preview.textContent = task.textPreview;
    copy.append(peer, preview);
    const meta = document.createElement("span");
    meta.className = "teti-task-row-meta";
    const imageProgress = task.imageCount
      ? `${formatMessage(messages.imageProgress, {
          received: i18n.formatNumber(task.receivedImageCount),
          total: i18n.formatNumber(task.imageCount)
        })} · `
      : "";
    meta.textContent = `${imageProgress}${taskModeLabel(task, i18n)} · ${taskStatusLabel(task, i18n)}`;
    row.append(copy, meta);
    row.addEventListener("click", () => void controller.select(task.taskId));
    list.append(row);
  }
  content.append(list);
  if (snapshot.errorCode) content.append(errorText(taskErrorMessage(snapshot.errorCode, i18n)));
  return content;
}

function createComposer(
  controller: TaskController,
  snapshot: TaskControllerSnapshot,
  connections: readonly PassportConnectionSnapshot[],
  i18n: DesktopI18n
): HTMLElement {
  const messages = i18n.messages.tasks.composer;
  const form = document.createElement("form");
  form.className = "teti-task-scroll teti-task-composer";
  form.dataset.scrollKey = "tasks-compose";
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
  const peerSelect = labeledSelect(messages.peer, peers.map((peer) => ({
    value: peer.requestId,
    label: peer.identity.displayName || shortTetiId(peer.identity.tetiId)
  })), selectedPeer?.requestId ?? "", i18n);
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
  const capabilitySelect = labeledSelect(messages.capability, offers.map((offer) => ({
    value: offer.offerId,
    label: offer.compute ? `${offer.capability.name} · ${messages.localCompute}` : offer.capability.name
  })), selectedOffer?.offerId ?? "", i18n);
  capabilitySelect.select.addEventListener("change", () => {
    const offer = offers.find((candidate) => candidate.offerId === capabilitySelect.select.value);
    controller.updateDraft({
      offerId: offer?.offerId ?? "",
      capabilityId: offer?.capability.id ?? ""
    });
    controller.openCompose();
  });
  const modeSelect = labeledSelect(messages.mode, [
    { value: "single_stage", label: messages.singleStage },
    { value: "long_horizon", label: messages.longHorizon }
  ], snapshot.draft.executionMode, i18n);
  modeSelect.select.addEventListener("change", () => {
    controller.updateDraft({
      executionMode: modeSelect.select.value === "long_horizon" ? "long_horizon" : "single_stage"
    });
    controller.openCompose();
  });
  selectors.append(peerSelect.label, capabilitySelect.label, modeSelect.label);

  const prompt = document.createElement("textarea");
  prompt.className = "teti-task-prompt";
  prompt.placeholder = messages.promptPlaceholder;
  prompt.value = snapshot.draft.text;
  prompt.maxLength = 6_000;
  prompt.disabled = snapshot.busy || !selectedCapability;
  prompt.setAttribute("aria-label", messages.promptLabel);

  const supportsImages = snapshot.draft.executionMode !== "long_horizon" && Boolean(selectedPeer && selectedCapability
    && capabilityAcceptsImages(selectedPeer, selectedCapability.id));
  const requiresImageOutput = Boolean(selectedPeer && selectedCapability
    && capabilityRequiresImageOutput(selectedPeer, selectedCapability.id));
  const attachments = document.createElement("div");
  attachments.className = "teti-task-attachments";
  for (const image of snapshot.draft.images) {
    attachments.append(imagePreview(image.path, image.part.attachmentId, i18n, () => {
      controller.removeDraftImage(image.part.attachmentId);
    }));
  }
  if (supportsImages && snapshot.draft.images.length < 4) {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "teti-task-add-image";
    add.append(
      createElement(ImagePlus, { width: 18, height: 18, "aria-hidden": "true" }),
      document.createTextNode(` ${messages.addImages}`)
    );
    add.disabled = snapshot.busy;
    add.addEventListener("click", () => void controller.attachImages(
      i18n.messages.nativeDialogs.taskImages
    ));
    attachments.append(add);
  }

  const footer = document.createElement("div");
  footer.className = "teti-task-actionbar";
  const hint = document.createElement("small");
  hint.textContent = snapshot.draft.executionMode === "long_horizon"
    ? messages.hints.longHorizon
    : selectedOffer?.compute
    ? messages.hints.localCompute
    : requiresImageOutput
    ? supportsImages ? messages.hints.imageResultWithInput : messages.hints.imageResult
    : supportsImages ? messages.hints.images : messages.hints.textOnly;
  const send = document.createElement("button");
  send.type = "submit";
  send.className = "teti-task-primary";
  send.textContent = snapshot.busy ? messages.sending : messages.send;
  send.disabled = snapshot.busy
    || !selectedPeer
    || !selectedCapability
    || !snapshot.draft.text.trim()
    || (snapshot.draft.executionMode === "long_horizon" && requiresImageOutput)
    || (snapshot.draft.images.length > 0 && !supportsImages);
  const syncSendState = (): void => {
    controller.updateDraft({ text: prompt.value });
    send.disabled = !controller.canSendDraft()
      || (snapshot.draft.executionMode === "long_horizon" && requiresImageOutput)
      || (snapshot.draft.images.length > 0 && !supportsImages);
  };
  prompt.addEventListener("input", syncSendState);
  footer.append(hint, send);
  form.append(selectors, prompt, attachments);
  if (snapshot.draft.images.length >= 2) {
    const warning = document.createElement("p");
    warning.className = "teti-task-known-defect";
    warning.setAttribute("role", "status");
    warning.textContent = messages.multiImageWarning;
    form.append(warning);
  }
  if (snapshot.errorCode) form.append(errorText(taskErrorMessage(snapshot.errorCode, i18n)));
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
  memoryController?: MemoryController,
  i18n: DesktopI18n = createDesktopI18n("zh-Hans")
): HTMLElement {
  const record = snapshot.selectedTask!;
  const messages = i18n.messages.tasks.detail;
  const content = document.createElement("div");
  content.className = "teti-task-scroll teti-task-detail";
  content.dataset.scrollKey = `task-detail:${record.request.taskId}`;
  const identity = document.createElement("div");
  identity.className = "teti-task-detail-head";
  const peer = document.createElement("div");
  const peerTitle = document.createElement("strong");
  peerTitle.textContent = taskPeerHeading(
    record.direction,
    record.peerTetiId,
    record.createdAt,
    connections,
    i18n
  );
  const capability = document.createElement("small");
  capability.textContent = record.request.offerId === "local.compute.general-text-assistance.v1"
    ? messages.localComputeOffer
    : record.request.offerId === "local.agent.osaurus-native-text.v1"
      ? messages.osaurusOffer
      : formatMessage(messages.capability, { capability: record.request.capabilityId });
  peer.append(peerTitle, capability);
  const status = document.createElement("span");
  status.className = `teti-task-status is-${record.state}`;
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = detailStatusLabel(record, i18n);
  identity.append(peer, status);

  const prompt = document.createElement("section");
  prompt.className = "teti-task-card";
  const promptTitle = document.createElement("strong");
  promptTitle.textContent = messages.fullTask;
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
      if (path) gallery.append(imagePreview(path, image.attachmentId, i18n));
      else {
        const pending = document.createElement("span");
        pending.className = "teti-task-image-pending";
        pending.textContent = record.attachmentsReady === false
          ? formatMessage(messages.imageReceiving, {
              received: i18n.formatNumber(receivedInputImages),
              total: i18n.formatNumber(images.length)
            })
          : messages.imageUnavailable;
        gallery.append(pending);
      }
    }
    prompt.append(gallery);
  }
  content.append(identity);
  if (record.latestAttentionChange) {
    const latest = document.createElement("section");
    latest.className = "teti-task-scope teti-task-latest-change";
    const latestTitle = document.createElement("strong");
    latestTitle.textContent = messages.latestChangeTitle;
    const latestDetail = document.createElement("span");
    const changeLabel = messages.latestChanges[record.latestAttentionChange.kind];
    const stagedLabel = record.latestAttentionChange.stageIndex
      ? formatMessage(messages.latestChangeStage, {
          change: changeLabel,
          stage: i18n.formatNumber(record.latestAttentionChange.stageIndex)
        })
      : changeLabel;
    latestDetail.textContent = formatMessage(messages.latestChangeAt, {
      change: stagedLabel,
      date: formatShortTimestamp(record.latestAttentionChange.occurredAt, i18n)
    });
    latest.append(latestTitle, latestDetail);
    content.append(latest);
  }
  content.append(prompt);

  if (snapshot.selectedExecution) {
    const execution = document.createElement("section");
    execution.className = "teti-task-scope teti-task-execution";
    const title = document.createElement("strong");
    title.textContent = formatMessage(messages.localExecution, {
      epoch: i18n.formatNumber(snapshot.selectedExecution.executionEpoch)
    });
    const detail = document.createElement("span");
    detail.textContent = executionProgressLabel(snapshot.selectedExecution.progress.state, i18n);
    execution.append(title, detail);
    content.append(execution);
  }

  if (record.longHorizon || record.peerLongHorizon) {
    content.append(createLongHorizonSection(controller, snapshot, i18n));
  }

  if (record.direction === "incoming"
    && record.approval === "pending"
    && record.request.executionMode === "long_horizon"
    && snapshot.delegationTargets.length > 0) {
    content.append(createDelegationApprovalSection(controller, snapshot, i18n));
  }

  if (record.direction === "incoming" && record.approval === "pending") {
    const scope = document.createElement("section");
    scope.className = "teti-task-scope";
    const ongoing = record.request.executionMode === "long_horizon";
    const executionAgent = localAgentForTask(localPassport, record.request.capabilityId, images.length > 0);
    const scopeTitle = document.createElement("strong");
    scopeTitle.textContent = record.state === "auth_required"
      ? ongoing
        ? messages.authorization.ongoingLoginTitle
        : messages.authorization.loginTitle
      : executionAgent
        ? formatMessage(
            ongoing
              ? messages.authorization.ongoingAgentTitle
              : messages.authorization.agentTitle,
            { agent: executionAgent.name }
          )
        : ongoing
          ? messages.authorization.ongoingTitle
          : messages.authorization.onceTitle;
    const scopeDetail = document.createElement("span");
    scopeDetail.textContent = record.state === "auth_required"
      ? messages.authorization.loginDetail
      : ongoing
        ? messages.authorization.ongoingDetail
        : record.request.offerId === "local.compute.general-text-assistance.v1"
        ? messages.authorization.localComputeDetail
        : record.request.offerId === "local.agent.osaurus-native-text.v1"
          ? messages.authorization.osaurusDetail
          : messages.authorization.defaultDetail;
    scope.append(scopeTitle, scopeDetail);
    content.append(scope);
  }

  const sourceArtifacts = record.artifacts ?? [];
  for (const artifact of taskArtifactsForDisplay(record)) {
    const artifactIndex = sourceArtifacts.findIndex((candidate) =>
      candidate.artifactId === artifact.artifactId
    );
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
      ? delegationArtifactTitle(delegationEntry, record.delegationPlan!, i18n)
      : formatMessage(messages.artifact.title, {
          role: isFinal ? messages.artifact.final : messages.artifact.intermediate,
          stage: i18n.formatNumber(
            localEntry?.stageIndex ?? peerEntry?.stageIndex ?? artifactIndex + 1
          )
        });
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
        if (path) {
          gallery.append(artifactImagePreview(controller, path, image.attachmentId, i18n));
        }
        else {
          const pending = document.createElement("span");
          pending.className = "teti-task-image-pending";
          pending.textContent = messages.artifact.resultImageReceiving;
          gallery.append(pending);
        }
      }
      card.append(gallery);
    }
    content.append(card);
  }
  if (memoryController
    && snapshot.selectedExecution
    && record.request.executionMode !== "long_horizon") {
    content.append(createTaskMemorySection(memoryController, snapshot, i18n));
  }
  if (record.safeErrorCode) {
    const code = document.createElement("p");
    code.className = "teti-task-safe-code";
    code.textContent = formatMessage(messages.safeCode, { code: record.safeErrorCode });
    content.append(code);
  }
  if (snapshot.errorCode) content.append(errorText(taskErrorMessage(snapshot.errorCode, i18n)));

  const actions = document.createElement("div");
  actions.className = "teti-task-actionbar is-detail";
  if (record.direction === "incoming" && record.approval === "pending") {
    const ongoing = record.request.executionMode === "long_horizon";
    const reject = actionButton(messages.actions.reject, "secondary", () => void controller.reject());
    const allow = actionButton(
      record.state === "auth_required"
        ? ongoing
          ? messages.actions.retryOngoingAfterLogin
          : messages.actions.retryAfterLogin
        : ongoing
          ? messages.actions.allowOngoing
          : messages.actions.allowOnce,
      "primary",
      () => void controller.approve()
    );
    reject.disabled = snapshot.busy;
    allow.disabled = snapshot.busy || record.attachmentsReady === false;
    actions.append(reject, allow);
  } else if (record.direction === "incoming"
    && record.state === "input_required"
    && snapshot.selectedExecution?.resumeCapability === "checkpoint_restart") {
    const resume = actionButton(
      messages.actions.resumeCheckpoint,
      "primary",
      () => void controller.resume()
    );
    resume.disabled = snapshot.busy;
    actions.append(resume);
  } else if (!["completed", "failed", "canceled", "rejected", "input_required"].includes(record.state)) {
    const cancel = actionButton(
      record.direction === "incoming" ? messages.actions.stop : messages.actions.cancel,
      "secondary",
      () => void controller.cancel()
    );
    cancel.disabled = snapshot.busy || Boolean(record.cancelPending);
    actions.append(cancel);
  }
  content.append(actions);
  return content;
}

function createLongHorizonSection(
  controller: TaskController,
  snapshot: TaskControllerSnapshot,
  i18n: DesktopI18n
): HTMLElement {
  const messages = i18n.messages.tasks.longHorizon;
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
    ? formatMessage(messages.delegationTitle, {
        current: i18n.formatNumber(delegation.currentStepIndex),
        total: i18n.formatNumber(delegation.maximumChildCalls + 1)
      })
    : formatMessage(messages.collaborationTitle, { stage: i18n.formatNumber(stageIndex) });
  const state = document.createElement("span");
  state.textContent = longHorizonPhaseLabel(phase, i18n);
  heading.append(title, state);
  const meta = document.createElement("p");
  meta.textContent = formatMessage(messages.workspaceExpiry, {
    revision: i18n.formatNumber(workspaceRevision),
    date: formatShortTimestamp(
      local?.continuationExpiresAt ?? peer?.continuationExpiresAt ?? record.request.expiresAt,
      i18n
    )
  });
  section.append(heading, meta);

  if (record.direction === "incoming" && local) {
    section.append(createStructuredTaskMemoryStatus(controller, snapshot, i18n));
  }

  if (delegation) {
    const boundary = document.createElement("p");
    boundary.className = "teti-task-delegation-boundary";
    boundary.textContent = messages.boundary;
    section.append(boundary);

    const planSteps = document.createElement("ol");
    planSteps.className = "teti-task-stage-list teti-task-delegation-plan";
    for (const step of delegation.steps) {
      const item = document.createElement("li");
      const label = document.createElement("strong");
      const detail = document.createElement("span");
      if (step.kind === "child_execution") {
        label.textContent = formatMessage(messages.childStep, {
          step: i18n.formatNumber(step.stepIndex),
          agent: step.childAgentId
        });
        detail.textContent = `${step.capabilityId} · ${step.resourceBindingId} · ${delegationStepStateLabel(
          step.state,
          i18n
        )}`;
        const budget = document.createElement("small");
        budget.textContent = formatMessage(messages.budget, {
          revision: i18n.formatNumber(step.workspaceRevision),
          seconds: i18n.formatNumber(Math.round(step.budget.timeoutMs / 1_000)),
          kib: i18n.formatNumber(Math.round(step.budget.maxOutputBytes / 1_024))
        });
        item.append(label, detail, budget);
      } else {
        label.textContent = formatMessage(messages.hostStep, {
          step: i18n.formatNumber(step.stepIndex)
        });
        detail.textContent = formatMessage(messages.aggregationDetail, {
          state: delegationStepStateLabel(step.state, i18n)
        });
        item.append(label, detail);
      }
      planSteps.append(item);
    }
    section.append(planSteps);
  }

  if (progress || peer) {
    const status = document.createElement("p");
    status.className = "teti-task-long-horizon-progress";
    status.setAttribute("role", "status");
    status.textContent = longHorizonProgressLabel({
      state: progress?.state,
      phase,
      stageIndex,
      completedUnits: progress?.completedUnits ?? peer?.completedUnits ?? null,
      totalUnits: progress?.totalUnits ?? peer?.totalUnits ?? null
    }, i18n);
    section.append(status);
  }

  if (local?.stages.length) {
    const stages = document.createElement("ol");
    stages.className = "teti-task-stage-list";
    for (const stage of local.stages) {
      const item = document.createElement("li");
      const label = document.createElement("strong");
      label.textContent = formatMessage(messages.stage, {
        stage: i18n.formatNumber(stage.stageIndex),
        agent: stage.childAgentId
      });
      const detail = document.createElement("span");
      detail.textContent = `${longHorizonPhaseLabel(stage.state, i18n)} · Workspace r${i18n.formatNumber(
        stage.workspaceRevision
      )}`;
      item.append(label, detail);
      stages.append(item);
    }
    section.append(stages);
  }

  if (record.direction === "outgoing" && record.state === "input_required") {
    if ((record.peerLongHorizon?.currentStageIndex ?? 0) >= LONG_HORIZON_LIMITS.maximumStages) {
      const limit = document.createElement("p");
      limit.className = "teti-task-stage-limit";
      limit.textContent = messages.stageLimitReached;
      section.append(limit);
    } else {
      const form = document.createElement("form");
      form.className = "teti-task-stage-input";
      const input = document.createElement("textarea");
      const inputLocked = snapshot.busy || Boolean(record.inputPending);
      input.maxLength = 6_000;
      input.placeholder = messages.nextInstructionPlaceholder;
      input.setAttribute("aria-label", messages.nextInstructionLabel);
      input.value = record.inputPending?.instruction ?? "";
      input.disabled = inputLocked;
      const submit = actionButton(
        record.inputPending ? messages.instructionPending : messages.sendInstruction,
        "primary",
        () => undefined
      );
      submit.type = "submit";
      submit.disabled = inputLocked;
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        if (!input.disabled && input.value.trim()) void controller.submitInput(input.value);
      });
      form.append(input, submit);
      section.append(form);
    }
  }

  if (record.direction === "incoming" && local && !delegation) {
    const controls = document.createElement("div");
    controls.className = "teti-task-stage-controls";
    if (phase === "working") {
      controls.append(actionButton(
        local.pauseRequested ? messages.pauseRequested : messages.pauseAfterStage,
        "secondary",
        () => void controller.pause()
      ));
    }
    if ((phase === "input_required" || phase === "paused") && local.pendingInput) {
      const instruction = document.createElement("p");
      instruction.className = "teti-task-stage-instruction";
      instruction.textContent = formatMessage(messages.supplementalInstruction, {
        instruction: local.pendingInput.instruction
      });
      section.append(instruction);
      const child = labeledSelect(messages.continueWithAgent, local.availableChildAgents.map((target) => ({
        value: target.childAgentId,
        label: `${target.childAgentId} · ${target.connectorId}`
      })), local.stages.at(-1)?.childAgentId ?? local.availableChildAgents[0]?.childAgentId ?? "", i18n);
      controls.append(child.label, actionButton(messages.startNextStage, "primary", () => {
        void controller.continue(child.select.value || undefined);
      }));
    }
    if ((phase === "input_required" || phase === "paused") && local.artifacts.length > 0 && !local.pendingInput) {
      controls.append(actionButton(
        messages.acceptCurrentResult,
        "primary",
        () => void controller.complete()
      ));
    }
    if (phase === "input_required" || phase === "paused") {
      const renew = actionButton(
        snapshot.renewalStatus?.state === "pending" ? messages.renewing : messages.renewOneHour,
        "secondary",
        () => void controller.renew()
      );
      renew.disabled = snapshot.busy;
      controls.append(renew);
    }
    section.append(controls);
    if (snapshot.renewalStatus?.state === "success" && snapshot.renewalStatus.expiresAt) {
      const renewal = document.createElement("p");
      renewal.className = "teti-task-renewal-status is-success";
      renewal.setAttribute("role", "status");
      renewal.textContent = formatMessage(messages.renewedUntil, {
        date: formatShortTimestamp(snapshot.renewalStatus.expiresAt, i18n)
      });
      section.append(renewal);
    } else if (snapshot.renewalStatus?.state === "error") {
      const renewal = document.createElement("p");
      renewal.className = "teti-task-renewal-status is-error";
      renewal.setAttribute("role", "alert");
      renewal.textContent = messages.renewFailed;
      section.append(renewal);
    }

    const audit = document.createElement("details");
    audit.className = "teti-task-audit";
    const summary = document.createElement("summary");
    summary.textContent = i18n.formatPlural(local.audit.length, messages.recoveryAudit);
    const list = document.createElement("ol");
    for (const event of [...local.audit].reverse()) {
      const item = document.createElement("li");
      item.textContent = `${formatShortTimestamp(event.timestamp, i18n)} · ${longHorizonAuditActionLabel(
        event.action,
        i18n
      )}${
        event.stageIndex
          ? ` · ${formatMessage(messages.auditStage, { stage: i18n.formatNumber(event.stageIndex) })}`
          : ""
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
    summary.textContent = i18n.formatPlural(delegation.audit.length, messages.delegationAudit);
    const list = document.createElement("ol");
    for (const event of [...delegation.audit].reverse()) {
      const item = document.createElement("li");
      item.textContent = `${formatShortTimestamp(event.timestamp, i18n)} · ${delegationAuditActionLabel(
        event.action,
        i18n
      )}${
        event.stepId ? ` · ${event.stepId}` : ""
      }`;
      list.append(item);
    }
    audit.append(summary, list);
    section.append(audit);
  }
  return section;
}

function createStructuredTaskMemoryStatus(
  controller: TaskController,
  snapshot: TaskControllerSnapshot,
  i18n: DesktopI18n
): HTMLElement {
  const messages = i18n.messages.tasks.longHorizon.structuredMemory;
  const memory = snapshot.selectedStructuredMemory;
  const container = document.createElement("details");
  container.className = "teti-task-structured-memory";
  container.open = snapshot.structuredMemoryExpanded;
  const disclosure = document.createElement("summary");
  disclosure.className = "teti-task-structured-memory-summary";
  const disclosureCopy = document.createElement("span");
  const title = document.createElement("strong");
  title.textContent = messages.title;
  const note = document.createElement("small");
  note.textContent = messages.automaticNote;
  disclosureCopy.append(title, note);
  const disclosureState = document.createElement("span");
  disclosureState.className = "teti-task-structured-memory-state";
  disclosureState.textContent = memory?.status === "unavailable"
    ? messages.collapsedUnavailable
    : formatMessage(messages.collapsedOn, {
        count: i18n.formatNumber(memory?.recordCount ?? 0)
      });
  disclosure.append(disclosureCopy, disclosureState);
  container.addEventListener("toggle", () => {
    controller.setStructuredMemoryExpanded(container.open);
  });
  const body = document.createElement("div");
  body.className = "teti-task-structured-memory-body";
  const state = document.createElement("p");
  state.setAttribute("role", "status");
  state.textContent = !memory
    ? messages.loading
    : memory.status === "unavailable"
      ? messages.unavailable
      : memory.status === "read_only"
        ? formatMessage(messages.readOnly, { count: i18n.formatNumber(memory.recordCount) })
        : formatMessage(messages.ready, { count: i18n.formatNumber(memory.recordCount) });
  body.append(state);
  const boundary = document.createElement("p");
  boundary.className = "teti-task-memory-boundary";
  boundary.textContent = messages.currentTaskOnly;
  body.append(boundary);
  container.append(disclosure, body);
  if (memory && memory.status !== "unavailable" && memory.records.length > 0) {
    const records = document.createElement("ol");
    records.className = "teti-task-stage-list teti-task-memory-sources";
    for (const record of memory.records.slice(0, 4)) {
      const item = document.createElement("li");
      const copy = document.createElement("span");
      const label = document.createElement("strong");
      label.textContent = formatMessage(messages.stage, {
        stage: i18n.formatNumber(record.stageIndex),
        agent: record.childAgentId
      });
      const sourcePreview = document.createElement("span");
      sourcePreview.textContent = record.contentPreview;
      copy.append(label, sourcePreview);
      item.append(copy);
      records.append(item);
    }
    body.append(records);
  }
  return container;
}

function createDelegationApprovalSection(
  controller: TaskController,
  snapshot: TaskControllerSnapshot,
  i18n: DesktopI18n
): HTMLElement {
  const messages = i18n.messages.tasks.longHorizon.approval;
  const section = document.createElement("section");
  section.className = "teti-task-card teti-task-delegation-approval";
  const heading = document.createElement("div");
  heading.className = "teti-task-delegation-heading";
  const title = document.createElement("strong");
  title.textContent = messages.title;
  const badge = document.createElement("span");
  badge.textContent = messages.plannerDisabled;
  heading.append(title, badge);
  const note = document.createElement("p");
  note.textContent = messages.note;
  const steps = document.createElement("ol");
  steps.className = "teti-task-delegation-editor";
  for (const [index, selection] of snapshot.delegationSelections.entries()) {
    const item = document.createElement("li");
    const target = labeledSelect(formatMessage(messages.step, {
      step: i18n.formatNumber(index + 1)
    }), snapshot.delegationTargets.map((candidate) => ({
      value: delegationTargetKey(candidate),
      label: `${candidate.childAgentId} · ${candidate.capabilityId}`
    })), delegationTargetKey(selection), i18n);
    target.select.disabled = snapshot.busy;
    target.select.addEventListener("change", () => controller.setDelegationStep(index, target.select.value));
    const selectedTarget = snapshot.delegationTargets.find((candidate) =>
      delegationTargetKey(candidate) === delegationTargetKey(selection)
    );
    const detail = document.createElement("small");
    detail.textContent = selectedTarget
      ? `${selectedTarget.resourceBindingId} · ${workspacePolicyLabel(
          selectedTarget.workspacePolicy,
          i18n
        )} · ${i18n.formatNumber(Math.round(selectedTarget.timeoutMs / 1_000))}s`
      : messages.targetUnavailable;
    const remove = actionButton(messages.remove, "secondary", () => controller.removeDelegationStep(index));
    remove.disabled = snapshot.busy || snapshot.delegationSelections.length <= 1;
    remove.setAttribute("aria-label", formatMessage(messages.removeLabel, {
      step: i18n.formatNumber(index + 1)
    }));
    item.append(target.label, detail, remove);
    steps.append(item);
  }
  const controls = document.createElement("div");
  controls.className = "teti-task-delegation-controls";
  const add = actionButton(messages.add, "secondary", () => controller.addDelegationStep());
  add.disabled = snapshot.busy
    || snapshot.delegationSelections.length >= 4
    || snapshot.delegationTargets.length === 0;
  const approve = actionButton(messages.approve, "primary", () => void controller.approveDelegation());
  approve.disabled = snapshot.busy
    || snapshot.selectedTask?.attachmentsReady === false
    || snapshot.delegationSelections.length === 0;
  controls.append(add, approve);
  section.append(heading, note, steps, controls);
  return section;
}

function delegationArtifactTitle(
  entry: DelegationArtifactProvenance,
  plan: DelegationPlanState,
  i18n: DesktopI18n
): string {
  const messages = i18n.messages.tasks.detail.artifact;
  if (entry.producer.kind === "teti_host") {
    return formatMessage(messages.hostFinal, {
      revision: i18n.formatNumber(entry.workspaceRevision)
    });
  }
  const step = plan.steps.find((candidate) => candidate.stepId === entry.stepId);
  return formatMessage(messages.childIntermediate, {
    step: step ? i18n.formatNumber(step.stepIndex) : "?",
    agent: entry.producer.childAgentId,
    resource: entry.producer.resourceBindingId,
    revision: i18n.formatNumber(entry.workspaceRevision)
  });
}

function delegationStepStateLabel(state: DelegationStepState, i18n: DesktopI18n): string {
  return i18n.messages.tasks.longHorizon.delegationStepStates[state];
}

function workspacePolicyLabel(
  policy: "snapshot" | "bounded_context" | "none",
  i18n: DesktopI18n
): string {
  return i18n.messages.tasks.longHorizon.workspacePolicies[policy];
}

function createTaskMemorySection(
  controller: MemoryController,
  snapshot: TaskControllerSnapshot,
  i18n: DesktopI18n
): HTMLElement {
  const messages = i18n.messages.memory;
  const record = snapshot.selectedTask!;
  const execution = snapshot.selectedExecution!;
  const memory = controller.snapshot;
  const section = document.createElement("section");
  section.className = "teti-task-card teti-task-memory";
  const title = document.createElement("strong");
  title.textContent = messages.title;
  const note = document.createElement("p");
  note.textContent = messages.task.note;
  section.append(title, note);

  if (record.direction !== "incoming" || record.state !== "completed" || !taskHasTextArtifact(record)) {
    const unavailable = document.createElement("small");
    unavailable.textContent = messages.task.unavailable;
    section.append(unavailable);
    return section;
  }

  section.append(createTaskMemoryScopeRow({
    controller,
    taskId: record.request.taskId,
    scope: "child_agent",
    workspaceId: null,
    childAgentId: execution.childAgentId,
    label: formatMessage(messages.task.childLabel, { agent: execution.childAgentId }),
    description: messages.task.childDescription,
    i18n
  }));

  if (record.workspaceBinding?.mode === "durable_collaboration") {
    section.append(createTaskMemoryScopeRow({
      controller,
      taskId: record.request.taskId,
      scope: "workspace",
      workspaceId: record.workspaceBinding.workspaceId,
      childAgentId: execution.childAgentId,
      label: messages.task.workspaceLabel,
      description: messages.task.workspaceDescription,
      i18n
    }));
  }
  if (memory.errorCode) {
    const error = document.createElement("small");
    error.className = "teti-memory-error";
    error.setAttribute("role", "alert");
    error.textContent = memoryErrorMessage(memory.errorCode, i18n);
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
  i18n: DesktopI18n;
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
  toggle.setAttribute("aria-label", formatMessage(
    input.i18n.messages.memory.task.authorizationLabel,
    { label: input.label }
  ));
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
  save.textContent = saved
    ? input.i18n.messages.memory.task.saved
    : input.i18n.messages.memory.task.saveResult;
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

export function executionProgressLabel(state: string, i18n: DesktopI18n): string {
  const messages = i18n.messages.tasks.executionProgress;
  return Object.hasOwn(messages, state)
    ? messages[state as keyof typeof messages]
    : messages.unknown;
}

export function longHorizonProgressLabel(input: {
  state?: string;
  phase: string;
  stageIndex: number;
  completedUnits: number | null;
  totalUnits: number | null;
}, i18n: DesktopI18n): string {
  const messages = i18n.messages.tasks.longHorizon.progress;
  const state = normalizedProgressState(input.state, input.phase);
  return formatMessage(messages[state], {
    stage: i18n.formatNumber(input.stageIndex),
    completed: input.completedUnits === null ? "–" : i18n.formatNumber(input.completedUnits),
    total: input.totalUnits === null ? "–" : i18n.formatNumber(input.totalUnits)
  });
}

function normalizedProgressState(
  state: string | undefined,
  phase: string
): keyof DesktopI18n["messages"]["tasks"]["longHorizon"]["progress"] {
  const known = new Set([
    "queued",
    "running",
    "paused",
    "interrupted",
    "canceling",
    "canceled",
    "completed",
    "failed"
  ]);
  if (state && known.has(state)) {
    return state as keyof DesktopI18n["messages"]["tasks"]["longHorizon"]["progress"];
  }
  if (phase === "pending_approval") return "queued";
  if (phase === "working") return "running";
  if (phase === "input_required" || phase === "paused") return "paused";
  if (phase === "completed") return "completed";
  if (phase === "failed") return "failed";
  if (phase === "canceled" || phase === "expired") return "canceled";
  return "unknown";
}

function longHorizonAuditActionLabel(
  action: NonNullable<NonNullable<TaskControllerSnapshot["selectedTask"]>["longHorizon"]>["audit"][number]["action"],
  i18n: DesktopI18n
): string {
  return i18n.messages.tasks.longHorizon.auditActions[action];
}

function delegationAuditActionLabel(
  action: DelegationPlanState["audit"][number]["action"],
  i18n: DesktopI18n
): string {
  return i18n.messages.tasks.longHorizon.delegationAuditActions[action];
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

export function capabilityRequiresImageOutput(
  connection: PassportConnectionSnapshot,
  capabilityId: string
): boolean {
  const capability = connection.passport.capabilities.find((candidate) => candidate.id === capabilityId);
  if (capability?.category === "image") return true;
  const agentIds = new Set(connection.passport.bindings
    .filter((binding) => binding.capabilityId === capabilityId)
    .flatMap((binding) => binding.agentIds));
  return connection.passport.agents.some((agent) =>
    isCallableAgent(agent)
    && agentIds.has(agent.id)
    && agent.capabilityIds.includes(capabilityId)
    && agent.outputModes.includes("image")
    && !agent.outputModes.includes("text")
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
  selected: string,
  i18n: DesktopI18n
): { label: HTMLLabelElement; select: HTMLSelectElement } {
  const label = document.createElement("label");
  label.className = "teti-task-select-label";
  const caption = document.createElement("span");
  caption.textContent = title;
  const select = document.createElement("select");
  select.className = "teti-task-select";
  if (options.length === 0) {
    const option = document.createElement("option");
    option.textContent = i18n.messages.tasks.composer.noCapabilities;
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

function imagePreview(
  path: string,
  attachmentId: string,
  i18n: DesktopI18n,
  remove?: () => void
): HTMLElement {
  const item = document.createElement("figure");
  item.className = "teti-task-image";
  const image = document.createElement("img");
  image.src = safeAssetUrl(path);
  image.alt = i18n.messages.tasks.images.alt;
  image.loading = "lazy";
  item.append(image);
  if (remove) {
    const button = iconButton(X, i18n.messages.tasks.images.remove, remove);
    button.classList.add("teti-task-image-remove");
    item.append(button);
  }
  item.dataset.attachmentId = attachmentId;
  return item;
}

function artifactImagePreview(
  controller: TaskController,
  path: string,
  attachmentId: string,
  i18n: DesktopI18n
): HTMLElement {
  const item = imagePreview(path, attachmentId, i18n);
  item.classList.add("is-artifact");
  const actions = document.createElement("figcaption");
  actions.className = "teti-task-image-actions";
  actions.append(
    iconButton(
      ExternalLink,
      i18n.messages.tasks.images.open,
      () => void controller.openResultImage(path)
    ),
    iconButton(
      FolderOpen,
      i18n.messages.tasks.images.reveal,
      () => void controller.revealResultImage(path)
    ),
    iconButton(
      Download,
      i18n.messages.tasks.images.saveAs,
      () => void controller.saveResultImage(path, i18n.messages.nativeDialogs.taskImages)
    )
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
  error.setAttribute("role", "alert");
  error.textContent = message;
  return error;
}

export function taskStatusLabel(
  task: TaskControllerSnapshot["summary"]["tasks"][number],
  i18n: DesktopI18n
): string {
  const messages = i18n.messages.tasks.status;
  if (task.cancelPending) return messages.canceling;
  if (task.state === "auth_required") return messages.agentLogin;
  if (task.direction === "incoming" && task.approval === "pending") {
    return task.attachmentsReady ? messages.awaitingConfirmation : messages.receivingImages;
  }
  if (task.direction === "outgoing" && task.state === "submitted") return messages.awaitingPeer;
  if (task.direction === "outgoing" && task.state === "completed" && task.artifactCount === 0) {
    return messages.resultReceiving;
  }
  return stateLabel(task.state, i18n);
}

export function taskModeLabel(
  task: TaskControllerSnapshot["summary"]["tasks"][number],
  i18n: DesktopI18n
): string {
  const messages = i18n.messages.tasks.inbox;
  if (task.executionMode !== "long_horizon") return messages.singleStage;
  return task.currentStageIndex && task.currentStageIndex > 0
    ? formatMessage(messages.longHorizonStage, {
        stage: i18n.formatNumber(task.currentStageIndex)
      })
    : messages.longHorizon;
}

export function taskArtifactsForDisplay(
  record: NonNullable<TaskControllerSnapshot["selectedTask"]>
): CollaborationTaskArtifact[] {
  const artifacts = [...(record.artifacts ?? [])];
  return record.direction === "outgoing" && record.request.executionMode === "long_horizon"
    ? artifacts.reverse()
    : artifacts;
}

export function detailStatusLabel(
  record: NonNullable<TaskControllerSnapshot["selectedTask"]>,
  i18n: DesktopI18n
): string {
  const messages = i18n.messages.tasks.status;
  if (record.cancelPending) return messages.canceling;
  if (record.state === "auth_required") return messages.agentLogin;
  if (record.direction === "incoming" && record.approval === "pending") {
    return record.attachmentsReady === false
      ? messages.receivingImages
      : messages.awaitingConfirmation;
  }
  if (record.direction === "outgoing" && record.state === "submitted") return messages.awaitingPeer;
  if (record.direction === "outgoing" && record.state === "completed"
    && (!(record.artifacts?.length) || record.artifactAttachmentsReady === false)) {
    return messages.resultReceiving;
  }
  return stateLabel(record.state, i18n);
}

export function stateLabel(state: string, i18n: DesktopI18n): string {
  const messages = i18n.messages.tasks.status;
  return Object.hasOwn(messages.states, state)
    ? messages.states[state as keyof typeof messages.states]
    : messages.unknown;
}

export function longHorizonPhaseLabel(phase: string, i18n: DesktopI18n): string {
  const messages = i18n.messages.tasks.longHorizon.phase;
  return Object.hasOwn(messages, phase)
    ? messages[phase as keyof typeof messages]
    : messages.unknown;
}

function formatShortTimestamp(value: string, i18n: DesktopI18n): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return i18n.messages.tasks.peerHeading.invalidTime;
  return i18n.formatDateTime(date, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
}

function shortTetiId(tetiId: string): string {
  return tetiId.replace(/^teti_/, "");
}

export function taskPeerHeading(
  direction: "incoming" | "outgoing",
  peerTetiId: string,
  createdAt: string,
  connections: readonly PassportConnectionSnapshot[],
  i18n: DesktopI18n = createDesktopI18n("zh-Hans")
): string {
  const connection = connections.find((candidate) => candidate.identity.tetiId === peerTetiId);
  const name = connection?.identity.displayName?.trim() || shortTetiId(peerTetiId);
  return formatMessage(i18n.messages.tasks.peerHeading[direction], {
    name,
    date: formatTaskTimestamp(createdAt, i18n)
  });
}

export function formatTaskTimestamp(
  value: string,
  i18n: DesktopI18n = createDesktopI18n("zh-Hans")
): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return i18n.messages.tasks.peerHeading.invalidTime;
  return i18n.formatDateTime(date, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
}

export function taskComposeRenderKey(snapshot: TaskControllerSnapshot): string {
  return JSON.stringify({
    connectionRequestId: snapshot.draft.connectionRequestId,
    capabilityId: snapshot.draft.capabilityId,
    executionMode: snapshot.draft.executionMode,
    imageIds: snapshot.draft.images.map((image) => image.part.attachmentId),
    busy: snapshot.busy,
    errorCode: snapshot.errorCode ?? ""
  });
}

export function taskErrorMessage(code: TaskUiErrorCode, i18n: DesktopI18n): string {
  return i18n.messages.tasks.errors[code];
}
