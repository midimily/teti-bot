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
import type { PanelDiagnosticSink } from "../platform/panel-diagnostics.ts";
import { readStableErrorCode } from "../errors/stable-error-code.ts";
import {
  initialConnectPanelSnapshot,
  transitionConnectPanel,
  type ConnectPanelEvent,
  type ConnectPanelMessageCode,
  type ConnectPanelSnapshot
} from "./connect-panel-state.ts";

const AUTO_COLLAPSE_MS = 20_000;
export const CONNECT_PANEL_OPEN_MS = 220;
export const CONNECT_PANEL_CLOSE_MS = 190;
export const CONNECT_PANEL_SUCCESS_MS = 1_500;
export const CONNECTION_DETAILS_TRANSITION_MS = 180;

export interface PeerConnectionClient {
  resolve(query: string): Promise<PublicTetiIdentity>;
  request(query: string): Promise<PeerConnectionCommandResult>;
  accept(requestId: string): Promise<PeerConnectionMutationResult>;
  reject(requestId: string): Promise<PeerConnectionMutationResult>;
  requestPassportRefresh?(requestId: string): Promise<void>;
}

export interface PeerConnectionCommandResult {
  requestOutcome?: PeerConnectionRequestOutcome;
}

export type PeerConnectionMutationKind = "accept" | "reject";

export interface PeerConnectionMutationResult {
  requestId: string;
  connectionState: "Confirmed" | "Rejected";
  updatedAt: string;
  confirmedAt?: string;
}

export interface PeerConnectionMutationStatus {
  requestId: string;
  kind: PeerConnectionMutationKind;
}

export interface PeerConnectionSnapshot {
  open: boolean;
  input: string;
  busy: boolean;
  connectPanel: ConnectPanelSnapshot;
  mutation?: PeerConnectionMutationStatus;
  mutationError?: PeerConnectionMutationStatus;
  expandedRequestId?: string;
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
  private readonly diagnostic: PanelDiagnosticSink;
  private snapshotValue: PeerConnectionSnapshot = {
    open: false,
    input: "",
    busy: false,
    connectPanel: initialConnectPanelSnapshot(),
    connections: []
  };
  private collapseToken = 0;
  private detailModeToken = 0;
  private interactionActive = false;
  private disposed = false;
  private outsideDismissPending = false;
  private panelTimer: unknown;
  private readonly timers = new Set<unknown>();
  private readonly optimisticMutations = new Map<string, PeerConnectionMutationResult>();

  constructor(options: {
    client: PeerConnectionClient;
    notchWindow: TauriNotchWindowController;
    onChange: () => void;
    refreshPassport?: () => Promise<void>;
    schedule?: (callback: () => void, delayMs: number) => unknown;
    cancel?: (handle: unknown) => void;
    diagnostic?: PanelDiagnosticSink;
  }) {
    this.client = options.client;
    this.notchWindow = options.notchWindow;
    this.onChange = options.onChange;
    this.refreshPassport = options.refreshPassport ?? (() => Promise.resolve());
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.diagnostic = options.diagnostic ?? (() => undefined);
  }

  get snapshot(): PeerConnectionSnapshot {
    return {
      ...this.snapshotValue,
      busy: this.snapshotValue.busy || this.snapshotValue.connectPanel.state === "connecting",
      connectPanel: { ...this.snapshotValue.connectPanel },
      mutation: this.snapshotValue.mutation ? { ...this.snapshotValue.mutation } : undefined,
      mutationError: this.snapshotValue.mutationError
        ? { ...this.snapshotValue.mutationError }
        : undefined,
      resolved: this.snapshotValue.resolved ? { ...this.snapshotValue.resolved } : undefined,
      connections: this.snapshotValue.connections.map((connection) => structuredClone(connection))
    };
  }

  syncPassportConnections(connections: readonly PassportConnectionSnapshot[]): void {
    if (this.disposed) return;
    const hadPending = this.hasPendingApproval();
    const visibleRequestIds = new Set(connections.map((connection) => connection.requestId));
    this.snapshotValue.connections = connections.map((connection) => {
      const optimistic = this.optimisticMutations.get(connection.requestId);
      if (!optimistic) return structuredClone(connection);
      if (connection.connectionState === optimistic.connectionState) {
        this.optimisticMutations.delete(connection.requestId);
        return structuredClone(connection);
      }
      if (connection.connectionState !== "PendingApproval") {
        this.optimisticMutations.delete(connection.requestId);
        return structuredClone(connection);
      }
      return projectConnectionMutation(connection, optimistic);
    });
    for (const requestId of this.optimisticMutations.keys()) {
      if (!visibleRequestIds.has(requestId)) this.optimisticMutations.delete(requestId);
    }
    if (this.snapshotValue.mutationError
      && !this.snapshotValue.connections.some((connection) =>
        connection.requestId === this.snapshotValue.mutationError?.requestId
        && connection.connectionState === "PendingApproval"
      )) {
      this.snapshotValue.mutationError = undefined;
    }
    if (this.snapshotValue.expandedRequestId
      && !this.snapshotValue.connections.some((connection) =>
        connection.requestId === this.snapshotValue.expandedRequestId
        && connection.connectionState === "Confirmed"
      )) {
      this.closeDetails({ notify: false });
    }
    this.snapshotValue.lastSnapshotAt = new Date().toISOString();
    if (!hadPending && this.hasPendingApproval() && !this.snapshotValue.open) {
      this.snapshotValue.open = true;
      this.resetConnectPanel();
      this.touch();
      void this.notchWindow.setMode("onboarding", "incoming-peer-connection").catch(() => undefined);
    }
  }

  open(reason = "open-peer-connections"): void {
    if (this.disposed) return;
    if (this.snapshotValue.open) {
      this.touch();
      this.onChange();
      void this.notchWindow.setMode(
        this.snapshotValue.expandedRequestId ? "connection_detail" : "onboarding",
        reason
      ).catch(() => undefined);
      return;
    }
    this.snapshotValue.open = true;
    this.resetConnectPanel();
    this.touch();
    this.onChange();
    void this.notchWindow.setMode("onboarding", reason).catch(() => undefined);
  }

  close(reason = "close-peer-connections"): void {
    if (this.snapshotValue.connectPanel.state === "connecting") return;
    this.outsideDismissPending = false;
    this.collapseToken += 1;
    this.detailModeToken += 1;
    this.snapshotValue.open = false;
    this.snapshotValue.expandedRequestId = undefined;
    this.resetConnectPanel();
    this.snapshotValue.highlightedRequestId = undefined;
    this.onChange();
    void this.notchWindow.setMode("idle", reason).catch(() => undefined);
  }

  dismissFromOutside(): void {
    if (!this.snapshotValue.open) return;
    if (this.snapshotValue.connectPanel.state === "connecting") {
      if (!this.outsideDismissPending) {
        this.outsideDismissPending = true;
        this.diagnostic({
          level: "warn",
          event: "panel.dismiss.deferred",
          fields: { surface: "connections", blocker: "connecting" }
        });
      }
      return;
    }
    this.diagnostic({
      level: "debug",
      event: "panel.dismiss.immediate",
      fields: { surface: "connections", connectState: this.snapshotValue.connectPanel.state }
    });
    this.close("peer-panel-focus-lost");
  }

  cancelPendingOutsideDismiss(): void {
    if (!this.outsideDismissPending) return;
    this.outsideDismissPending = false;
    this.diagnostic({
      level: "debug",
      event: "panel.dismiss.cancelled",
      fields: { surface: "connections", reason: "focus_regained" }
    });
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
        ? { type: "VALIDATION_FAILED", messageCode: "invalid_public_id" }
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
    if (this.snapshotValue.expandedRequestId) {
      this.closeDetails();
      return true;
    }
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

  openDetails(requestId: string, options: { notify?: boolean } = {}): void {
    if (this.disposed) return;
    const connection = this.snapshotValue.connections.find((item) => item.requestId === requestId);
    if (!connection || connection.connectionState !== "Confirmed") return;
    this.snapshotValue.expandedRequestId = requestId;
    this.detailModeToken += 1;
    this.touch();
    if (options.notify !== false) this.onChange();
    void this.notchWindow.setMode("connection_detail", "peer-details-open").catch(() => undefined);
    void this.client.requestPassportRefresh?.(requestId).catch((error) => {
      this.diagnostic({
        level: "warn",
        event: "connection-passport-refresh-failed",
        fields: {
          state: "failed",
          reason: readStableErrorCode(error) ?? "unknown"
        }
      });
    });
  }

  async resizeDetails(height: number): Promise<void> {
    if (this.disposed || !this.snapshotValue.expandedRequestId) return;
    await this.notchWindow
      .setConnectionDetailHeight(height, "peer-details-measured")
      .catch(() => undefined);
  }

  closeDetails(options: { notify?: boolean } = {}): void {
    if (!this.snapshotValue.expandedRequestId) return;
    this.snapshotValue.expandedRequestId = undefined;
    const token = ++this.detailModeToken;
    this.touch();
    if (options.notify !== false) this.onChange();
    this.scheduleTask(() => {
      if (token !== this.detailModeToken || !this.snapshotValue.open || this.snapshotValue.expandedRequestId) return;
      void this.notchWindow.setMode("onboarding", "peer-details-close").catch(() => undefined);
    }, CONNECTION_DETAILS_TRANSITION_MS);
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
      this.transitionPanel({ type: "VALIDATION_FAILED", messageCode: "invalid_public_id" });
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
      this.transitionPanel({ type: "CONNECT_FAILED", messageCode: connectionErrorCode(error) });
      this.onChange();
    }
    if (this.outsideDismissPending && this.snapshotValue.open && !this.disposed) {
      this.outsideDismissPending = false;
      this.diagnostic({
        level: "warn",
        event: "panel.dismiss.resolved",
        fields: { surface: "connections", blocker: "connecting" }
      });
      this.close("peer-panel-focus-lost-after-connect");
    } else {
      this.outsideDismissPending = false;
    }
  }

  async accept(requestId: string): Promise<void> {
    await this.mutateConnection(requestId, "accept", () => this.client.accept(requestId));
  }

  async reject(requestId: string): Promise<void> {
    await this.mutateConnection(requestId, "reject", () => this.client.reject(requestId));
  }

  private async mutateConnection(
    requestId: string,
    kind: PeerConnectionMutationKind,
    operation: () => Promise<PeerConnectionMutationResult>
  ): Promise<void> {
    if (this.snapshotValue.busy || this.snapshotValue.connectPanel.state === "connecting") return;
    const startedAt = Date.now();
    this.snapshotValue.busy = true;
    this.snapshotValue.mutation = { requestId, kind };
    this.snapshotValue.mutationError = undefined;
    this.snapshotValue.highlightedRequestId = undefined;
    this.touch();
    this.onChange();
    try {
      const result = await operation();
      if (this.disposed) return;
      this.optimisticMutations.set(result.requestId, { ...result });
      this.snapshotValue.connections = this.snapshotValue.connections.map((connection) =>
        connection.requestId === result.requestId
          ? projectConnectionMutation(connection, result)
          : connection
      );
      this.diagnostic({
        level: "debug",
        event: "connection.mutation.completed",
        fields: { kind, durationMs: Date.now() - startedAt }
      });
      void this.refreshPassport().catch(() => undefined);
    } catch (error) {
      if (this.disposed) return;
      this.snapshotValue.mutationError = { requestId, kind };
      this.diagnostic({
        level: "warn",
        event: "connection.mutation.failed",
        fields: {
          kind,
          durationMs: Date.now() - startedAt,
          code: readStableErrorCode(error) ?? "CONNECTION_REQUEST_FAILED"
        }
      });
    } finally {
      if (this.disposed) return;
      this.snapshotValue.busy = false;
      this.snapshotValue.mutation = undefined;
      this.touch();
      this.onChange();
    }
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
      return { event: { type: "CONNECT_SUCCEEDED", messageCode: "request_sent" } };
    }
    this.snapshotValue.highlightedRequestId = outcome.requestId;
    switch (outcome.kind) {
      case "created":
      case "alreadyRequested":
      case "confirming":
        return { event: { type: "CONNECT_SUCCEEDED", messageCode: "request_sent" } };
      case "approvalRequired":
        return { event: { type: "CONNECT_FAILED", messageCode: "approval_required" } };
      case "mutualConfirmed":
        return { event: { type: "CONNECT_SUCCEEDED", messageCode: "connected" } };
      case "alreadyConfirmed":
        return { event: { type: "CONNECT_FAILED", messageCode: "already_connected" } };
      case "blocked":
        return { event: { type: "CONNECT_FAILED", messageCode: "connection_failed" } };
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

function connectionErrorCode(error: unknown): ConnectPanelMessageCode {
  const code = readStableErrorCode(error);
  if (code === "REQUEST_TIMEOUT") return "connection_timeout";
  if (code === "CONNECTION_RESOLVE_FAILED") return "identity_not_found";
  return "connection_failed";
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

  async accept(requestId: string): Promise<PeerConnectionMutationResult> {
    const result = await this.bridge.request("connection.accept", { requestId }) as PeerConnectionResult;
    return mutationResult(result, requestId, "Confirmed");
  }

  async reject(requestId: string): Promise<PeerConnectionMutationResult> {
    const result = await this.bridge.request("connection.reject", { requestId }) as PeerConnectionResult;
    return mutationResult(result, requestId, "Rejected");
  }

  async requestPassportRefresh(requestId: string): Promise<void> {
    await this.bridge.request("connection.passport.refresh", { requestId });
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

  async requestPassportRefresh(_requestId: string): Promise<void> {}

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
      compatibility: "unknown",
      passport: { state: "unknown", resources: [], agents: [], capabilities: [], bindings: [], computeOffers: [] }
    }];
    this.publish();
    return { requestOutcome: {
      kind: "created",
      requestId: this.connections[0].requestId,
      remoteTetiId: identity.id
    } };
  }

  async accept(requestId: string): Promise<PeerConnectionMutationResult> {
    return this.mutate(requestId, "Confirmed");
  }

  async reject(requestId: string): Promise<PeerConnectionMutationResult> {
    return this.mutate(requestId, "Rejected");
  }

  private mutate(
    requestId: string,
    connectionState: PeerConnectionMutationResult["connectionState"]
  ): PeerConnectionMutationResult {
    const now = new Date().toISOString();
    const connection = this.connections.find((item) => item.requestId === requestId);
    if (!connection) throw connectionMutationError();
    connection.connectionState = connectionState;
    connection.updatedAt = now;
    if (connectionState === "Confirmed") connection.confirmedAt = now;
    this.publish();
    return {
      requestId,
      connectionState,
      updatedAt: now,
      ...(connectionState === "Confirmed" ? { confirmedAt: now } : {})
    };
  }

  private publish(): void {
    this.onConnectionsChanged?.(structuredClone(this.connections));
  }
}

function mutationResult(
  result: PeerConnectionResult,
  requestId: string,
  expectedState: PeerConnectionMutationResult["connectionState"]
): PeerConnectionMutationResult {
  const connection = result.connections.find((item) => item.requestId === requestId);
  if (!connection || connection.state !== expectedState) throw connectionMutationError();
  return {
    requestId,
    connectionState: expectedState,
    updatedAt: connection.updatedAt,
    ...(connection.confirmedAt ? { confirmedAt: connection.confirmedAt } : {})
  };
}

function projectConnectionMutation(
  connection: PassportConnectionSnapshot,
  result: PeerConnectionMutationResult
): PassportConnectionSnapshot {
  return {
    ...structuredClone(connection),
    connectionState: result.connectionState,
    updatedAt: result.updatedAt,
    ...(result.confirmedAt ? { confirmedAt: result.confirmedAt } : {})
  };
}

function connectionMutationError(): Error {
  const error = new Error("The connection mutation returned an invalid state.");
  error.name = "CONNECTION_REQUEST_FAILED";
  return error;
}
