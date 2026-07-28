import { FirstLaunchCoordinator } from "./first-launch/coordinator.ts";
import { Check, ClipboardList, Link2, X, createElement } from "lucide";
import { countUnicodeCharacters, truncateTetiDisplayName } from "../../../core/account/display-name.ts";
import type { PassportConnectionSnapshot } from "../../../core/passport/snapshot.ts";
import type { FirstLaunchSnapshot } from "./first-launch/state-machine.ts";
import { toFirstLaunchViewModel, type FirstLaunchViewModel } from "./first-launch/view-model.ts";
import { createDesktopAccountLifecycle } from "./provisioning/index.ts";
import { readProvisioningMode, type ProvisioningModeConfig } from "./provisioning/modes.ts";
import { TauriNotchWindowController, visualModeForViewModel } from "./platform/tauri-notch-window.ts";
import type { TauriInvoker } from "./platform/tauri-api.ts";
import { DockActivationGuard } from "./platform/dock-activation-guard.ts";
import {
  LifecycleBridgeClient
} from "./provisioning/bridge-lifecycle.ts";
import {
  BridgePeerConnectionClient,
  MockPeerConnectionClient,
  PeerConnectionController,
  type PeerConnectionSnapshot
} from "./connections/controller.ts";
import { CONNECT_PANEL_PLACEHOLDER } from "./connections/connect-panel-state.ts";
import {
  createRemoteTetiAvatar
} from "./connections/remote-teti-avatar.ts";
import {
  BridgePassportClient,
  MockPassportClient,
  PassportController,
  emptyPassportSnapshot,
  type PassportControllerSnapshot
} from "./passport/controller.ts";
import {
  createAiPassportPanel,
  createPassportSettingsPanel,
  createRemotePassport
} from "./passport/view.ts";
import {
  toPassportViewModel,
  type ConnectionCardViewModel
} from "./passport/view-model.ts";
import { emptyAgentManagementSnapshot } from "../../../core/observation/management.ts";
import {
  createTetiBotBrandLink,
  TETI_BOT_OPENING_EVENT,
  TETI_BOT_OPEN_SETTLED_EVENT
} from "./brand/teti-bot-brand-link.ts";
import {
  BridgeTaskClient,
  MockTaskClient,
  TaskController
} from "./tasks/controller.ts";
import { createTaskWorkspace, taskComposeRenderKey } from "./tasks/view.ts";
import "./styles.css";

const aiToolsButtonIconUrl = new URL("../assets/ai-tools-btn.png", import.meta.url).href;
const settingsButtonIconUrl = new URL("../assets/settings.png", import.meta.url).href;

export interface DesktopAppOptions {
  root: HTMLElement;
  tauri: TauriInvoker;
  env: Record<string, string | undefined>;
  schedule?: (callback: () => void, delayMs: number) => unknown;
}

export interface DesktopApp {
  coordinator: FirstLaunchCoordinator;
  connections: PeerConnectionController;
  passport: PassportController;
  tasks: TaskController;
  config: ProvisioningModeConfig;
  render(): void;
  dispose(): void;
}

export function renderDesktopStartupFailure(
  root: HTMLElement,
  env: Record<string, string | undefined>
): void {
  renderSnapshot(
    root,
    {
      state: "fatal_error",
      nameInput: "",
      submitting: false,
      error: {
        kind: "unrecoverable_internal_state",
        message: "本机 Runtime 未能完成启动，请退出 Teti 后重试。",
        recoverable: false,
        diagnosticCode: "RUNTIME-START"
      }
    },
    readProvisioningMode(env, "real")
  );
}

export async function createDesktopApp(options: DesktopAppOptions): Promise<DesktopApp> {
  await syncScreenMetrics(options.tauri, options.root.ownerDocument.documentElement);
  installScreenMetricsSync(options.tauri, options.root.ownerDocument);
  const selection = await createDesktopAccountLifecycle(options.env, options.tauri);
  const notchWindow = new TauriNotchWindowController(options.tauri);
  let app: DesktopApp;
  let disposed = false;
  let stopFocusListener: (() => void) | undefined;
  let stopDockActivateListener: (() => void) | undefined;
  let preserveStateForBrandOpen = false;
  let brandOpenGuardTimer: number | undefined;
  let protocolBlocked = false;
  const dockActivationGuard = new DockActivationGuard();
  const baseSchedule = options.schedule ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const clearBrandOpenGuard = () => {
    preserveStateForBrandOpen = false;
    if (brandOpenGuardTimer !== undefined) {
      options.root.ownerDocument.defaultView?.clearTimeout(brandOpenGuardTimer);
      brandOpenGuardTimer = undefined;
    }
  };
  const handleBrandWebsiteOpening = () => {
    clearBrandOpenGuard();
    preserveStateForBrandOpen = true;
  };
  const handleBrandWebsiteOpenSettled = (event: Event) => {
    const opened = Boolean((event as CustomEvent<{ opened?: boolean }>).detail?.opened);
    if (!opened) {
      clearBrandOpenGuard();
      return;
    }
    if (!preserveStateForBrandOpen) return;
    brandOpenGuardTimer = options.root.ownerDocument.defaultView?.setTimeout(
      clearBrandOpenGuard,
      2_000
    );
  };
  options.root.addEventListener(TETI_BOT_OPENING_EVENT, handleBrandWebsiteOpening);
  options.root.addEventListener(TETI_BOT_OPEN_SETTLED_EVENT, handleBrandWebsiteOpenSettled);
  const coordinator = new FirstLaunchCoordinator({
    accountLifecycle: selection.lifecycle,
    notchWindow,
    discoveryClient: selection.discoveryClient ?? (selection.config.mode === "mock" ? new MockDiscoveryClient() : undefined),
    schedule: (callback, delayMs) =>
      baseSchedule(() => {
        callback();
        app?.render();
      }, delayMs)
  });
  const bridge = selection.config.mode === "real" ? new LifecycleBridgeClient(options.tauri) : undefined;
  const mockPassportClient = selection.config.mode === "mock" ? new MockPassportClient() : undefined;
  let connections: PeerConnectionController;
  const passport = new PassportController({
    client: bridge ? new BridgePassportClient(bridge) : mockPassportClient!,
    onChange: () => {
      connections?.syncPassportConnections(passport.snapshot.passport.connections);
      app?.render();
    },
    schedule: baseSchedule
  });
  connections = new PeerConnectionController({
    client: bridge
      ? new BridgePeerConnectionClient(bridge)
      : new MockPeerConnectionClient((items) => {
          mockPassportClient?.setConnections(items);
        }),
    notchWindow,
    onChange: () => app?.render(),
    refreshPassport: () => passport.refreshAfterMutation()
  });
  const tasks = new TaskController({
    client: bridge ? new BridgeTaskClient(bridge) : new MockTaskClient(),
    tauri: options.tauri,
    notchWindow,
    onChange: () => app?.render(),
    onReturnToIsland: () => {
      passport.closePanel(false);
      connections.open("task-back-to-island");
    },
    schedule: baseSchedule
  });
  if (options.tauri.onFocusChanged) {
    stopFocusListener = await options.tauri.onFocusChanged((focused) => {
      if (protocolBlocked) {
        void notchWindow.setMode("error", "peer-protocol-blocked").catch(() => undefined);
        return;
      }
      if (!focused) {
        if (preserveStateForBrandOpen) {
          clearBrandOpenGuard();
          return;
        }
        if (dockActivationGuard.shouldIgnoreFocusLoss()) return;
        passport.closePanel();
        tasks.dismissFromOutside();
        connections.dismissFromOutside();
      }
    });
  }

  if (options.tauri.onDockActivate) {
    stopDockActivateListener = await options.tauri.onDockActivate(() => {
      if (protocolBlocked) {
        void notchWindow.setMode("error", "peer-protocol-blocked").catch(() => undefined);
        return;
      }
      if (!dockActivationGuard.begin()) return;
      if (!coordinator.snapshot.account) {
        void notchWindow.show("dock-activate");
        return;
      }
      passport.closePanel(false);
      tasks.close("dock-activate-reset", { notify: false, updateWindowMode: false });
      connections.open("dock-activate");
    });
  }

  app = {
    coordinator,
    connections,
    passport,
    tasks,
    config: selection.config,
    render: () => {
      const wasProtocolBlocked = protocolBlocked;
      protocolBlocked = hasBlockingPeerCompatibility(passport.snapshot.passport.connections);
      if (protocolBlocked) {
        void notchWindow.setMode("error", "peer-protocol-blocked").catch(() => undefined);
      } else if (wasProtocolBlocked) {
        const mode = tasks.snapshot.open
          ? "task"
          : connections.snapshot.open
            ? "onboarding"
            : visualModeForViewModel(toFirstLaunchViewModel(coordinator.snapshot));
        void notchWindow.setMode(mode, "peer-protocol-compatible").catch(() => undefined);
      }
      renderSnapshot(options.root, coordinator.snapshot, selection.config, coordinator, connections, passport, tasks);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      stopFocusListener?.();
      stopDockActivateListener?.();
      clearBrandOpenGuard();
      options.root.removeEventListener(TETI_BOT_OPENING_EVENT, handleBrandWebsiteOpening);
      options.root.removeEventListener(TETI_BOT_OPEN_SETTLED_EVENT, handleBrandWebsiteOpenSettled);
      passport.stop();
      tasks.dispose();
      connections.dispose();
    }
  };

  await coordinator.initialize();
  passport.start();
  tasks.start();
  app.render();
  await notchWindow.setMode(visualModeForViewModel(toFirstLaunchViewModel(coordinator.snapshot)), "initial-render");

  return app;
}

export function renderSnapshot(
  root: HTMLElement,
  snapshot: FirstLaunchSnapshot,
  config: ProvisioningModeConfig = readProvisioningMode({}),
  coordinator?: FirstLaunchCoordinator,
  connections?: PeerConnectionController,
  passport?: PassportController,
  tasks?: TaskController
): void {
  const viewModel = toFirstLaunchViewModel(snapshot);
  const blockedPeers = blockingPeerCompatibility(
    passport?.snapshot.passport.connections ?? []
  );
  if (blockedPeers.length > 0) {
    root.className = "teti-shell teti-shell--protocol-blocked";
    root.dataset.protocolBlocked = "true";
    const blockKey = blockedPeers
      .map((connection) => `${connection.identity.tetiId}:${connection.compatibility}`)
      .sort()
      .join("|");
    const existing = root.querySelector<HTMLElement>(".teti-protocol-blocker[data-block-key]");
    if (existing?.dataset.blockKey === blockKey) return;
    root.replaceChildren(createProtocolUpgradeBlocker(blockedPeers, blockKey));
    return;
  }
  delete root.dataset.protocolBlocked;
  const taskSnapshot = tasks?.snapshot;
  const taskOpen = viewModel.panel === "collapsed" && taskSnapshot?.open;
  const peerPanelOpen = viewModel.panel === "collapsed" && connections?.snapshot.open;
  root.className = `teti-shell teti-shell--${taskOpen || peerPanelOpen ? "expanded" : viewModel.panel}`;
  if (taskOpen && taskSnapshot?.screen === "compose") {
    const active = document.activeElement;
    const existing = root.querySelector<HTMLElement>(".teti-task-workspace[data-task-compose-key]");
    if (active instanceof HTMLTextAreaElement
      && active.classList.contains("teti-task-prompt")
      && existing?.dataset.taskComposeKey === taskComposeRenderKey(taskSnapshot)) {
      return;
    }
  }
  root.replaceChildren(
    taskOpen
      ? createTaskWorkspace(
          tasks!,
          passport?.snapshot.passport.connections ?? [],
          passport?.snapshot.passport.localPassport
        )
      : peerPanelOpen
        ? createConnectionIsland(config, connections, passport, tasks)
        : createIsland(viewModel, config, coordinator, connections, passport, tasks)
  );
}

function hasBlockingPeerCompatibility(
  connections: readonly PassportConnectionSnapshot[]
): boolean {
  return blockingPeerCompatibility(connections).length > 0;
}

function blockingPeerCompatibility(
  connections: readonly PassportConnectionSnapshot[]
): PassportConnectionSnapshot[] {
  return connections.filter((connection) =>
    connection.connectionState === "Confirmed"
    && connection.compatibility !== "compatible"
  );
}

function createProtocolUpgradeBlocker(
  blockedPeers: readonly PassportConnectionSnapshot[],
  blockKey: string
): HTMLElement {
  const blocker = document.createElement("section");
  blocker.className = "teti-protocol-blocker";
  blocker.dataset.blockKey = blockKey;
  blocker.setAttribute("role", "alertdialog");
  blocker.setAttribute("aria-modal", "true");
  blocker.setAttribute("aria-labelledby", "teti-protocol-blocker-title");
  blocker.setAttribute("aria-describedby", "teti-protocol-blocker-message");
  blocker.tabIndex = -1;

  const card = document.createElement("div");
  card.className = "teti-protocol-blocker-card";
  const mark = document.createElement("span");
  mark.className = "teti-protocol-blocker-mark";
  mark.textContent = "!";
  mark.setAttribute("aria-hidden", "true");
  const title = document.createElement("h1");
  title.id = "teti-protocol-blocker-title";
  title.textContent = "需要升级 Teti";
  const message = document.createElement("p");
  message.id = "teti-protocol-blocker-message";
  message.textContent = "检测到已建联设备尚未证明兼容当前 Beta 协作协议。请在所有已建联设备上安装并运行当前 Teti Beta 版本。";
  const status = document.createElement("p");
  status.className = "teti-protocol-blocker-status";
  status.textContent = `${blockedPeers.length} 个已建联设备需要升级或完成版本检测。兼容性验证完成前，本机 Teti 的所有功能均暂停使用。`;
  card.append(mark, title, message, status);
  blocker.append(card);
  queueMicrotask(() => {
    if (blocker.isConnected && blocker.ownerDocument.activeElement !== blocker) {
      blocker.focus({ preventScroll: true });
    }
  });
  return blocker;
}

function createIsland(
  viewModel: FirstLaunchViewModel,
  config: ProvisioningModeConfig,
  coordinator?: FirstLaunchCoordinator,
  connections?: PeerConnectionController,
  passport?: PassportController,
  tasks?: TaskController
): HTMLElement {
  const island = document.createElement("section");
  island.className = `teti-island teti-island--${viewModel.panel} teti-island--${viewModel.character}`;
  island.setAttribute("aria-label", viewModel.title);

  if (viewModel.panel === "expanded") {
    island.append(createIslandHeader(config, passport, tasks, connections));
  }

  const face = document.createElement(viewModel.panel === "collapsed" && connections ? "button" : "div");
  face.className = `teti-face teti-face--${viewModel.character}`;
  face.innerHTML = '<div class="teti-eye"></div><div class="teti-eye"></div>';
  if (face instanceof HTMLButtonElement) {
    face.type = "button";
    const pendingCount = connections?.snapshot.connections.filter(
      (connection) => connection.connectionState === "PendingApproval"
    ).length ?? 0;
    const pendingTaskCount = tasks?.snapshot.summary.pendingIncomingCount ?? 0;
    const openLabel = pendingTaskCount > 0
      ? `打开 Teti 任务，${pendingTaskCount} 个任务待确认`
      : pendingCount > 0
        ? `打开 Teti 建联，${pendingCount} 个请求待确认`
        : "打开 Teti";
    face.setAttribute("aria-label", openLabel);
    face.setAttribute("title", openLabel);
    if (pendingCount > 0 || pendingTaskCount > 0) {
      face.classList.add("teti-face--attention");
      const indicator = document.createElement("span");
      indicator.className = "teti-pending-indicator";
      indicator.setAttribute("aria-hidden", "true");
      face.append(indicator);
    }
    face.addEventListener("click", () => {
      passport?.closePanel();
      if (pendingTaskCount > 0) tasks?.openInbox();
      else connections?.open();
    });
  } else {
    face.setAttribute("aria-hidden", "true");
  }
  island.append(face);

  if (viewModel.panel === "collapsed") {
    return island;
  }

  const content = document.createElement("div");
  content.className = "teti-content";

  const titleRow = document.createElement("div");
  titleRow.className = "teti-title-row";
  const title = document.createElement("h1");
  title.textContent = viewModel.title;
  titleRow.append(title);
  content.append(titleRow);

  const message = document.createElement("p");
  message.className = "teti-message";
  message.textContent = viewModel.message;
  content.append(message);

  if (viewModel.input) {
    const input = document.createElement("input");
    input.className = "teti-input";
    input.value = viewModel.input.value;
    input.placeholder = viewModel.input.placeholder;
    input.disabled = viewModel.input.disabled;
    input.setAttribute("aria-label", "Teti name");
    input.addEventListener("input", () => {
      const truncated = truncateTetiDisplayName(input.value);
      if (truncated !== input.value) input.value = truncated;
      coordinator?.updateName(truncated);
      updateNameCounter(input, inputMeta, viewModel.input?.maxCharacters);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && coordinator && !viewModel.input?.disabled) {
        event.preventDefault();
        void submitAndRender(coordinator, island.ownerDocument.getElementById("app"), config, connections, passport, tasks);
      }
    });
    content.append(input);

    const inputMeta = document.createElement("div");
    inputMeta.className = "teti-input-meta";
    updateNameCounter(input, inputMeta, viewModel.input.maxCharacters);
    content.append(inputMeta);

    if (viewModel.input.error) {
      const error = document.createElement("p");
      error.className = "teti-error";
      error.textContent = viewModel.input.error;
      content.append(error);
    }

    queueMicrotask(() => {
      if (!input.disabled && document.activeElement !== input) {
        input.focus();
      }
    });
  }

  if (viewModel.progress) {
    const progress = document.createElement("div");
    progress.className = `teti-progress ${viewModel.progress.active ? "is-active" : ""}`;
    progress.textContent = viewModel.progress.label;
    content.append(progress);
  }

  if (viewModel.primaryAction && coordinator) {
    const button = document.createElement("button");
    button.className = "teti-primary";
    button.type = "button";
    const label = document.createElement("span");
    label.textContent = viewModel.primaryAction;
    const arrow = document.createElement("span");
    arrow.className = "teti-primary-arrow";
    arrow.setAttribute("aria-hidden", "true");
    button.append(label, arrow);
    button.disabled = Boolean(viewModel.input?.disabled && viewModel.primaryAction !== "Done");
    button.addEventListener("click", () => {
      if (viewModel.primaryAction === "Continue" || viewModel.primaryAction === "下一步") {
        coordinator.showNaming();
        renderSnapshot(
          island.ownerDocument.getElementById("app") as HTMLElement,
          coordinator.snapshot,
          config,
          coordinator,
          connections,
          passport,
          tasks
        );
        return;
      }

      if (viewModel.primaryAction === "Done" || viewModel.primaryAction === "完成") {
        coordinator.collapseReadyToIdle();
        renderSnapshot(
          island.ownerDocument.getElementById("app") as HTMLElement,
          coordinator.snapshot,
          config,
          coordinator,
          connections,
          passport,
          tasks
        );
        return;
      }

      if (viewModel.primaryAction?.includes("connecting") || viewModel.primaryAction?.includes("连接")) {
        void retryDiscoveryAndRender(
          coordinator,
          island.ownerDocument.getElementById("app"),
          config,
          connections,
          passport,
          tasks
        );
        return;
      }

      void submitAndRender(
        coordinator,
        island.ownerDocument.getElementById("app"),
        config,
        connections,
        passport,
        tasks
      );
    });
    content.append(button);
  }

  island.append(content);
  return island;
}

function createConnectionIsland(
  config: ProvisioningModeConfig,
  controller: PeerConnectionController,
  passport?: PassportController,
  tasks?: TaskController
): HTMLElement {
  const snapshot = controller.snapshot;
  const passportViewModel = toPassportViewModel(passport?.snapshot ?? defaultPassportSnapshot());
  const island = document.createElement("section");
  island.className = "teti-island teti-island--expanded teti-island--connections";
  island.setAttribute("aria-label", "连接其他 Teti");
  island.append(createConnectionHeader(config, passport, tasks, controller));

  const panelState = snapshot.connectPanel.state;
  const face = document.createElement("button");
  face.className = `teti-face teti-face--ready teti-connect-eyes is-${panelState}`;
  face.type = "button";
  face.setAttribute("aria-label", connectEyesLabel(panelState));
  face.setAttribute("aria-controls", "teti-connect-panel");
  face.setAttribute("aria-expanded", String(!["idle", "closing"].includes(panelState)));
  face.setAttribute("aria-disabled", String(["opening", "connecting", "closing"].includes(panelState)));
  face.innerHTML = '<div class="teti-eye"></div><div class="teti-eye"></div>';
  face.addEventListener("click", () => controller.activateEyes());
  face.addEventListener("pointermove", (event) => updateEyeTracking(face, event));
  face.addEventListener("pointerleave", () => resetEyeTracking(face));

  const content = document.createElement("div");
  content.className = "teti-content teti-connection-content";
  const stage = document.createElement("div");
  stage.className = `teti-connect-stage is-${panelState}`;
  stage.append(face);

  if (panelState !== "idle") {
    const panel = document.createElement("div");
    panel.id = "teti-connect-panel";
    panel.className = `teti-connect-panel is-${panelState}`;
    const form = document.createElement("form");
    form.className = "teti-connect-form";
    const inputShell = document.createElement("div");
    inputShell.className = "teti-connect-input-shell";
    const input = document.createElement("input");
    input.className = "teti-input teti-connect-input";
    input.value = snapshot.input;
    input.placeholder = CONNECT_PANEL_PLACEHOLDER;
    input.disabled = !["editing", "error"].includes(panelState);
    input.maxLength = 9;
    input.autocapitalize = "none";
    input.spellcheck = false;
    input.setAttribute("aria-label", "Teti 社区 9 位 ID");
    input.setAttribute("aria-describedby", "teti-connect-inline-status");
    const inlineStatus = document.createElement("div");
    inlineStatus.id = "teti-connect-inline-status";
    inlineStatus.className = "teti-connect-inline-status";
    inlineStatus.setAttribute("role", "status");
    inlineStatus.setAttribute("aria-live", "polite");
    const connect = document.createElement("button");
    connect.className = "teti-connect-button";
    connect.type = "submit";
    connect.setAttribute("title", "建立连接");
    connect.setAttribute("aria-label", "建立连接");
    connect.append(createElement(Link2, { width: 19, height: 19, "stroke-width": 2, "aria-hidden": "true" }));
    const syncForm = () => syncConnectForm(
      controller.snapshot,
      panel,
      face,
      inputShell,
      input,
      connect,
      inlineStatus
    );
    input.addEventListener("focus", () => controller.noteActivity());
    input.addEventListener("input", () => {
      controller.updateInput(input.value);
      syncForm();
    });
    input.addEventListener("pointerdown", () => {
      if (controller.snapshot.connectPanel.state === "error") {
        inputShell.classList.add("is-revealing-value");
      }
    });
    input.addEventListener("paste", (event) => {
      const pasted = event.clipboardData?.getData("text");
      if (pasted === undefined) return;
      event.preventDefault();
      controller.updateInput(pasted.trim());
      syncForm();
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void controller.connect();
    });
    inputShell.append(input, inlineStatus);
    form.append(inputShell, connect);
    panel.append(form);
    stage.append(panel);
    syncForm();
    if (["editing", "error"].includes(panelState)) focusAfterPanelExpansion(input);
  }

  content.append(stage);

  if (passportViewModel.connections.length > 0) {
    const list = document.createElement("div");
    list.className = "teti-connection-list";
    for (const connection of passportViewModel.connections) {
      list.append(createConnectionRow(
        connection,
        snapshot.busy,
        connection.requestId === snapshot.highlightedRequestId,
        controller
      ));
    }
    content.append(list);
  }

  island.append(content);
  installConnectionPanelInteractions(island, controller, passport);
  return island;
}

function syncConnectForm(
  snapshot: PeerConnectionSnapshot,
  panel: HTMLElement,
  face: HTMLButtonElement,
  inputShell: HTMLElement,
  input: HTMLInputElement,
  connect: HTMLButtonElement,
  inlineStatus: HTMLElement
): void {
  const state = snapshot.connectPanel.state;
  if (input.value !== snapshot.input) input.value = snapshot.input;
  input.disabled = !["editing", "error"].includes(state);
  connect.disabled = state !== "editing" && state !== "error"
    || !/^[a-z0-9]{9}$/.test(snapshot.input);
  panel.className = `teti-connect-panel is-${state}`;
  face.className = `teti-face teti-face--ready teti-connect-eyes is-${state}`;
  face.setAttribute("aria-label", connectEyesLabel(state));
  face.setAttribute("aria-expanded", String(!["idle", "closing"].includes(state)));
  face.setAttribute("aria-disabled", String(["opening", "connecting", "closing"].includes(state)));
  input.setAttribute("aria-invalid", String(state === "error"));
  const hasInlineStatus = ["connecting", "success", "error"].includes(state);
  inputShell.classList.toggle("has-inline-status", hasInlineStatus);
  inputShell.classList.toggle("is-error", state === "error");
  inputShell.classList.toggle("is-success", state === "success");
  inputShell.classList.toggle("is-progress", state === "connecting");
  if (state !== "error") inputShell.classList.remove("is-revealing-value");
  inlineStatus.textContent = hasInlineStatus ? snapshot.connectPanel.message : "";
}

function connectEyesLabel(state: string): string {
  if (state === "idle") return "打开建联输入";
  if (state === "connecting") return "正在建立连接";
  if (state === "opening" || state === "closing") return "建联输入正在切换";
  return "收起建联输入";
}

function updateEyeTracking(face: HTMLButtonElement, event: PointerEvent): void {
  if (face.getAttribute("aria-disabled") === "true") return;
  const bounds = face.getBoundingClientRect();
  const x = Math.max(-1, Math.min(1, (event.clientX - bounds.left) / bounds.width * 2 - 1));
  const y = Math.max(-1, Math.min(1, (event.clientY - bounds.top) / bounds.height * 2 - 1));
  face.style.setProperty("--teti-eye-track-x", `${(x * 2.2).toFixed(2)}px`);
  face.style.setProperty("--teti-eye-track-y", `${(y * 1.4).toFixed(2)}px`);
}

function resetEyeTracking(face: HTMLButtonElement): void {
  face.style.removeProperty("--teti-eye-track-x");
  face.style.removeProperty("--teti-eye-track-y");
}

function installConnectionPanelInteractions(
  island: HTMLElement,
  controller: PeerConnectionController,
  passport?: PassportController
): void {
  island.addEventListener("pointerenter", () => controller.beginInteraction());
  island.addEventListener("pointerleave", () => controller.endInteraction());
  island.addEventListener("pointerdown", (event) => {
    controller.noteActivity();
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest(".teti-header-panel") || target.closest(".teti-header-icon[aria-expanded]")) return;
    const openHeaderPanel = island.querySelector<HTMLElement>(".teti-header-panel:not([hidden])");
    if (!openHeaderPanel) return;
    passport?.closePanel(false);
    openHeaderPanel.hidden = true;
    island.querySelectorAll<HTMLButtonElement>(".teti-header-icon[aria-expanded='true']")
      .forEach((button) => button.setAttribute("aria-expanded", "false"));
  });
  island.addEventListener("click", (event) => {
    const state = controller.snapshot.connectPanel.state;
    if (!["editing", "error", "success"].includes(state)) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest(".teti-connect-input-shell") || target.closest(".teti-connect-button")) return;
    controller.closeConnectPanel();
  });
  island.addEventListener("keydown", (event) => {
    controller.noteActivity();
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    const openHeaderPanel = island.querySelector<HTMLElement>(".teti-header-panel:not([hidden])");
    if (openHeaderPanel) {
      if (passport) {
        passport.closePanel();
      } else {
        openHeaderPanel.hidden = true;
        island.querySelectorAll<HTMLButtonElement>(".teti-header-icon[aria-expanded='true']")
          .forEach((button) => button.setAttribute("aria-expanded", "false"));
      }
      return;
    }
    if (!controller.handleEscape()) controller.close("peer-panel-escape");
  });
}

function focusAfterPanelExpansion(input: HTMLInputElement): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (!input.disabled && input.isConnected && document.activeElement !== input) {
        input.focus({ preventScroll: true });
      }
    });
  });
}

function createConnectionRow(
  connection: ConnectionCardViewModel,
  busy: boolean,
  highlighted: boolean,
  controller: PeerConnectionController
): HTMLElement {
  const row = document.createElement("div");
  row.className = `teti-connection-row is-${connection.state.toLowerCase()}${highlighted ? " is-highlighted" : ""}`;
  const identity = document.createElement("div");
  identity.className = "teti-connection-identity";
  const name = document.createElement("strong");
  name.textContent = connection.displayName;
  const address = document.createElement("small");
  address.textContent = connection.address;
  identity.append(name, address);

  const state = document.createElement("div");
  state.className = "teti-connection-state";
  if (connection.state === "Confirmed") {
    row.classList.add(`is-${connection.reachability}`);
    row.prepend(createRemoteTetiAvatar({
      reachability: connection.reachability,
      label: connection.reachabilityLabel,
      size: 28
    }));
    state.append(createRemotePassport(connection.passport));
  } else if (connection.state === "PendingApproval") {
    const accept = iconButton(Check, "接受建联", () => void controller.accept(connection.requestId));
    const reject = iconButton(X, "拒绝建联", () => void controller.reject(connection.requestId));
    accept.disabled = busy;
    reject.disabled = busy;
    state.append(accept, reject);
  } else if (connection.state === "Requested") {
    state.textContent = "等待确认";
  } else if (connection.state === "Rejected") {
    state.textContent = "已拒绝";
  } else {
    state.textContent = connection.state;
  }
  row.append(identity, state);
  return row;
}

function createConnectionHeader(
  config: ProvisioningModeConfig,
  passport?: PassportController,
  tasks?: TaskController,
  connections?: PeerConnectionController
): HTMLElement {
  return createIslandHeader(config, passport, tasks, connections);
}

function iconButton(
  icon: Parameters<typeof createElement>[0],
  label: string,
  action: () => void
): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "teti-header-icon";
  button.type = "button";
  button.setAttribute("title", label);
  button.setAttribute("aria-label", label);
  button.append(createElement(icon, { width: 18, height: 18, "stroke-width": 2, "aria-hidden": "true" }));
  button.addEventListener("click", action);
  return button;
}

function updateNameCounter(input: HTMLInputElement, meta: HTMLElement, maxCharacters?: number): void {
  if (!maxCharacters) {
    meta.hidden = true;
    return;
  }
  meta.hidden = false;
  meta.textContent = `${countUnicodeCharacters(input.value)} / ${maxCharacters}`;
}

function createIslandHeader(
  _config: ProvisioningModeConfig,
  passport?: PassportController,
  tasks?: TaskController,
  connections?: PeerConnectionController
): HTMLElement {
  const header = document.createElement("header");
  header.className = "teti-header";

  const brand = createTetiBotBrandLink({ ownerDocument: header.ownerDocument });

  const controls = document.createElement("div");
  controls.className = "teti-header-controls";
  const snapshot = passport?.snapshot ?? defaultPassportSnapshot();
  const viewModel = toPassportViewModel(snapshot);
  const statusPanel = createAiPassportPanel(viewModel.aiPanel);
  const sharingPanel = createPassportSettingsPanel(viewModel.settings, passport);
  const statusButton = createHeaderButton(
    null,
    `查看 AI Passport：${viewModel.aiPanel.resources[0]?.planLabel ?? "暂时无法确认"}`,
    statusPanel,
    controls,
    createToolbarAssetIcon(aiToolsButtonIconUrl, "ai-tools"),
    snapshot.openPanel === "passport",
    passport ? () => passport.togglePanel("passport") : undefined
  );
  const sharingButton = createHeaderButton(
    null,
    viewModel.settings.enabled ? "Passport 分享已开启" : "打开 Passport 设置",
    sharingPanel,
    controls,
    createToolbarAssetIcon(settingsButtonIconUrl, "settings"),
    snapshot.openPanel === "sharing",
    passport ? () => passport.togglePanel("sharing") : undefined
  );
  sharingButton.classList.toggle("is-sharing-enabled", viewModel.settings.enabled);
  const taskButton = iconButton(ClipboardList, "协作任务", () => {
    connections?.close("switch-to-task");
    passport?.closePanel(false);
    tasks?.openInbox();
  });
  taskButton.classList.add("teti-task-header-button");
  const pendingTasks = tasks?.snapshot.summary.pendingIncomingCount ?? 0;
  if (pendingTasks > 0) {
    taskButton.classList.add("has-task-badge");
    taskButton.dataset.count = String(Math.min(pendingTasks, 9));
  }
  controls.append(taskButton, statusButton, sharingButton, statusPanel, sharingPanel);

  header.append(brand, controls);
  return header;
}

function createHeaderButton(
  icon: Parameters<typeof createElement>[0] | null,
  label: string,
  panel: HTMLElement,
  controls: HTMLElement,
  content?: HTMLElement,
  isOpen = false,
  onToggle?: () => void
): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "teti-header-icon";
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);
  button.setAttribute("aria-expanded", String(isOpen));
  button.append(content ?? createElement(icon!, { width: 19, height: 19, "stroke-width": 1.8, "aria-hidden": "true" }));
  button.addEventListener("click", () => {
    if (onToggle) {
      onToggle();
      return;
    }
    const willOpen = panel.hidden;
    controls.querySelectorAll<HTMLElement>(".teti-header-panel").forEach((candidate) => {
      candidate.hidden = true;
    });
    controls.querySelectorAll<HTMLButtonElement>(".teti-header-icon").forEach((candidate) => {
      candidate.setAttribute("aria-expanded", "false");
    });
    panel.hidden = !willOpen;
    button.setAttribute("aria-expanded", String(willOpen));
  });
  return button;
}

function createToolbarAssetIcon(source: string, kind: "ai-tools" | "settings"): HTMLImageElement {
  const image = document.createElement("img");
  image.className = `teti-toolbar-asset-icon is-${kind}`;
  image.src = source;
  image.alt = "";
  image.setAttribute("aria-hidden", "true");
  return image;
}

function defaultPassportSnapshot(): PassportControllerSnapshot {
  return {
    passport: emptyPassportSnapshot(),
    agentManagement: emptyAgentManagementSnapshot(),
    sharingBusy: false,
    agentBusy: false,
    openPanel: null
  };
}

interface ScreenMetrics {
  hasNotch?: boolean;
  safeTopInset?: number;
  notchWidth?: number;
  notchHeight?: number;
}

async function syncScreenMetrics(tauri: TauriInvoker, root: HTMLElement): Promise<void> {
  try {
    const metrics = await tauri.invoke<ScreenMetrics | null>("current_monitor_info");
    const hasNotch = Boolean(metrics?.hasNotch);
    root.dataset.hasNotch = String(hasNotch);
    root.style.setProperty("--teti-safe-top-inset", `${hasNotch ? nonNegative(metrics?.safeTopInset) : 0}px`);
    root.style.setProperty("--teti-notch-width", `${nonNegative(metrics?.notchWidth)}px`);
    root.style.setProperty("--teti-notch-height", `${nonNegative(metrics?.notchHeight)}px`);
  } catch {
    root.dataset.hasNotch = "false";
  }
}

function installScreenMetricsSync(tauri: TauriInvoker, ownerDocument: Document): void {
  let pending = false;
  ownerDocument.defaultView?.addEventListener("resize", () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      void syncScreenMetrics(tauri, ownerDocument.documentElement);
    });
  });
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

async function submitAndRender(
  coordinator: FirstLaunchCoordinator,
  root: HTMLElement | null,
  config: ProvisioningModeConfig,
  connections?: PeerConnectionController,
  passport?: PassportController,
  tasks?: TaskController
): Promise<void> {
  const pending = coordinator.submitName();
  if (root) {
    renderSnapshot(root, coordinator.snapshot, config, coordinator, connections, passport, tasks);
  }

  await pending;
  if (coordinator.snapshot.account && passport) {
    passport.start();
    await passport.refreshNow();
  }
  if (root) {
    renderSnapshot(root, coordinator.snapshot, config, coordinator, connections, passport, tasks);
  }
}

async function retryDiscoveryAndRender(
  coordinator: FirstLaunchCoordinator,
  root: HTMLElement | null,
  config: ProvisioningModeConfig,
  connections?: PeerConnectionController,
  passport?: PassportController,
  tasks?: TaskController
): Promise<void> {
  const pending = coordinator.retryDiscoveryRegistration();
  if (root) {
    renderSnapshot(root, coordinator.snapshot, config, coordinator, connections, passport, tasks);
  }

  await pending;
  if (root) {
    renderSnapshot(root, coordinator.snapshot, config, coordinator, connections, passport, tasks);
  }
}

class MockDiscoveryClient {
  async registerIdentity(): Promise<{
    version: 1;
    id: string;
    address: string;
    publicProfile: Record<string, unknown>;
  }> {
    return {
      version: 1,
      id: "mock",
      address: "mock@mail.seep.im",
      publicProfile: {}
    };
  }
}
