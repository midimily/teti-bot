import { FirstLaunchCoordinator } from "./first-launch/coordinator.ts";
import { Activity, Check, Link2, Radio, Settings2, X, createElement } from "lucide";
import { countUnicodeCharacters, truncateTetiDisplayName } from "../../../core/account/display-name.ts";
import type { FirstLaunchSnapshot } from "./first-launch/state-machine.ts";
import { toFirstLaunchViewModel, type FirstLaunchViewModel } from "./first-launch/view-model.ts";
import { createDesktopAccountLifecycle } from "./provisioning/index.ts";
import { readProvisioningMode, type ProvisioningModeConfig } from "./provisioning/modes.ts";
import { TauriNotchWindowController, visualModeForViewModel } from "./platform/tauri-notch-window.ts";
import type { TauriInvoker } from "./platform/tauri-api.ts";
import { LifecycleBridgeClient } from "./provisioning/bridge-lifecycle.ts";
import {
  BridgePeerConnectionClient,
  MockPeerConnectionClient,
  PeerConnectionController
} from "./connections/controller.ts";
import "./styles.css";

export interface DesktopAppOptions {
  root: HTMLElement;
  tauri: TauriInvoker;
  env: Record<string, string | undefined>;
  schedule?: (callback: () => void, delayMs: number) => unknown;
}

export interface DesktopApp {
  coordinator: FirstLaunchCoordinator;
  connections: PeerConnectionController;
  config: ProvisioningModeConfig;
  render(): void;
}

export async function createDesktopApp(options: DesktopAppOptions): Promise<DesktopApp> {
  await syncScreenMetrics(options.tauri, options.root.ownerDocument.documentElement);
  installScreenMetricsSync(options.tauri, options.root.ownerDocument);
  const selection = await createDesktopAccountLifecycle(options.env, options.tauri);
  const notchWindow = new TauriNotchWindowController(options.tauri);
  let app: DesktopApp;
  let connectionsInitialized = false;
  const baseSchedule = options.schedule ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
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
  const connections = new PeerConnectionController({
    client: selection.config.mode === "real"
      ? new BridgePeerConnectionClient(new LifecycleBridgeClient(options.tauri))
      : new MockPeerConnectionClient(),
    notchWindow,
    onChange: () => app?.render()
  });

  app = {
    coordinator,
    connections,
    config: selection.config,
    render: () => {
      if (coordinator.snapshot.account && !connectionsInitialized) {
        connectionsInitialized = true;
        void connections.initialize();
      }
      renderSnapshot(options.root, coordinator.snapshot, selection.config, coordinator, connections);
    }
  };

  await coordinator.initialize();
  app.render();
  await notchWindow.setMode(visualModeForViewModel(toFirstLaunchViewModel(coordinator.snapshot)), "initial-render");

  return app;
}

export function renderSnapshot(
  root: HTMLElement,
  snapshot: FirstLaunchSnapshot,
  config: ProvisioningModeConfig = readProvisioningMode({}),
  coordinator?: FirstLaunchCoordinator,
  connections?: PeerConnectionController
): void {
  const viewModel = toFirstLaunchViewModel(snapshot);
  const peerPanelOpen = viewModel.panel === "collapsed" && connections?.snapshot.open;
  root.className = `teti-shell teti-shell--${peerPanelOpen ? "expanded" : viewModel.panel}`;
  root.replaceChildren(
    peerPanelOpen
      ? createConnectionIsland(config, connections)
      : createIsland(viewModel, config, coordinator, connections)
  );
}

function createIsland(
  viewModel: FirstLaunchViewModel,
  config: ProvisioningModeConfig,
  coordinator?: FirstLaunchCoordinator,
  connections?: PeerConnectionController
): HTMLElement {
  const island = document.createElement("section");
  island.className = `teti-island teti-island--${viewModel.panel} teti-island--${viewModel.character}`;
  island.setAttribute("aria-label", viewModel.title);

  if (viewModel.panel === "expanded") {
    island.append(createIslandHeader(config));
  }

  const face = document.createElement(viewModel.panel === "collapsed" && connections ? "button" : "div");
  face.className = `teti-face teti-face--${viewModel.character}`;
  if (face instanceof HTMLButtonElement) {
    face.type = "button";
    face.setAttribute("aria-label", "打开 Teti 建联");
    face.setAttribute("title", "打开 Teti 建联");
    face.addEventListener("click", () => connections?.open());
  } else {
    face.setAttribute("aria-hidden", "true");
  }
  face.innerHTML = '<div class="teti-eye"></div><div class="teti-eye"></div>';
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
        void submitAndRender(coordinator, island.ownerDocument.getElementById("app"), config, connections);
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
          connections
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
          connections
        );
        return;
      }

      if (viewModel.primaryAction?.includes("connecting") || viewModel.primaryAction?.includes("连接")) {
        void retryDiscoveryAndRender(
          coordinator,
          island.ownerDocument.getElementById("app"),
          config,
          connections
        );
        return;
      }

      void submitAndRender(
        coordinator,
        island.ownerDocument.getElementById("app"),
        config,
        connections
      );
    });
    content.append(button);
  }

  island.append(content);
  return island;
}

function createConnectionIsland(
  config: ProvisioningModeConfig,
  controller: PeerConnectionController
): HTMLElement {
  const snapshot = controller.snapshot;
  const island = document.createElement("section");
  island.className = "teti-island teti-island--expanded teti-island--connections";
  island.setAttribute("aria-label", "连接其他 Teti");
  island.append(createConnectionHeader(config, controller));

  const face = document.createElement("div");
  face.className = "teti-face teti-face--ready";
  face.setAttribute("aria-hidden", "true");
  face.innerHTML = '<div class="teti-eye"></div><div class="teti-eye"></div>';

  const content = document.createElement("div");
  content.className = "teti-content teti-connection-content";
  const title = document.createElement("h1");
  title.textContent = "连接另一个 Teti";
  const message = document.createElement("p");
  message.className = "teti-message teti-connection-message";
  message.textContent = "输入 teti.bot 信息卡上的 9 位 ID";

  const form = document.createElement("form");
  form.className = "teti-connect-form";
  const input = document.createElement("input");
  input.className = "teti-input teti-connect-input";
  input.value = snapshot.input;
  input.placeholder = "*********";
  input.disabled = snapshot.busy;
  input.maxLength = 9;
  input.autocapitalize = "none";
  input.spellcheck = false;
  input.setAttribute("aria-label", "Teti 公开身份");
  input.addEventListener("focus", () => controller.beginInteraction());
  input.addEventListener("blur", () => controller.endInteraction());
  input.addEventListener("input", () => {
    controller.updateInput(input.value);
    const normalized = controller.snapshot.input;
    if (input.value !== normalized) input.value = normalized;
    connect.disabled = snapshot.busy || !/^[a-z0-9]{9}$/.test(normalized);
  });
  const connect = document.createElement("button");
  connect.className = "teti-connect-button";
  connect.type = "submit";
  connect.disabled = snapshot.busy || !/^[a-z0-9]{9}$/.test(snapshot.input);
  connect.setAttribute("title", "发送建联请求");
  connect.setAttribute("aria-label", "发送建联请求");
  connect.append(createElement(Link2, { width: 19, height: 19, "stroke-width": 2, "aria-hidden": "true" }));
  form.append(input, connect);
  form.addEventListener("pointerenter", () => controller.beginInteraction());
  form.addEventListener("pointerleave", () => {
    if (document.activeElement !== input) controller.endInteraction();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void controller.connect();
  });

  content.append(title, message, form);
  if (snapshot.error) {
    const error = document.createElement("p");
    error.className = "teti-error teti-connect-error";
    error.textContent = snapshot.error;
    content.append(error);
  } else if (snapshot.notice) {
    const notice = document.createElement("p");
    notice.className = `teti-connect-notice is-${snapshot.noticeTone ?? "info"}`;
    notice.setAttribute("role", "status");
    notice.setAttribute("aria-live", "polite");
    notice.textContent = snapshot.notice;
    content.append(notice);
  }

  if (snapshot.connections.length > 0) {
    const list = document.createElement("div");
    list.className = "teti-connection-list";
    for (const connection of snapshot.connections) {
      list.append(createConnectionRow(
        connection,
        snapshot.busy,
        connection.requestId === snapshot.highlightedRequestId,
        controller
      ));
    }
    content.append(list);
  } else {
    const empty = document.createElement("div");
    empty.className = "teti-connection-empty";
    empty.textContent = "还没有建联记录";
    content.append(empty);
  }

  island.append(face, content);
  focusAfterPanelExpansion(input);
  return island;
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
  connection: import("./lifecycle-bridge/protocol.ts").PeerConnectionDto,
  busy: boolean,
  highlighted: boolean,
  controller: PeerConnectionController
): HTMLElement {
  const row = document.createElement("div");
  row.className = `teti-connection-row is-${connection.state.toLowerCase()}${highlighted ? " is-highlighted" : ""}`;
  const identity = document.createElement("div");
  identity.className = "teti-connection-identity";
  const name = document.createElement("strong");
  name.textContent = connection.remoteDisplayName || connection.remoteTetiId;
  const address = document.createElement("small");
  address.textContent = connection.remoteAddress;
  identity.append(name, address);

  const state = document.createElement("div");
  state.className = "teti-connection-state";
  if (connection.state === "Confirmed") {
    state.append(createElement(Radio, { width: 14, height: 14, "stroke-width": 2, "aria-hidden": "true" }));
    state.append(document.createTextNode(isHeartbeatFresh(connection.lastHeartbeatReceivedAt) ? " 心跳在线" : " 已建联"));
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
  controller: PeerConnectionController
): HTMLElement {
  const header = createIslandHeader(config);
  const controls = header.querySelector(".teti-header-controls");
  controls?.append(iconButton(X, "收起", () => controller.close()));
  return header;
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

function isHeartbeatFresh(timestamp?: string): boolean {
  return Boolean(timestamp && Date.now() - Date.parse(timestamp) < 15_000);
}

function updateNameCounter(input: HTMLInputElement, meta: HTMLElement, maxCharacters?: number): void {
  if (!maxCharacters) {
    meta.hidden = true;
    return;
  }
  meta.hidden = false;
  meta.textContent = `${countUnicodeCharacters(input.value)} / ${maxCharacters}`;
}

function createIslandHeader(config: ProvisioningModeConfig): HTMLElement {
  const header = document.createElement("header");
  header.className = "teti-header";

  const brand = document.createElement("div");
  brand.className = "teti-brand";
  brand.innerHTML = '<span class="teti-brand-dot" aria-hidden="true"></span><span>Teti</span>';

  const controls = document.createElement("div");
  controls.className = "teti-header-controls";
  const statusPanel = createHeaderPanel(
    "运行状态",
    config.mode === "real" ? "真实连接" : "本地预览",
    "已贴合当前屏幕顶部"
  );
  const settingsPanel = createMotionSettingsPanel();
  const statusButton = createHeaderButton(Activity, "查看运行状态", statusPanel, controls);
  const settingsButton = createHeaderButton(Settings2, "打开界面设置", settingsPanel, controls);
  controls.append(statusButton, settingsButton, statusPanel, settingsPanel);

  header.append(brand, controls);
  return header;
}

function createHeaderButton(
  icon: Parameters<typeof createElement>[0],
  label: string,
  panel: HTMLElement,
  controls: HTMLElement
): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "teti-header-icon";
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);
  button.setAttribute("aria-expanded", "false");
  button.append(createElement(icon, { width: 19, height: 19, "stroke-width": 1.8, "aria-hidden": "true" }));
  button.addEventListener("click", () => {
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

function createHeaderPanel(titleText: string, value: string, detail: string): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "teti-header-panel teti-status-panel";
  panel.hidden = true;

  const title = document.createElement("strong");
  title.textContent = titleText;
  const status = document.createElement("span");
  status.className = "teti-status-value";
  status.textContent = value;
  const description = document.createElement("small");
  description.textContent = detail;
  panel.append(title, status, description);
  return panel;
}

function createMotionSettingsPanel(): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "teti-header-panel teti-settings-panel";
  panel.hidden = true;

  const title = document.createElement("strong");
  title.textContent = "界面设置";
  const label = document.createElement("label");
  label.className = "teti-toggle-row";
  const text = document.createElement("span");
  text.textContent = "减少动画";
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.checked = readReducedMotionPreference();
  toggle.addEventListener("change", () => {
    applyReducedMotionPreference(toggle.checked, true);
  });
  label.append(text, toggle);
  panel.append(title, label);
  return panel;
}

interface ScreenMetrics {
  hasNotch?: boolean;
  safeTopInset?: number;
  notchWidth?: number;
  notchHeight?: number;
}

const REDUCED_MOTION_KEY = "teti.desktop.reduced-motion";

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
  applyReducedMotionPreference(readReducedMotionPreference(), false);
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

function readReducedMotionPreference(): boolean {
  try {
    return localStorage.getItem(REDUCED_MOTION_KEY) === "true";
  } catch {
    return false;
  }
}

function applyReducedMotionPreference(enabled: boolean, persist: boolean): void {
  document.documentElement.dataset.reducedMotion = String(enabled);
  if (!persist) return;
  try {
    localStorage.setItem(REDUCED_MOTION_KEY, String(enabled));
  } catch {
    // This preference is best effort when WebView storage is unavailable.
  }
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

async function submitAndRender(
  coordinator: FirstLaunchCoordinator,
  root: HTMLElement | null,
  config: ProvisioningModeConfig,
  connections?: PeerConnectionController
): Promise<void> {
  const pending = coordinator.submitName();
  if (root) {
    renderSnapshot(root, coordinator.snapshot, config, coordinator, connections);
  }

  await pending;
  if (root) {
    renderSnapshot(root, coordinator.snapshot, config, coordinator, connections);
  }
}

async function retryDiscoveryAndRender(
  coordinator: FirstLaunchCoordinator,
  root: HTMLElement | null,
  config: ProvisioningModeConfig,
  connections?: PeerConnectionController
): Promise<void> {
  const pending = coordinator.retryDiscoveryRegistration();
  if (root) {
    renderSnapshot(root, coordinator.snapshot, config, coordinator, connections);
  }

  await pending;
  if (root) {
    renderSnapshot(root, coordinator.snapshot, config, coordinator, connections);
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
