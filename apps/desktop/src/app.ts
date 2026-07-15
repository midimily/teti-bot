import { FirstLaunchCoordinator } from "./first-launch/coordinator.ts";
import { Activity, Settings2, createElement } from "lucide";
import { countUnicodeCharacters, truncateTetiDisplayName } from "../../../core/account/display-name.ts";
import type { FirstLaunchSnapshot } from "./first-launch/state-machine.ts";
import { toFirstLaunchViewModel, type FirstLaunchViewModel } from "./first-launch/view-model.ts";
import { createDesktopAccountLifecycle } from "./provisioning/index.ts";
import { readProvisioningMode, type ProvisioningModeConfig } from "./provisioning/modes.ts";
import { TauriNotchWindowController, visualModeForViewModel } from "./platform/tauri-notch-window.ts";
import type { TauriInvoker } from "./platform/tauri-api.ts";
import "./styles.css";

export interface DesktopAppOptions {
  root: HTMLElement;
  tauri: TauriInvoker;
  env: Record<string, string | undefined>;
  schedule?: (callback: () => void, delayMs: number) => unknown;
}

export interface DesktopApp {
  coordinator: FirstLaunchCoordinator;
  config: ProvisioningModeConfig;
  render(): void;
}

export async function createDesktopApp(options: DesktopAppOptions): Promise<DesktopApp> {
  await syncScreenMetrics(options.tauri, options.root.ownerDocument.documentElement);
  installScreenMetricsSync(options.tauri, options.root.ownerDocument);
  const selection = await createDesktopAccountLifecycle(options.env, options.tauri);
  const notchWindow = new TauriNotchWindowController(options.tauri);
  let app: DesktopApp;
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

  app = {
    coordinator,
    config: selection.config,
    render: () => renderSnapshot(options.root, coordinator.snapshot, selection.config, coordinator)
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
  coordinator?: FirstLaunchCoordinator
): void {
  const viewModel = toFirstLaunchViewModel(snapshot);
  root.className = `teti-shell teti-shell--${viewModel.panel}`;
  root.replaceChildren(createIsland(viewModel, config, coordinator));
}

function createIsland(
  viewModel: FirstLaunchViewModel,
  config: ProvisioningModeConfig,
  coordinator?: FirstLaunchCoordinator
): HTMLElement {
  const island = document.createElement("section");
  island.className = `teti-island teti-island--${viewModel.panel} teti-island--${viewModel.character}`;
  island.setAttribute("aria-label", viewModel.title);

  if (viewModel.panel === "expanded") {
    island.append(createIslandHeader(config));
  }

  const face = document.createElement("div");
  face.className = `teti-face teti-face--${viewModel.character}`;
  face.setAttribute("aria-hidden", "true");
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
        void submitAndRender(coordinator, island.ownerDocument.getElementById("app"), config);
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
        renderSnapshot(island.ownerDocument.getElementById("app") as HTMLElement, coordinator.snapshot, config, coordinator);
        return;
      }

      if (viewModel.primaryAction === "Done" || viewModel.primaryAction === "完成") {
        coordinator.collapseReadyToIdle();
        renderSnapshot(island.ownerDocument.getElementById("app") as HTMLElement, coordinator.snapshot, config, coordinator);
        return;
      }

      if (viewModel.primaryAction?.includes("connecting") || viewModel.primaryAction?.includes("连接")) {
        void retryDiscoveryAndRender(coordinator, island.ownerDocument.getElementById("app"), config);
        return;
      }

      void submitAndRender(coordinator, island.ownerDocument.getElementById("app"), config);
    });
    content.append(button);
  }

  island.append(content);
  return island;
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
  config: ProvisioningModeConfig
): Promise<void> {
  const pending = coordinator.submitName();
  if (root) {
    renderSnapshot(root, coordinator.snapshot, config, coordinator);
  }

  await pending;
  if (root) {
    renderSnapshot(root, coordinator.snapshot, config, coordinator);
  }
}

async function retryDiscoveryAndRender(
  coordinator: FirstLaunchCoordinator,
  root: HTMLElement | null,
  config: ProvisioningModeConfig
): Promise<void> {
  const pending = coordinator.retryDiscoveryRegistration();
  if (root) {
    renderSnapshot(root, coordinator.snapshot, config, coordinator);
  }

  await pending;
  if (root) {
    renderSnapshot(root, coordinator.snapshot, config, coordinator);
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
