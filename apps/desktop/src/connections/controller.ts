import type {
  PeerConnectionResult,
  PeerConnectionRequestOutcome,
  PublicTetiIdentity
} from "../lifecycle-bridge/protocol.ts";
import type { PassportConnectionSnapshot } from "../../../../core/passport/snapshot.ts";
import {
  normalizeTetiPublicIdCode,
  TETI_PUBLIC_ID_CODE_CHARACTERS_PATTERN,
  TETI_PUBLIC_ID_CODE_PATTERN
} from "../../../../core/identity/public-id.ts";
import type { LifecycleBridgeClient } from "../provisioning/bridge-lifecycle.ts";
import type { TauriNotchWindowController } from "../platform/tauri-notch-window.ts";
import {
  initialConnectPanelSnapshot,
  transitionConnectPanel,
  type ConnectPanelEvent,
  type ConnectPanelSnapshot
} from "./connect-panel-state.ts";

const AUTO_COLLAPSE_MS = 20_000;
export const CONNECT_PANEL_OPEN_MS = 220;
export const CONNECT_PANEL_CLOSE_MS = 190;
export const CONNECT_PANEL_SUCCESS_MS = 1_500;

export interface PeerConnectionClient {
  resolve(query: string): Promise<PublicTetiIdentity>;
  request(query: string): Promise<PeerConnectionCommandResult>;
  accept(requestId: string): Promise<void>;
  reject(requestId: string): Promise<void>;
}

export interface PeerConnectionCommandResult {
  requestOutcome?: PeerConnectionRequestOutcome;
}

export interface PeerConnectionSnapshot {
  open: boolean;
  input: string;
  busy: boolean;
  connectPanel: ConnectPanelSnapshot;
  highlightedRequestId?: string;
  resolved?: PublicTetiIdentity;
  connections: PassportConnectionSnapshot[];
  lastSnapshotAt?: string;
}

export class PeerConnectionController {
  private readonly client: PeerConnectionClient;
  private readonly notchWindow: TauriNotchWindowController;
  private readonly onChange: () => void;
  private readonly refreshPassport: () => Promise<void>;
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private snapshotValue: PeerConnectionSnapshot = {
    open: false,
    input: "",
    busy: false,
    connectPanel: initialConnectPanelSnapshot(),
    connections: []
  };
  private collapseToken = 0;
  private interactionActive = false;
  private disposed = false;
  private panelTimer: unknown;
  private readonly timers = new Set<unknown>();

  constructor(options: {
    client: PeerConnectionClient;
    notchWindow: TauriNotchWindowController;
    onChange: () => void;
    refreshPassport?: () => Promise<void>;
    schedule?: (callback: () => void, delayMs: number) => unknown;
    cancel?: (handle: unknown) => void;
  }) {
    this.client = options.client;
    this.notchWindow = options.notchWindow;
    this.onChange = options.onChange;
    this.refreshPassport = options.refreshPassport ?? (() => Promise.resolve());
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  get snapshot(): PeerConnectionSnapshot {
    return {
      ...this.snapshotValue,
      busy: this.snapshotValue.busy || this.snapshotValue.connectPanel.state === "connecting",
      connectPanel: { ...this.snapshotValue.connectPanel },
      resolved: this.snapshotValue.resolved ? { ...this.snapshotValue.resolved } : undefined,
      connections: this.snapshotValue.connections.map((connection) => structuredClone(connection))
    };
  }

  syncPassportConnections(connections: readonly PassportConnectionSnapshot[]): void {
    if (this.disposed) return;
    const hadPending = this.hasPendingApproval();
    this.snapshotValue.connections = connections.map((connection) => structuredClone(connection));
    this.snapshotValue.lastSnapshotAt = new Date().toISOString();
    if (!hadPending && this.hasPendingApproval() && !this.snapshotValue.open) {
      this.snapshotValue.open = true;
      this.resetConnectPanel();
      this.touch();
      void this.notchWindow.setMode("onboarding", "incoming-peer-connection").catch(() => undefined);
    }
  }

  open(): void {
    if (this.disposed) return;
    if (this.snapshotValue.open) {
      this.touch();
      return;
    }
    this.snapshotValue.open = true;
    this.resetConnectPanel();
    this.touch();
    this.onChange();
    void this.notchWindow.setMode("onboarding", "open-peer-connections").catch(() => undefined);
  }

  close(reason = "close-peer-connections"): void {
    if (this.snapshotValue.connectPanel.state === "connecting") return;
    this.collapseToken += 1;
    this.snapshotValue.open = false;
    this.resetConnectPanel();
    this.snapshotValue.highlightedRequestId = undefined;
    this.onChange();
    void this.notchWindow.setMode("idle", reason).catch(() => undefined);
  }

  dismissFromOutside(): void {
    if (this.snapshotValue.open && this.snapshotValue.connectPanel.state !== "connecting") {
      this.close("peer-panel-focus-lost");
    }
  }

  noteActivity(): void {
    if (this.snapshotValue.open) this.touch();
  }

  updateInput(value: string): void {
    if (!["editing", "error"].includes(this.snapshotValue.connectPanel.state)) return;
    const normalized = value.trim().toLowerCase().slice(0, 9);
    this.snapshotValue.input = normalized;
    this.transitionPanel(
      normalized && !TETI_PUBLIC_ID_CODE_CHARACTERS_PATTERN.test(normalized)
        ? { type: "VALIDATION_FAILED", message: "请输入正确的 9 位 ID" }
        : { type: "INPUT_CHANGED" }
    );
    this.snapshotValue.highlightedRequestId = undefined;
    this.snapshotValue.resolved = undefined;
    this.touch();
  }

  activateEyes(): void {
    const state = this.snapshotValue.connectPanel.state;
    if (state === "idle") {
      this.transitionPanel({ type: "EYES_CLICKED" });
      this.onChange();
      this.schedulePanelEvent(CONNECT_PANEL_OPEN_MS, { type: "OPEN_ANIMATION_FINISHED" });
      return;
    }
    if (state === "editing" || state === "error" || state === "success") {
      this.beginPanelClose({ type: "EYES_CLICKED" });
    }
  }

  handleEscape(): boolean {
    const state = this.snapshotValue.connectPanel.state;
    if (state === "idle") return false;
    if (state === "editing" || state === "error" || state === "success") {
      this.beginPanelClose({ type: "ESCAPE_PRESSED" });
    }
    return true;
  }

  closeConnectPanel(): void {
    if (["editing", "error", "success"].includes(this.snapshotValue.connectPanel.state)) {
      this.beginPanelClose({ type: "CLOSE_REQUESTED" });
    }
  }

  beginInteraction(): void {
    this.interactionActive = true;
    this.collapseToken += 1;
  }

  endInteraction(): void {
    this.interactionActive = false;
    this.touch();
  }

  async resolve(): Promise<void> {
    await this.run(async () => {
      this.snapshotValue.resolved = await this.client.resolve(this.snapshotValue.input);
    });
  }

  async connect(): Promise<void> {
    if (!["editing", "error"].includes(this.snapshotValue.connectPanel.state)) return;
    if (!TETI_PUBLIC_ID_CODE_PATTERN.test(this.snapshotValue.input)) {
      this.transitionPanel({ type: "VALIDATION_FAILED", message: "请输入正确的 9 位 ID" });
      this.onChange();
      return;
    }

    const input = this.snapshotValue.input;
    this.transitionPanel({ type: "SUBMIT" });
    this.snapshotValue.highlightedRequestId = undefined;
    this.touch();
    this.onChange();
    try {
      const result = await this.client.request(input);
      if (this.disposed) return;
      await this.refreshPassport();
      const outcome = this.connectOutcome(result);
      this.snapshotValue.resolved = undefined;
      this.transitionPanel(outcome.event);
      this.onChange();
      if (outcome.event.type === "CONNECT_SUCCEEDED") {
        this.schedulePanelEvent(CONNECT_PANEL_SUCCESS_MS, { type: "SUCCESS_TIMEOUT" });
      }
    } catch (error) {
      if (this.disposed) return;
      this.transitionPanel({ type: "CONNECT_FAILED", message: connectionErrorMessage(error) });
      this.onChange();
    }
  }

  async accept(requestId: string): Promise<void> {
    await this.run(async () => {
      await this.client.accept(requestId);
      await this.refreshPassport();
    });
  }

  async reject(requestId: string): Promise<void> {
    await this.run(async () => {
      await this.client.reject(requestId);
      await this.refreshPassport();
    });
  }

  private async run(operation: () => Promise<void>): Promise<void> {
    if (this.snapshotValue.busy || this.snapshotValue.connectPanel.state === "connecting") return;
    this.snapshotValue.busy = true;
    this.snapshotValue.highlightedRequestId = undefined;
    this.touch();
    this.onChange();
    try {
      await operation();
    } catch {
      // Existing cards remain intact; the next Passport read retries without leaking transport details.
    } finally {
      if (this.disposed) return;
      this.snapshotValue.busy = false;
      this.touch();
      this.onChange();
    }
  }

  private connectOutcome(result: PeerConnectionCommandResult): {
    event: Extract<ConnectPanelEvent, { type: "CONNECT_SUCCEEDED" | "CONNECT_FAILED" }>;
  } {
    const outcome = result.requestOutcome;
    if (!outcome) {
      return { event: { type: "CONNECT_SUCCEEDED", message: "建联请求已发送" } };
    }
    this.snapshotValue.highlightedRequestId = outcome.requestId;
    switch (outcome.kind) {
      case "created":
      case "alreadyRequested":
      case "confirming":
        return { event: { type: "CONNECT_SUCCEEDED", message: "建联请求已发送" } };
      case "approvalRequired":
        return { event: { type: "CONNECT_FAILED", message: "对方正在等待你确认" } };
      case "mutualConfirmed":
        return { event: { type: "CONNECT_SUCCEEDED", message: "已成功建联" } };
      case "alreadyConfirmed":
        return { event: { type: "CONNECT_FAILED", message: "你们已经建联" } };
      case "blocked":
        return { event: { type: "CONNECT_FAILED", message: "暂时无法完成建联，请稍后重试" } };
    }
  }

  private hasPendingApproval(): boolean {
    return this.snapshotValue.connections.some((connection) => connection.connectionState === "PendingApproval");
  }

  private touch(): void {
    const token = ++this.collapseToken;
    this.scheduleTask(() => {
      if (
        token === this.collapseToken &&
        this.snapshotValue.open &&
        !this.snapshotValue.busy &&
        this.snapshotValue.connectPanel.state === "idle" &&
        !this.interactionActive
      ) {
        this.close();
      }
    }, AUTO_COLLAPSE_MS);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const timer of this.timers) this.cancel(timer);
    this.timers.clear();
    this.panelTimer = undefined;
  }

  private beginPanelClose(event: ConnectPanelEvent): void {
    this.transitionPanel(event);
    if (this.snapshotValue.connectPanel.state !== "closing") return;
    this.onChange();
    this.schedulePanelEvent(CONNECT_PANEL_CLOSE_MS, { type: "CLOSE_ANIMATION_FINISHED" });
  }

  private schedulePanelEvent(delayMs: number, event: ConnectPanelEvent): void {
    this.clearPanelTimer();
    this.panelTimer = this.scheduleTask(() => {
      this.panelTimer = undefined;
      const previous = this.snapshotValue.connectPanel.state;
      this.transitionPanel(event);
      if (previous === this.snapshotValue.connectPanel.state) return;
      if (this.snapshotValue.connectPanel.state === "closing") {
        this.onChange();
        this.schedulePanelEvent(CONNECT_PANEL_CLOSE_MS, { type: "CLOSE_ANIMATION_FINISHED" });
        return;
      }
      if (this.snapshotValue.connectPanel.state === "idle") {
        this.snapshotValue.input = "";
        this.snapshotValue.highlightedRequestId = undefined;
        this.snapshotValue.resolved = undefined;
        this.touch();
      }
      this.onChange();
    }, delayMs);
  }

  private clearPanelTimer(): void {
    if (this.panelTimer === undefined) return;
    this.cancel(this.panelTimer);
    this.timers.delete(this.panelTimer);
    this.panelTimer = undefined;
  }

  private resetConnectPanel(): void {
    this.clearPanelTimer();
    this.snapshotValue.connectPanel = initialConnectPanelSnapshot();
    this.snapshotValue.input = "";
    this.snapshotValue.resolved = undefined;
  }

  private transitionPanel(event: ConnectPanelEvent): void {
    this.snapshotValue.connectPanel = transitionConnectPanel(this.snapshotValue.connectPanel, event);
  }

  private scheduleTask(callback: () => void, delayMs: number): unknown {
    let handle: unknown;
    handle = this.schedule(() => {
      this.timers.delete(handle);
      if (!this.disposed) callback();
    }, delayMs);
    this.timers.add(handle);
    return handle;
  }
}

function connectionErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "REQUEST_TIMEOUT") return "连接超时，请稍后重试";
    if (error.name === "CONNECTION_RESOLVE_FAILED") return "没有找到这个 Teti，请检查 ID";
  }
  return "暂时无法完成建联，请稍后重试";
}

export class BridgePeerConnectionClient implements PeerConnectionClient {
  private readonly bridge: LifecycleBridgeClient;

  constructor(bridge: LifecycleBridgeClient) {
    this.bridge = bridge;
  }

  resolve(query: string): Promise<PublicTetiIdentity> {
    return this.bridge.request("connection.resolve", { query }) as Promise<PublicTetiIdentity>;
  }

  async request(query: string): Promise<PeerConnectionCommandResult> {
    const result = await this.bridge.request("connection.request", { query }) as PeerConnectionResult;
    return result.requestOutcome ? { requestOutcome: result.requestOutcome } : {};
  }

  async accept(requestId: string): Promise<void> {
    await this.bridge.request("connection.accept", { requestId });
  }

  async reject(requestId: string): Promise<void> {
    await this.bridge.request("connection.reject", { requestId });
  }
}

export class MockPeerConnectionClient implements PeerConnectionClient {
  private connections: PassportConnectionSnapshot[] = [];
  private readonly onConnectionsChanged?: (connections: PassportConnectionSnapshot[]) => void;

  constructor(onConnectionsChanged?: (connections: PassportConnectionSnapshot[]) => void) {
    this.onConnectionsChanged = onConnectionsChanged;
  }

  async resolve(query: string): Promise<PublicTetiIdentity> {
    const publicId = normalizeTetiPublicIdCode(query);
    const id = `teti_${publicId}`;
    return {
      id,
      address: `${publicId}@mail.seep.im`,
      displayName: "Preview Teti",
      publicKey: "preview-public-key",
      publicProfile: { platform: "macOS" }
    };
  }

  async request(query: string): Promise<PeerConnectionCommandResult> {
    const identity = await this.resolve(query);
    const existing = this.connections.find((connection) => connection.identity.tetiId === identity.id);
    if (existing) {
      return { requestOutcome: {
        kind: existing.connectionState === "Confirmed" ? "alreadyConfirmed" : "alreadyRequested",
        requestId: existing.requestId,
        remoteTetiId: existing.identity.tetiId
      } };
    }
    const now = new Date().toISOString();
    this.connections = [{
      requestId: `preview_${Date.now()}`,
      connectionState: "Requested",
      direction: "outgoing",
      identity: {
        tetiId: identity.id,
        address: identity.address,
        ...(identity.displayName ? { displayName: identity.displayName } : {})
      },
      createdAt: now,
      updatedAt: now,
      lastSeen: null,
      passport: { state: "unknown", resources: [] }
    }];
    this.publish();
    return { requestOutcome: {
      kind: "created",
      requestId: this.connections[0].requestId,
      remoteTetiId: identity.id
    } };
  }

  async accept(): Promise<void> { this.publish(); }
  async reject(): Promise<void> { this.publish(); }

  private publish(): void {
    this.onConnectionsChanged?.(structuredClone(this.connections));
  }
}
