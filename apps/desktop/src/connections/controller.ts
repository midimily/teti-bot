import type {
  PeerConnectionDto,
  PeerConnectionResult,
  PublicTetiIdentity
} from "../lifecycle-bridge/protocol.ts";
import type { LifecycleBridgeClient } from "../provisioning/bridge-lifecycle.ts";
import type { TauriNotchWindowController } from "../platform/tauri-notch-window.ts";

const POLL_INTERVAL_MS = 3_000;
const AUTO_COLLAPSE_MS = 12_000;

export interface PeerConnectionClient {
  resolve(query: string): Promise<PublicTetiIdentity>;
  request(query: string): Promise<PeerConnectionResult>;
  list(): Promise<PeerConnectionResult>;
  poll(): Promise<PeerConnectionResult>;
  accept(requestId: string): Promise<PeerConnectionResult>;
  reject(requestId: string): Promise<PeerConnectionResult>;
}

export interface PeerConnectionSnapshot {
  open: boolean;
  input: string;
  busy: boolean;
  error?: string;
  notice?: string;
  highlightedRequestId?: string;
  resolved?: PublicTetiIdentity;
  connections: PeerConnectionDto[];
  lastPolledAt?: string;
}

export class PeerConnectionController {
  private readonly client: PeerConnectionClient;
  private readonly notchWindow: TauriNotchWindowController;
  private readonly onChange: () => void;
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private snapshotValue: PeerConnectionSnapshot = {
    open: false,
    input: "",
    busy: false,
    connections: []
  };
  private polling = false;
  private collapseToken = 0;
  private interactionActive = false;

  constructor(options: {
    client: PeerConnectionClient;
    notchWindow: TauriNotchWindowController;
    onChange: () => void;
    schedule?: (callback: () => void, delayMs: number) => unknown;
  }) {
    this.client = options.client;
    this.notchWindow = options.notchWindow;
    this.onChange = options.onChange;
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  }

  get snapshot(): PeerConnectionSnapshot {
    return {
      ...this.snapshotValue,
      resolved: this.snapshotValue.resolved ? { ...this.snapshotValue.resolved } : undefined,
      connections: this.snapshotValue.connections.map((connection) => ({ ...connection }))
    };
  }

  async initialize(): Promise<void> {
    try {
      this.applyResult(await this.client.list());
    } catch {
      // The first background poll will retry without interrupting the desktop shell.
    }
    this.schedulePoll();
  }

  open(): void {
    this.snapshotValue.open = true;
    this.snapshotValue.error = undefined;
    void this.notchWindow.setMode("onboarding", "open-peer-connections").then(() => {
      if (this.snapshotValue.open) this.onChange();
    });
    this.touch();
    this.onChange();
  }

  close(): void {
    this.collapseToken += 1;
    this.snapshotValue.open = false;
    this.snapshotValue.error = undefined;
    this.snapshotValue.notice = undefined;
    this.snapshotValue.highlightedRequestId = undefined;
    void this.notchWindow.setMode("idle", "close-peer-connections");
    this.onChange();
  }

  updateInput(value: string): void {
    this.snapshotValue.input = value.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 9);
    this.snapshotValue.error = undefined;
    this.snapshotValue.notice = undefined;
    this.snapshotValue.highlightedRequestId = undefined;
    this.snapshotValue.resolved = undefined;
    this.touch();
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
    await this.run(async () => {
      const result = await this.client.request(this.snapshotValue.input);
      this.applyResult(result);
      this.applyRequestOutcome(result);
      this.snapshotValue.input = "";
      this.snapshotValue.resolved = undefined;
    });
  }

  async accept(requestId: string): Promise<void> {
    await this.run(async () => this.applyResult(await this.client.accept(requestId)));
  }

  async reject(requestId: string): Promise<void> {
    await this.run(async () => this.applyResult(await this.client.reject(requestId)));
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const result = await this.client.poll();
      const hadPending = this.hasPendingApproval();
      this.applyResult(result);
      this.snapshotValue.lastPolledAt = new Date().toISOString();
      if (!hadPending && this.hasPendingApproval() && !this.snapshotValue.open) {
        this.open();
      } else if (this.snapshotValue.open || result.receivedCount > 0 || result.heartbeatCount > 0) {
        this.onChange();
      }
    } catch (error) {
      if (this.snapshotValue.open) {
        this.snapshotValue.error = error instanceof Error ? error.message : "暂时无法检查连接消息。";
        this.onChange();
      }
    } finally {
      this.polling = false;
      this.schedulePoll();
    }
  }

  private schedulePoll(): void {
    this.schedule(() => void this.poll(), POLL_INTERVAL_MS);
  }

  private async run(operation: () => Promise<void>): Promise<void> {
    if (this.snapshotValue.busy) return;
    this.snapshotValue.busy = true;
    this.snapshotValue.error = undefined;
    this.snapshotValue.notice = undefined;
    this.snapshotValue.highlightedRequestId = undefined;
    this.touch();
    this.onChange();
    try {
      await operation();
    } catch (error) {
      this.snapshotValue.error = error instanceof Error ? error.message : "连接操作没有完成。";
    } finally {
      this.snapshotValue.busy = false;
      this.touch();
      this.onChange();
    }
  }

  private applyResult(result: PeerConnectionResult): void {
    this.snapshotValue.connections = result.connections.map((connection) => ({ ...connection }));
  }

  private applyRequestOutcome(result: PeerConnectionResult): void {
    const outcome = result.requestOutcome;
    if (!outcome) return;
    const connection = result.connections.find((item) => item.requestId === outcome.requestId);
    const label = connection?.remoteDisplayName || publicTetiId(outcome.remoteTetiId);
    this.snapshotValue.highlightedRequestId = outcome.requestId;
    switch (outcome.kind) {
      case "created":
        this.snapshotValue.notice = `已向 ${label} 发送建联邀请，等待对方确认。`;
        break;
      case "alreadyRequested":
        this.snapshotValue.notice = `已经向 ${label} 发送过邀请，正在等待对方确认。`;
        break;
      case "approvalRequired":
        this.snapshotValue.notice = `${label} 正在等待你确认，请使用下方按钮处理。`;
        break;
      case "confirming":
        this.snapshotValue.notice = `正在完成与 ${label} 的建联确认。`;
        break;
      case "alreadyConfirmed":
        this.snapshotValue.notice = `已经与 ${label} 建联，无需再次发送邀请。`;
        break;
      case "blocked":
        this.snapshotValue.notice = `${label} 当前已被阻止建联。`;
        break;
    }
  }

  private hasPendingApproval(): boolean {
    return this.snapshotValue.connections.some((connection) => connection.state === "PendingApproval");
  }

  private touch(): void {
    const token = ++this.collapseToken;
    this.schedule(() => {
      if (
        token === this.collapseToken &&
        this.snapshotValue.open &&
        !this.snapshotValue.busy &&
        !this.interactionActive &&
        !this.hasPendingApproval()
      ) {
        this.close();
      }
    }, AUTO_COLLAPSE_MS);
  }
}

export class BridgePeerConnectionClient implements PeerConnectionClient {
  private readonly bridge: LifecycleBridgeClient;

  constructor(bridge: LifecycleBridgeClient) {
    this.bridge = bridge;
  }

  resolve(query: string): Promise<PublicTetiIdentity> {
    return this.bridge.request("connection.resolve", { query }) as Promise<PublicTetiIdentity>;
  }

  request(query: string): Promise<PeerConnectionResult> {
    return this.bridge.request("connection.request", { query }) as Promise<PeerConnectionResult>;
  }

  list(): Promise<PeerConnectionResult> {
    return this.bridge.request("connection.list") as Promise<PeerConnectionResult>;
  }

  poll(): Promise<PeerConnectionResult> {
    return this.bridge.request("connection.poll") as Promise<PeerConnectionResult>;
  }

  accept(requestId: string): Promise<PeerConnectionResult> {
    return this.bridge.request("connection.accept", { requestId }) as Promise<PeerConnectionResult>;
  }

  reject(requestId: string): Promise<PeerConnectionResult> {
    return this.bridge.request("connection.reject", { requestId }) as Promise<PeerConnectionResult>;
  }
}

export class MockPeerConnectionClient implements PeerConnectionClient {
  private connections: PeerConnectionDto[] = [];

  async resolve(query: string): Promise<PublicTetiIdentity> {
    const publicId = query.trim().toLowerCase();
    const id = `teti_${publicId}`;
    return {
      id,
      address: `${publicId}@mail.seep.im`,
      displayName: "Preview Teti",
      publicKey: "preview-public-key",
      publicProfile: { platform: "macOS" }
    };
  }

  async request(query: string): Promise<PeerConnectionResult> {
    const identity = await this.resolve(query);
    const existing = this.connections.find((connection) => connection.remoteTetiId === identity.id);
    if (existing) {
      return this.result({
        kind: existing.state === "Confirmed" ? "alreadyConfirmed" : "alreadyRequested",
        requestId: existing.requestId,
        remoteTetiId: existing.remoteTetiId
      });
    }
    const now = new Date().toISOString();
    this.connections = [{
      requestId: `preview_${Date.now()}`,
      state: "Requested",
      direction: "outgoing",
      remoteTetiId: identity.id,
      remoteAddress: identity.address,
      remoteDisplayName: identity.displayName,
      createdAt: now,
      updatedAt: now
    }];
    return this.result({
      kind: "created",
      requestId: this.connections[0].requestId,
      remoteTetiId: identity.id
    });
  }

  async list(): Promise<PeerConnectionResult> { return this.result(); }
  async poll(): Promise<PeerConnectionResult> { return this.result(); }
  async accept(): Promise<PeerConnectionResult> { return this.result(); }
  async reject(): Promise<PeerConnectionResult> { return this.result(); }

  private result(requestOutcome?: PeerConnectionResult["requestOutcome"]): PeerConnectionResult {
    const result: PeerConnectionResult = {
      connections: this.connections.map((item) => ({ ...item })),
      receivedCount: 0,
      heartbeatCount: 0
    };
    if (requestOutcome) result.requestOutcome = requestOutcome;
    return result;
  }
}

function publicTetiId(tetiId: string): string {
  return tetiId.startsWith("teti_") ? tetiId.slice(5) : tetiId;
}
