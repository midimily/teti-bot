import { FirstLaunchCoordinator } from "./first-launch/coordinator.ts";
import { Check, ChevronDown, ClipboardList, Link2, X, createElement } from "lucide";
import { countUnicodeCharacters, truncateTetiDisplayName } from "../../../core/account/display-name.ts";
import type { LocalReleaseStatus } from "../../../core/release/policy.ts";
import type { FirstLaunchSnapshot } from "./first-launch/state-machine.ts";
import { toFirstLaunchViewModel, type FirstLaunchViewModel } from "./first-launch/view-model.ts";
import { createDesktopAccountLifecycle } from "./provisioning/index.ts";
import { readProvisioningMode, type ProvisioningModeConfig } from "./provisioning/modes.ts";
import { TauriNotchWindowController, visualModeForViewModel } from "./platform/tauri-notch-window.ts";
import type { TauriInvoker } from "./platform/tauri-api.ts";
import type { DesktopPlatformInfo } from "./platform/contract.ts";
import { createPanelDiagnosticSink } from "./platform/panel-diagnostics.ts";
import { DockActivationGuard } from "./platform/dock-activation-guard.ts";
import {
  isWindowsLaunchFocusGuardActive,
  shouldRevealMainPanelOnLaunch,
  WINDOWS_LAUNCH_FOCUS_GUARD_MS
} from "./platform/launch-presentation.ts";
import { TETI_BUILD_INFO } from "./build-info.ts";
import {
  LifecycleBridgeClient
} from "./provisioning/bridge-lifecycle.ts";
import {
  BridgePeerConnectionClient,
  CONNECTION_DETAILS_TRANSITION_MS,
  MockPeerConnectionClient,
  PeerConnectionController,
  type PeerConnectionMutationStatus,
  type PeerConnectionSnapshot
} from "./connections/controller.ts";
import {
  createRemoteTetiAvatar
} from "./connections/remote-teti-avatar.ts";
import { resolveConnectionDetailLayout } from "./connections/detail-layout.ts";
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
  createRemotePassport,
  createRemotePassportDetails
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
import {
  BridgeChildMemoryClient,
  MemoryController,
  MockChildMemoryClient
} from "./memory/controller.ts";
import {
  BridgeReleaseStatusClient,
  ReleaseController,
  SupportedMockReleaseStatusClient
} from "./release/controller.ts";
import {
  capturePanelScrollPositions,
  restorePanelScrollPositions
} from "./panel-scroll-position.ts";
import {
  createDesktopI18n,
  formatMessage,
  type AppLanguageSettings,
  type AppLocalePreference,
  type DesktopI18n
} from "./i18n/index.ts";
import { connectPanelMessage } from "./connections/connect-panel-message.ts";
import "./styles.css";

const aiToolsButtonIconUrl = new URL("../assets/ai-tools-btn.png", import.meta.url).href;
const settingsButtonIconUrl = new URL("../assets/settings.png", import.meta.url).href;
const DOCK_FOCUS_REASSERT_SETTLE_MS = 150;

export interface DesktopAppOptions {
  root: HTMLElement;
  tauri: TauriInvoker;
  env: Record<string, string | undefined>;
  i18n: DesktopI18n;
  platform: DesktopPlatformInfo;
  localePreference?: AppLocalePreference;
  onLocalePreferenceChange?(preference: AppLocalePreference): void;
  schedule?: (callback: () => void, delayMs: number) => unknown;
}

export interface DesktopApp {
  i18n: DesktopI18n;
  platform: DesktopPlatformInfo;
  coordinator: FirstLaunchCoordinator;
  connections: PeerConnectionController;
  passport: PassportController;
  tasks: TaskController;
  memory: MemoryController;
  release: ReleaseController;
  config: ProvisioningModeConfig;
  render(): void;
  dispose(): void;
}

export function renderDesktopStartupFailure(
  root: HTMLElement,
  env: Record<string, string | undefined>,
  i18n: DesktopI18n
): void {
  renderSnapshot(
    root,
    {
      state: "fatal_error",
      nameInput: "",
      submitting: false,
      error: {
        kind: "unrecoverable_internal_state",
        recoverable: false,
        diagnosticCode: "RUNTIME-START"
      }
    },
    readProvisioningMode(env, "real"),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    i18n
  );
}

export async function createDesktopApp(options: DesktopAppOptions): Promise<DesktopApp> {
  await syncScreenMetrics(options.tauri, options.root.ownerDocument.documentElement);
  installScreenMetricsSync(options.tauri, options.root.ownerDocument);
  const selection = await createDesktopAccountLifecycle(options.env, options.tauri, options.platform);
  const panelDiagnostic = createPanelDiagnosticSink(options.tauri, TETI_BUILD_INFO.buildType);
  const notchWindow = new TauriNotchWindowController(options.tauri, panelDiagnostic);
  let app: DesktopApp;
  let disposed = false;
  let stopFocusListener: (() => void) | undefined;
  let stopDockActivateListener: (() => void) | undefined;
  let stopSystemSleepListener: (() => void) | undefined;
  let stopSystemWakeListener: (() => void) | undefined;
  let preserveStateForBrandOpen = false;
  let brandOpenGuardTimer: number | undefined;
  let localAppUpdateRequired = false;
  let windowsLaunchFocusGuardDeadline = Number.NEGATIVE_INFINITY;
  const languageSettings: AppLanguageSettings | undefined = options.onLocalePreferenceChange
    ? {
        preference: options.localePreference ?? "auto",
        setPreference: options.onLocalePreferenceChange
      }
    : undefined;
  let lastWindowFocused = options.root.ownerDocument.hasFocus();
  let dockFocusRecoveryRevision = 0;
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
    schedule: (callback, delayMs) =>
      baseSchedule(() => {
        callback();
        app?.render();
      }, delayMs)
  });
  const bridge = selection.config.mode === "real" ? new LifecycleBridgeClient(options.tauri) : undefined;
  const setPresenceSignal = (signal: "sleeping" | "foreground" | "panel_visible", active: boolean) => {
    if (!bridge) return;
    void bridge.request("presence.signal.set", { signal, active }).catch(() => undefined);
  };
  let lastPanelVisible = false;
  const release = new ReleaseController({
    client: bridge
      ? new BridgeReleaseStatusClient(bridge)
      : new SupportedMockReleaseStatusClient(),
    onChange: () => app?.render(),
    schedule: baseSchedule
  });
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
    onChange: () => {
      const panelVisible = connections.snapshot.open;
      if (panelVisible !== lastPanelVisible) {
        lastPanelVisible = panelVisible;
        setPresenceSignal("panel_visible", panelVisible);
      }
      app?.render();
    },
    refreshPassport: () => passport.refreshAfterMutation(),
    diagnostic: panelDiagnostic
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
    schedule: baseSchedule,
    diagnostic: panelDiagnostic
  });
  const memory = new MemoryController({
    client: bridge ? new BridgeChildMemoryClient(bridge) : new MockChildMemoryClient(),
    onChange: () => app?.render()
  });
  const dismissPanelsFromOutside = () => {
    dockFocusRecoveryRevision += 1;
    passport.closePanel();
    tasks.dismissFromOutside();
    connections.dismissFromOutside();
  };
  const reconcileDockFocusLoss = () => {
    if (disposed || lastWindowFocused || localAppUpdateRequired) return;
    const mode = tasks.snapshot.open
      ? "task"
      : connections.snapshot.open
        ? connections.snapshot.expandedRequestId
          ? "connection_detail"
          : "onboarding"
        : undefined;
    if (!mode) return;

    const revision = ++dockFocusRecoveryRevision;
    panelDiagnostic({
      level: "debug",
      event: "panel.focus.reassert_requested",
      fields: { mode, reason: "dock_activation_guard" }
    });
    void notchWindow.setMode(mode, "dock-focus-reconcile").then(() => {
      baseSchedule(() => {
        if (disposed || revision !== dockFocusRecoveryRevision || lastWindowFocused) return;
        panelDiagnostic({
          level: "warn",
          event: "panel.focus.reassert_failed",
          fields: { mode, action: "dismiss" }
        });
        dismissPanelsFromOutside();
      }, DOCK_FOCUS_REASSERT_SETTLE_MS);
    }).catch(() => undefined);
  };
  if (options.tauri.onFocusChanged) {
    stopFocusListener = await options.tauri.onFocusChanged((focused) => {
      lastWindowFocused = focused;
      panelDiagnostic({
        level: "debug",
        event: "panel.focus.changed",
        fields: {
          focused,
          taskOpen: tasks.snapshot.open,
          connectionsOpen: connections.snapshot.open,
          taskBusy: tasks.snapshot.busy,
          connectState: connections.snapshot.connectPanel.state
        }
      });
      setPresenceSignal("foreground", focused);
      if (focused) {
        dockFocusRecoveryRevision += 1;
        if (dockActivationGuard.cancelPendingFocusLoss()) {
          panelDiagnostic({
            level: "debug",
            event: "panel.dismiss.cancelled",
            fields: { reason: "dock_activation_guard", resolution: "focus_regained" }
          });
        }
        tasks.cancelPendingOutsideDismiss();
        connections.cancelPendingOutsideDismiss();
      }
      if (localAppUpdateRequired) {
        panelDiagnostic({
          level: "debug",
          event: "panel.dismiss.ignored",
          fields: { reason: "app_update_required", focused }
        });
        void notchWindow.setMode("error", "local-app-update-required").catch(() => undefined);
        return;
      }
      if (!focused) {
        if (isWindowsLaunchFocusGuardActive(windowsLaunchFocusGuardDeadline)) {
          panelDiagnostic({
            level: "debug",
            event: "panel.dismiss.ignored",
            fields: { reason: "windows_launch_focus_guard" }
          });
          return;
        }
        if (preserveStateForBrandOpen) {
          panelDiagnostic({
            level: "debug",
            event: "panel.dismiss.ignored",
            fields: { reason: "brand_open_guard" }
          });
          clearBrandOpenGuard();
          return;
        }
        const dockDeferral = dockActivationGuard.deferFocusLoss(
          baseSchedule,
          reconcileDockFocusLoss
        );
        if (dockDeferral.state !== "inactive") {
          panelDiagnostic({
            level: "debug",
            event: "panel.dismiss.deferred",
            fields: {
              reason: "dock_activation_guard",
              delayMs: dockDeferral.delayMs,
              alreadyPending: dockDeferral.state === "pending"
            }
          });
          return;
        }
        dismissPanelsFromOutside();
      }
    });
  }

  if (options.tauri.onSystemSleep) {
    stopSystemSleepListener = await options.tauri.onSystemSleep(() => {
      setPresenceSignal("sleeping", true);
    });
  }

  if (options.tauri.onSystemWake) {
    stopSystemWakeListener = await options.tauri.onSystemWake(() => {
      setPresenceSignal("sleeping", false);
    });
  }

  if (options.tauri.onDockActivate) {
    stopDockActivateListener = await options.tauri.onDockActivate(() => {
      dockFocusRecoveryRevision += 1;
      if (localAppUpdateRequired) {
        void notchWindow.setMode("error", "local-app-update-required").catch(() => undefined);
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
    i18n: options.i18n,
    platform: options.platform,
    coordinator,
    connections,
    passport,
    tasks,
    memory,
    release,
    config: selection.config,
    render: () => {
      const panelVisible = connections.snapshot.open;
      if (panelVisible !== lastPanelVisible) {
        lastPanelVisible = panelVisible;
        setPresenceSignal("panel_visible", panelVisible);
      }
      const wasUpdateRequired = localAppUpdateRequired;
      localAppUpdateRequired = release.status.state === "update_required";
      if (localAppUpdateRequired) {
        void notchWindow.setMode("error", "local-app-update-required").catch(() => undefined);
      } else if (wasUpdateRequired) {
        const mode = tasks.snapshot.open
          ? "task"
          : connections.snapshot.open
            ? connections.snapshot.expandedRequestId
              ? "connection_detail"
              : "onboarding"
            : visualModeForViewModel(toFirstLaunchViewModel(coordinator.snapshot, options.i18n));
        void notchWindow.setMode(mode, "local-app-supported").catch(() => undefined);
      }
      renderSnapshot(
        options.root,
        coordinator.snapshot,
        selection.config,
        coordinator,
        connections,
        passport,
        tasks,
        memory,
        release.status,
        options.i18n,
        languageSettings
      );
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      stopFocusListener?.();
      stopDockActivateListener?.();
      stopSystemSleepListener?.();
      stopSystemWakeListener?.();
      dockActivationGuard.cancelPendingFocusLoss();
      dockFocusRecoveryRevision += 1;
      clearBrandOpenGuard();
      options.root.removeEventListener(TETI_BOT_OPENING_EVENT, handleBrandWebsiteOpening);
      options.root.removeEventListener(TETI_BOT_OPEN_SETTLED_EVENT, handleBrandWebsiteOpenSettled);
      passport.stop();
      tasks.dispose();
      memory.dispose();
      release.stop();
      connections.dispose();
    }
  };

  await release.start();
  const initialSnapshot = await coordinator.initialize();
  setPresenceSignal("foreground", options.root.ownerDocument.hasFocus());
  setPresenceSignal("panel_visible", connections.snapshot.open);
  passport.start();
  tasks.start();
  await memory.start();
  if (shouldRevealMainPanelOnLaunch(options.platform, initialSnapshot)) {
    windowsLaunchFocusGuardDeadline = Date.now() + WINDOWS_LAUNCH_FOCUS_GUARD_MS;
    connections.open("windows-app-launch");
  }
  app.render();
  await notchWindow.setMode(
    tasks.snapshot.open
      ? "task"
      : connections.snapshot.open
        ? connections.snapshot.expandedRequestId
          ? "connection_detail"
          : "onboarding"
        : visualModeForViewModel(toFirstLaunchViewModel(coordinator.snapshot, options.i18n)),
    "initial-render"
  );

  return app;
}

export function renderSnapshot(
  root: HTMLElement,
  snapshot: FirstLaunchSnapshot,
  config: ProvisioningModeConfig = readProvisioningMode({}),
  coordinator?: FirstLaunchCoordinator,
  connections?: PeerConnectionController,
  passport?: PassportController,
  tasks?: TaskController,
  memory?: MemoryController,
  releaseStatus?: LocalReleaseStatus,
  i18n: DesktopI18n = createDesktopI18n("zh-Hans"),
  languageSettings?: AppLanguageSettings
): void {
  const viewModel = toFirstLaunchViewModel(snapshot, i18n);
  if (!releaseStatus && root.dataset.protocolBlocked === "true") return;
  if (releaseStatus?.state === "update_required") {
    root.className = "teti-shell teti-shell--protocol-blocked";
    root.dataset.protocolBlocked = "true";
    const blockKey = [
      releaseStatus.currentVersion,
      releaseStatus.minimumSupportedVersion ?? "unknown",
      releaseStatus.policyVersion ?? "unknown"
    ].join("|");
    const existing = root.querySelector<HTMLElement>(".teti-protocol-blocker[data-block-key]");
    if (existing?.dataset.blockKey === blockKey) return;
    root.replaceChildren(createAppUpdateBlocker(releaseStatus, blockKey, i18n));
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
  const focusKey = focusKeyWithin(root);
  const panelScrollPositions = capturePanelScrollPositions(root);
  const nextContent = taskOpen
    ? createTaskWorkspace(
        tasks!,
        passport?.snapshot.passport.connections ?? [],
        passport?.snapshot.passport.localPassport,
        memory,
        i18n
      )
    : peerPanelOpen
      ? createConnectionIsland(
          config,
          connections,
          passport,
          tasks,
          memory,
          i18n,
          languageSettings
        )
      : createIsland(
          viewModel,
          config,
          coordinator,
          connections,
          passport,
          tasks,
          memory,
          i18n,
          languageSettings
        );
  root.replaceChildren(nextContent);
  restoreFocusKey(root, focusKey);
  restorePanelScrollPositions(root, panelScrollPositions);
}

function focusKeyWithin(root: HTMLElement): string | undefined {
  const active = root.ownerDocument.activeElement;
  return active instanceof HTMLElement && root.contains(active)
    ? active.dataset.focusKey
    : undefined;
}

function restoreFocusKey(root: HTMLElement, focusKey: string | undefined): void {
  if (!focusKey) return;
  queueMicrotask(() => {
    const target = [...root.querySelectorAll<HTMLElement>("[data-focus-key]")]
      .find((element) => element.dataset.focusKey === focusKey);
    if (target?.isConnected && root.ownerDocument.activeElement !== target) {
      target.focus({ preventScroll: true });
    }
  });
}

function createAppUpdateBlocker(
  release: LocalReleaseStatus,
  blockKey: string,
  i18n: DesktopI18n
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
  title.textContent = i18n.messages.updateBlocker.title;
  const message = document.createElement("p");
  message.id = "teti-protocol-blocker-message";
  message.textContent = i18n.messages.updateBlocker.message;
  const status = document.createElement("p");
  status.className = "teti-protocol-blocker-status";
  status.textContent = formatMessage(i18n.messages.updateBlocker.status, {
    currentVersion: release.currentVersion,
    minimumVersion: release.minimumSupportedVersion
      ?? i18n.messages.updateBlocker.unknownMinimumVersion,
    buildTimestamp: release.buildTimestamp
  });
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
  tasks?: TaskController,
  memory?: MemoryController,
  i18n: DesktopI18n = createDesktopI18n("zh-Hans"),
  languageSettings?: AppLanguageSettings
): HTMLElement {
  const island = document.createElement("section");
  island.className = `teti-island teti-island--${viewModel.panel} teti-island--${viewModel.character}`;
  island.setAttribute("aria-label", viewModel.title);

  if (viewModel.panel === "expanded") {
    island.append(createIslandHeader(
      config,
      passport,
      tasks,
      connections,
      memory,
      i18n,
      languageSettings
    ));
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
    const unreadStageResultCount = tasks?.snapshot.summary.unreadStageResultCount ?? 0;
    const taskAttentionCount = pendingTaskCount + unreadStageResultCount;
    const openLabel = taskAttentionCount > 0
      ? i18n.formatPlural(taskAttentionCount, i18n.messages.shell.openPendingTasks)
      : pendingCount > 0
        ? i18n.formatPlural(pendingCount, i18n.messages.shell.openPendingConnections)
        : i18n.messages.shell.openTeti;
    face.setAttribute("aria-label", openLabel);
    face.setAttribute("title", openLabel);
    if (pendingCount > 0 || taskAttentionCount > 0) {
      face.classList.add("teti-face--attention");
      const indicator = document.createElement("span");
      indicator.className = "teti-pending-indicator";
      indicator.setAttribute("aria-hidden", "true");
      face.append(indicator);
    }
    face.addEventListener("click", () => {
      passport?.closePanel();
      if (taskAttentionCount > 0) tasks?.openInbox();
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
    input.setAttribute("aria-label", i18n.messages.shell.nameInputLabel);
    input.addEventListener("input", () => {
      const truncated = truncateTetiDisplayName(input.value);
      if (truncated !== input.value) input.value = truncated;
      coordinator?.updateName(truncated);
      updateNameCounter(input, inputMeta, viewModel.input?.maxCharacters);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && coordinator && !viewModel.input?.disabled) {
        event.preventDefault();
        void submitAndRender(
          coordinator,
          island.ownerDocument.getElementById("app"),
          config,
          connections,
          passport,
          tasks,
          memory,
          i18n
        );
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
    button.disabled = Boolean(viewModel.input?.disabled && viewModel.primaryActionKind !== "finish");
    button.addEventListener("click", () => {
      if (viewModel.primaryActionKind === "show_naming") {
        coordinator.showNaming();
        renderSnapshot(
          island.ownerDocument.getElementById("app") as HTMLElement,
          coordinator.snapshot,
          config,
          coordinator,
          connections,
          passport,
          tasks,
          memory,
          undefined,
          i18n
        );
        return;
      }

      if (viewModel.primaryActionKind === "finish") {
        coordinator.collapseReadyToIdle();
        renderSnapshot(
          island.ownerDocument.getElementById("app") as HTMLElement,
          coordinator.snapshot,
          config,
          coordinator,
          connections,
          passport,
          tasks,
          memory,
          undefined,
          i18n
        );
        return;
      }

      if (viewModel.primaryActionKind === "retry_network") {
        void retryDiscoveryAndRender(
          coordinator,
          island.ownerDocument.getElementById("app"),
          config,
          connections,
          passport,
          tasks,
          memory,
          i18n
        );
        return;
      }

      void submitAndRender(
        coordinator,
        island.ownerDocument.getElementById("app"),
        config,
        connections,
        passport,
        tasks,
        memory,
        i18n
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
  tasks?: TaskController,
  memory?: MemoryController,
  i18n: DesktopI18n = createDesktopI18n("zh-Hans"),
  languageSettings?: AppLanguageSettings
): HTMLElement {
  const snapshot = controller.snapshot;
  const passportViewModel = toPassportViewModel(
    passport?.snapshot ?? defaultPassportSnapshot(),
    new Date(),
    i18n
  );
  const island = document.createElement("section");
  island.className = `teti-island teti-island--expanded teti-island--connections${
    snapshot.expandedRequestId ? " has-peer-details" : ""
  }`;
  island.setAttribute("aria-label", i18n.messages.connections.surfaceLabel);
  island.setAttribute("aria-busy", String(snapshot.busy));
  island.append(createConnectionHeader(
    config,
    passport,
    tasks,
    controller,
    memory,
    i18n,
    languageSettings
  ));

  const panelState = snapshot.connectPanel.state;
  const face = document.createElement("button");
  face.className = `teti-face teti-face--ready teti-connect-eyes is-${panelState}`;
  face.type = "button";
  face.setAttribute("aria-label", connectEyesLabel(panelState, i18n));
  face.setAttribute("aria-controls", "teti-connect-panel");
  face.setAttribute("aria-expanded", String(!["idle", "closing"].includes(panelState)));
  face.setAttribute("aria-disabled", String(["opening", "connecting", "closing"].includes(panelState)));
  face.disabled = ["opening", "connecting", "closing"].includes(panelState);
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
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", i18n.messages.connections.surfaceLabel);
    panel.setAttribute("aria-busy", String(panelState === "connecting"));
    const form = document.createElement("form");
    form.className = "teti-connect-form";
    const inputShell = document.createElement("div");
    inputShell.className = "teti-connect-input-shell";
    const input = document.createElement("input");
    input.className = "teti-input teti-connect-input";
    input.value = snapshot.input;
    input.placeholder = i18n.messages.connections.panel.placeholder;
    input.disabled = !["editing", "error"].includes(panelState);
    input.maxLength = 9;
    input.autocapitalize = "none";
    input.spellcheck = false;
    input.setAttribute("aria-label", i18n.messages.connections.panel.inputLabel);
    input.setAttribute("aria-describedby", "teti-connect-inline-status");
    const inlineStatus = document.createElement("div");
    inlineStatus.id = "teti-connect-inline-status";
    inlineStatus.className = "teti-connect-inline-status";
    inlineStatus.setAttribute("role", "status");
    inlineStatus.setAttribute("aria-live", "polite");
    const connect = document.createElement("button");
    connect.className = "teti-connect-button";
    connect.type = "submit";
    connect.setAttribute("title", i18n.messages.connections.panel.connectAction);
    connect.setAttribute("aria-label", i18n.messages.connections.panel.connectAction);
    connect.append(createElement(Link2, { width: 19, height: 19, "stroke-width": 2, "aria-hidden": "true" }));
    const syncForm = () => syncConnectForm(
      controller.snapshot,
      panel,
      face,
      inputShell,
      input,
      connect,
      inlineStatus,
      i18n
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
    const list = document.createElement("ul");
    list.className = "teti-connection-list";
    list.setAttribute("aria-label", i18n.messages.connections.list.label);
    for (const connection of passportViewModel.connections) {
      list.append(createConnectionRow(
        connection,
        snapshot.busy,
        snapshot.mutation?.requestId === connection.requestId ? snapshot.mutation : undefined,
        snapshot.mutationError?.requestId === connection.requestId
          ? snapshot.mutationError
          : undefined,
        connection.requestId === snapshot.highlightedRequestId,
        controller,
        connection.requestId === snapshot.expandedRequestId,
        i18n
      ));
    }
    content.append(list);
  }

  island.append(content);
  installConnectionPanelInteractions(island, controller, passport, i18n);
  if (snapshot.expandedRequestId) scheduleConnectionDetailLayout(island, controller);
  return island;
}

function syncConnectForm(
  snapshot: PeerConnectionSnapshot,
  panel: HTMLElement,
  face: HTMLButtonElement,
  inputShell: HTMLElement,
  input: HTMLInputElement,
  connect: HTMLButtonElement,
  inlineStatus: HTMLElement,
  i18n: DesktopI18n
): void {
  const state = snapshot.connectPanel.state;
  if (input.value !== snapshot.input) input.value = snapshot.input;
  input.disabled = !["editing", "error"].includes(state);
  connect.disabled = state !== "editing" && state !== "error"
    || !/^[a-z0-9]{9}$/.test(snapshot.input);
  panel.className = `teti-connect-panel is-${state}`;
  face.className = `teti-face teti-face--ready teti-connect-eyes is-${state}`;
  face.setAttribute("aria-label", connectEyesLabel(state, i18n));
  face.setAttribute("aria-expanded", String(!["idle", "closing"].includes(state)));
  face.setAttribute("aria-disabled", String(["opening", "connecting", "closing"].includes(state)));
  face.disabled = ["opening", "connecting", "closing"].includes(state);
  panel.setAttribute("aria-busy", String(state === "connecting"));
  input.setAttribute("aria-invalid", String(state === "error"));
  const hasInlineStatus = ["connecting", "success", "error"].includes(state);
  inputShell.classList.toggle("has-inline-status", hasInlineStatus);
  inputShell.classList.toggle("is-error", state === "error");
  inputShell.classList.toggle("is-success", state === "success");
  inputShell.classList.toggle("is-progress", state === "connecting");
  if (state !== "error") inputShell.classList.remove("is-revealing-value");
  inlineStatus.textContent = hasInlineStatus
    ? connectPanelMessage(snapshot.connectPanel.messageCode, i18n)
    : "";
}

function connectEyesLabel(state: string, i18n: DesktopI18n): string {
  const messages = i18n.messages.connections.panel.eyes;
  if (state === "idle") return messages.open;
  if (state === "connecting") return messages.connecting;
  if (state === "opening" || state === "closing") return messages.transitioning;
  return messages.close;
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
  passport: PassportController | undefined,
  i18n: DesktopI18n
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
    const expandedDisclosure = island.querySelector<HTMLButtonElement>(
      ".teti-connection-disclosure[aria-expanded='true']"
    );
    if (expandedDisclosure) {
      updateConnectionAccordion(island, null, controller, i18n);
      expandedDisclosure.focus({ preventScroll: true });
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
  mutation: PeerConnectionMutationStatus | undefined,
  mutationError: PeerConnectionMutationStatus | undefined,
  highlighted: boolean,
  controller: PeerConnectionController,
  expanded: boolean,
  i18n: DesktopI18n
): HTMLElement {
  const row = document.createElement("li");
  row.className = `teti-connection-row is-${connection.state.toLowerCase()}${
    highlighted ? " is-highlighted" : ""
  }${expanded ? " is-expanded" : ""}`;
  row.dataset.requestId = connection.requestId;
  const main = document.createElement("div");
  main.className = "teti-connection-row-main";
  const identity = document.createElement("div");
  identity.className = "teti-connection-identity";
  const name = document.createElement("strong");
  name.id = `${connectionDetailsId(connection.requestId)}-label`;
  name.textContent = connection.displayName;
  name.title = connection.identityLabel;
  const publicId = document.createElement("small");
  publicId.textContent = connection.publicIdCode;
  identity.append(name, publicId);

  const state = document.createElement("div");
  state.className = "teti-connection-state";
  row.setAttribute("aria-busy", String(Boolean(mutation)));
  if (connection.state === "Confirmed") {
    row.classList.add(`is-${connection.reachability}`);
    row.classList.add(`is-compatibility-${connection.compatibility.replace("_", "-")}`);
    main.append(createRemoteTetiAvatar({
      reachability: connection.reachability,
      label: connection.reachabilityLabel,
      ariaLabel: formatMessage(i18n.messages.connections.list.reachability.peerStatus, {
        status: connection.reachabilityLabel
      }),
      size: 28
    }));
    if (connection.compatibility === "compatible") {
      state.append(createRemotePassport(connection.passport, i18n));
    } else {
      const compatibility = document.createElement("span");
      compatibility.className = `teti-peer-compatibility is-${connection.compatibility.replace("_", "-")}`;
      const compatibilityTitle = document.createElement("strong");
      compatibilityTitle.textContent = connection.compatibility === "upgrade_required"
        ? i18n.messages.connections.list.compatibility.upgradeRequired
        : connection.compatibility === "unavailable"
          ? i18n.messages.connections.list.compatibility.unavailable
          : i18n.messages.connections.list.compatibility.checking;
      const compatibilityHint = document.createElement("small");
      compatibilityHint.textContent = connection.compatibility === "upgrade_required"
        ? i18n.messages.connections.list.compatibility.upgradeHint
        : connection.compatibility === "unavailable"
          ? i18n.messages.connections.list.compatibility.unavailableHint
          : i18n.messages.connections.list.compatibility.checkingHint;
      compatibility.append(compatibilityTitle, compatibilityHint);
      state.append(compatibility);
    }
  } else if (connection.state === "PendingApproval") {
    if (mutation) {
      row.classList.add("is-mutating");
      const progress = document.createElement("span");
      progress.className = "teti-connection-mutation";
      progress.setAttribute("role", "status");
      progress.setAttribute("aria-live", "polite");
      const spinner = document.createElement("span");
      spinner.className = "teti-connection-mutation-spinner";
      spinner.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.textContent = mutation.kind === "accept"
        ? i18n.messages.connections.list.accepting
        : i18n.messages.connections.list.rejecting;
      progress.append(spinner, label);
      state.append(progress);
    } else {
      const actions = document.createElement("span");
      actions.className = "teti-connection-actions";
      const accept = iconButton(
        Check,
        i18n.messages.connections.list.accept,
        () => void controller.accept(connection.requestId)
      );
      const reject = iconButton(
        X,
        i18n.messages.connections.list.reject,
        () => void controller.reject(connection.requestId)
      );
      accept.disabled = busy;
      reject.disabled = busy;
      actions.append(accept, reject);
      state.append(actions);
      if (mutationError) {
        const error = document.createElement("small");
        error.className = "teti-connection-mutation-error";
        error.setAttribute("role", "alert");
        error.textContent = mutationError.kind === "accept"
          ? i18n.messages.connections.list.acceptFailed
          : i18n.messages.connections.list.rejectFailed;
        state.append(error);
      }
    }
  } else if (connection.state === "Requested") {
    state.textContent = i18n.messages.connections.list.waitingApproval;
  } else if (connection.state === "Rejected") {
    state.textContent = i18n.messages.connections.list.rejected;
  } else {
    state.textContent = connection.state;
  }
  main.append(identity, state);
  if (connection.state === "Confirmed" && connection.compatibility === "compatible") {
    const disclosure = iconButton(
      ChevronDown,
      connectionDisclosureLabel(connection.identityLabel, expanded, i18n),
      () => updateConnectionAccordion(
        row.closest<HTMLElement>(".teti-island--connections")!,
        disclosure.getAttribute("aria-expanded") === "true" ? null : connection.requestId,
        controller,
        i18n
      )
    );
    disclosure.classList.add("teti-connection-disclosure");
    disclosure.dataset.focusKey = connectionFocusKey(connection.requestId);
    disclosure.setAttribute("aria-controls", connectionDetailsId(connection.requestId));
    disclosure.setAttribute("aria-expanded", String(expanded));
    main.append(disclosure);
    row.append(main, createConnectionDetails(connection, expanded, i18n));
  } else {
    row.append(main);
  }
  return row;
}

function createConnectionDetails(
  connection: ConnectionCardViewModel,
  expanded: boolean,
  i18n: DesktopI18n
): HTMLElement {
  const panel = document.createElement("section");
  panel.className = `teti-peer-details${expanded ? " is-expanded" : ""}`;
  panel.id = connectionDetailsId(connection.requestId);
  panel.setAttribute("aria-labelledby", `${panel.id}-label`);
  panel.setAttribute("aria-hidden", String(!expanded));
  panel.inert = !expanded;
  const inner = document.createElement("div");
  inner.className = "teti-peer-details-inner";
  inner.append(createRemotePassportDetails(connection.passport, i18n));
  panel.append(inner);
  return panel;
}

function updateConnectionAccordion(
  island: HTMLElement,
  requestId: string | null,
  controller: PeerConnectionController,
  i18n: DesktopI18n
): void {
  island.classList.toggle("has-peer-details", requestId !== null);
  for (const row of island.querySelectorAll<HTMLElement>(".teti-connection-row.is-confirmed")) {
    const isExpanded = requestId !== null && row.dataset.requestId === requestId;
    row.classList.toggle("is-expanded", isExpanded);
    const disclosure = row.querySelector<HTMLButtonElement>(".teti-connection-disclosure");
    const details = row.querySelector<HTMLElement>(".teti-peer-details");
    if (disclosure) {
      disclosure.setAttribute("aria-expanded", String(isExpanded));
      const identity = row.querySelector<HTMLElement>(".teti-connection-identity strong")?.textContent
        ?? i18n.messages.connections.list.unknownPeer;
      const label = connectionDisclosureLabel(identity, isExpanded, i18n);
      disclosure.setAttribute("aria-label", label);
      disclosure.title = label;
    }
    if (details) {
      details.classList.toggle("is-expanded", isExpanded);
      details.setAttribute("aria-hidden", String(!isExpanded));
      details.inert = !isExpanded;
    }
  }
  if (requestId === null) {
    island.style.removeProperty("--teti-peer-details-max-height");
    island.classList.remove("has-constrained-peer-list");
    controller.closeDetails({ notify: false });
    return;
  }
  controller.openDetails(requestId, { notify: false });
  const expandedRow = [...island.querySelectorAll<HTMLElement>(".teti-connection-row")]
    .find((row) => row.dataset.requestId === requestId);
  scheduleConnectionDetailLayout(island, controller);
  requestAnimationFrame(() => expandedRow?.scrollIntoView({
    block: "nearest",
    behavior: prefersReducedMotion(island) ? "auto" : "smooth"
  }));
}

function scheduleConnectionDetailLayout(
  island: HTMLElement,
  controller: PeerConnectionController
): void {
  const view = island.ownerDocument.defaultView;
  const details = island.querySelector<HTMLElement>(".teti-peer-details.is-expanded");
  if (!view || !details) return;

  const generation = String(Number(details.dataset.layoutGeneration ?? "0") + 1);
  details.dataset.layoutGeneration = generation;
  const measure = () => {
    view.requestAnimationFrame(() => {
      view.requestAnimationFrame(() => {
        if (details.dataset.layoutGeneration === generation) {
          syncConnectionDetailLayout(island, controller, true);
        }
      });
    });
  };

  measure();
  if (prefersReducedMotion(island)) return;

  let fallback: number | undefined;
  const settle = () => {
    if (fallback !== undefined) view.clearTimeout(fallback);
    details.removeEventListener("transitionend", onTransitionEnd);
    measure();
  };
  const onTransitionEnd = (event: TransitionEvent) => {
    if (event.target === details && event.propertyName === "grid-template-rows") settle();
  };
  details.addEventListener("transitionend", onTransitionEnd);
  fallback = view.setTimeout(settle, CONNECTION_DETAILS_TRANSITION_MS + 60);
}

function syncConnectionDetailLayout(
  island: HTMLElement,
  controller: PeerConnectionController,
  settleAfterNativeResize: boolean
): void {
  if (!island.isConnected || !island.classList.contains("has-peer-details")) return;
  const content = island.querySelector<HTMLElement>(".teti-connection-content");
  const details = island.querySelector<HTMLElement>(".teti-peer-details.is-expanded");
  const sections = details?.querySelector<HTMLElement>(".teti-peer-details-sections");
  const view = island.ownerDocument.defaultView;
  if (!content || !details || !sections || !view) return;

  const islandStyle = view.getComputedStyle(island);
  const verticalChrome = cssPixels(islandStyle.paddingTop) + cssPixels(islandStyle.paddingBottom);
  const hiddenDetailOverflow = Math.max(0, sections.scrollHeight - sections.clientHeight);
  const naturalDetailHeight = sections.scrollHeight;
  const naturalWindowHeight = verticalChrome + content.scrollHeight + hiddenDetailOverflow;
  const screenHeight = cssPixels(
    island.ownerDocument.documentElement.style.getPropertyValue("--teti-screen-height")
  ) || view.screen.availHeight;
  const layout = resolveConnectionDetailLayout(
    naturalWindowHeight,
    naturalDetailHeight,
    screenHeight
  );

  island.style.setProperty(
    "--teti-peer-details-max-height",
    `${Math.max(0, layout.detailViewportHeight)}px`
  );
  island.classList.toggle("has-constrained-peer-list", layout.listConstrained);
  const resized = controller.resizeDetails(layout.windowHeight);
  if (!settleAfterNativeResize) return;
  void resized.then(() => {
    view.requestAnimationFrame(() => {
      view.requestAnimationFrame(() => syncConnectionDetailLayout(island, controller, false));
    });
  });
}

function cssPixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function prefersReducedMotion(element: HTMLElement): boolean {
  return element.ownerDocument.defaultView
    ?.matchMedia("(prefers-reduced-motion: reduce)").matches ?? false;
}

function connectionFocusKey(requestId: string): string {
  return `peer:${requestId}`;
}

function connectionDetailsId(requestId: string): string {
  const safeId = requestId.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 72) || "peer";
  return `teti-peer-details-${safeId}`;
}

function createConnectionHeader(
  config: ProvisioningModeConfig,
  passport?: PassportController,
  tasks?: TaskController,
  connections?: PeerConnectionController,
  memory?: MemoryController,
  i18n: DesktopI18n = createDesktopI18n("zh-Hans"),
  languageSettings?: AppLanguageSettings
): HTMLElement {
  return createIslandHeader(
    config,
    passport,
    tasks,
    connections,
    memory,
    i18n,
    languageSettings
  );
}

function connectionDisclosureLabel(
  identity: string,
  expanded: boolean,
  i18n: DesktopI18n
): string {
  return formatMessage(
    expanded
      ? i18n.messages.connections.list.collapseDetails
      : i18n.messages.connections.list.expandDetails,
    { identity }
  );
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
  connections?: PeerConnectionController,
  memory?: MemoryController,
  i18n: DesktopI18n = createDesktopI18n("zh-Hans"),
  languageSettings?: AppLanguageSettings
): HTMLElement {
  const header = document.createElement("header");
  header.className = "teti-header";

  const brand = createTetiBotBrandLink({
    ownerDocument: header.ownerDocument,
    label: formatMessage(i18n.messages.brand.websiteLabel, { brand: "Teti.bot" })
  });

  const controls = document.createElement("div");
  controls.className = "teti-header-controls";
  const snapshot = passport?.snapshot ?? defaultPassportSnapshot();
  const viewModel = toPassportViewModel(snapshot, new Date(), i18n);
  const statusPanel = createAiPassportPanel(viewModel.aiPanel, i18n);
  const sharingPanel = createPassportSettingsPanel(
    viewModel.settings,
    passport,
    memory,
    viewModel.aiPanel.agents,
    i18n,
    languageSettings
  );
  const statusButton = createHeaderButton(
    null,
    formatMessage(i18n.messages.toolbar.aiPassport, {
      plan: viewModel.aiPanel.resources[0]?.planLabel
        ?? i18n.messages.toolbar.aiPassportUnavailable
    }),
    statusPanel,
    controls,
    createToolbarAssetIcon(aiToolsButtonIconUrl, "ai-tools"),
    snapshot.openPanel === "passport",
    passport ? () => passport.togglePanel("passport") : undefined
  );
  const sharingButton = createHeaderButton(
    null,
    viewModel.settings.enabled
      ? i18n.messages.toolbar.passportSharingEnabled
      : i18n.messages.toolbar.passportSettings,
    sharingPanel,
    controls,
    createToolbarAssetIcon(settingsButtonIconUrl, "settings"),
    snapshot.openPanel === "sharing",
    passport ? () => passport.togglePanel("sharing") : undefined
  );
  sharingButton.classList.toggle("is-sharing-enabled", viewModel.settings.enabled);
  const taskButton = iconButton(ClipboardList, i18n.messages.toolbar.collaborationTasks, () => {
    connections?.close("switch-to-task");
    passport?.closePanel(false);
    tasks?.openInbox();
  });
  taskButton.classList.add("teti-task-header-button");
  const pendingTasks = (tasks?.snapshot.summary.pendingIncomingCount ?? 0)
    + (tasks?.snapshot.summary.unreadStageResultCount ?? 0);
  if (pendingTasks > 0) {
    taskButton.classList.add("has-task-badge");
    taskButton.dataset.count = String(Math.min(pendingTasks, 9));
  }
  controls.append(
    taskButton,
    createHeaderPanelAnchor(statusButton, statusPanel),
    createHeaderPanelAnchor(sharingButton, sharingPanel)
  );

  header.append(brand, controls);
  return header;
}

function createHeaderPanelAnchor(button: HTMLButtonElement, panel: HTMLElement): HTMLElement {
  const anchor = document.createElement("div");
  anchor.className = "teti-header-panel-anchor";
  anchor.append(button, panel);
  return anchor;
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
  if (panel.id) button.setAttribute("aria-controls", panel.id);
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
    osaurusNative: { schemaVersion: 1, agentId: null, readiness: "unconfigured" },
    osaurusNativeBusy: false,
    openPanel: null
  };
}

interface ScreenMetrics {
  height?: number;
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
    root.style.setProperty("--teti-screen-height", `${nonNegative(metrics?.height)}px`);
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
  tasks?: TaskController,
  memory?: MemoryController,
  i18n: DesktopI18n = createDesktopI18n("zh-Hans")
): Promise<void> {
  const pending = coordinator.submitName();
  if (root) {
    renderSnapshot(
      root,
      coordinator.snapshot,
      config,
      coordinator,
      connections,
      passport,
      tasks,
      memory,
      undefined,
      i18n
    );
  }

  await pending;
  if (coordinator.snapshot.account && passport) {
    passport.start();
    await passport.refreshNow();
  }
  if (root) {
    renderSnapshot(
      root,
      coordinator.snapshot,
      config,
      coordinator,
      connections,
      passport,
      tasks,
      memory,
      undefined,
      i18n
    );
  }
}

async function retryDiscoveryAndRender(
  coordinator: FirstLaunchCoordinator,
  root: HTMLElement | null,
  config: ProvisioningModeConfig,
  connections?: PeerConnectionController,
  passport?: PassportController,
  tasks?: TaskController,
  memory?: MemoryController,
  i18n: DesktopI18n = createDesktopI18n("zh-Hans")
): Promise<void> {
  const pending = coordinator.retryNetworkIdentity();
  if (root) {
    renderSnapshot(
      root,
      coordinator.snapshot,
      config,
      coordinator,
      connections,
      passport,
      tasks,
      memory,
      undefined,
      i18n
    );
  }

  await pending;
  if (root) {
    renderSnapshot(
      root,
      coordinator.snapshot,
      config,
      coordinator,
      connections,
      passport,
      tasks,
      memory,
      undefined,
      i18n
    );
  }
}
