import { randomBytes } from "node:crypto";
import { TetiNetworkClientError } from "../../../../../services/network/errors.ts";
import type {
  TetiNetworkAuthenticatedSigner,
  TetiNetworkClient,
  TetiNetworkPresenceMode,
  TetiNetworkPresenceReadResponse,
  TetiNetworkPresenceReportRequest
} from "../../../../../services/network/types.ts";

export const TETI_PRESENCE_INTERVALS_MS: Readonly<Record<TetiNetworkPresenceMode, number>> = {
  collaborating: 5_000,
  viewing_connect: 5_000,
  online: 15_000,
  background: 30_000
};

export const TETI_PRESENCE_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 300_000] as const;

export type RuntimePresenceState =
  | "stopped"
  | "sleeping"
  | "checking"
  | "online"
  | "unavailable";

export interface RuntimePresenceSnapshot {
  schemaVersion: 1;
  state: RuntimePresenceState;
  mode: TetiNetworkPresenceMode;
  sessionId: string;
  sequence: number;
  foreground: boolean;
  panelVisible: boolean;
  collaborationActive: boolean;
  lastReportedAt?: string;
  nextReportAt?: string;
  errorCode?: string;
}

export interface RuntimePresenceAuthentication {
  tetiId: string;
  authentication: TetiNetworkAuthenticatedSigner;
}

export interface RuntimePresencePolicyControllerOptions {
  client: TetiNetworkClient;
  getAuthentication(): Promise<RuntimePresenceAuthentication>;
  now?: () => Date;
  random?: () => number;
  sessionIdFactory?: () => string;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
  onChange?: (snapshot: RuntimePresenceSnapshot) => void;
}

/** Runtime-owned adaptive scheduler. Renderer events only update policy signals. */
export class RuntimePresencePolicyController {
  private readonly client: TetiNetworkClient;
  private readonly getAuthentication: RuntimePresencePolicyControllerOptions["getAuthentication"];
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private readonly onChange: NonNullable<RuntimePresencePolicyControllerOptions["onChange"]>;
  private readonly sessionId: string;
  private active = false;
  private sleeping = false;
  private foreground = true;
  private panelVisible = false;
  private collaborationActive = false;
  private acceptedSequence = 0;
  private nextSequence = 1;
  private failureCount = 0;
  private timer: unknown;
  private inFlight: Promise<void> | null = null;
  private inFlightAbort: AbortController | null = null;
  private pendingImmediate = false;
  private snapshotValue: RuntimePresenceSnapshot;

  constructor(options: RuntimePresencePolicyControllerOptions) {
    this.client = options.client;
    this.getAuthentication = options.getAuthentication;
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.schedule = options.schedule ?? ((callback, delayMs) => {
      const handle = setTimeout(callback, delayMs);
      handle.unref?.();
      return handle;
    });
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.onChange = options.onChange ?? (() => undefined);
    this.sessionId = (options.sessionIdFactory ?? createPresenceSessionId)();
    if (!/^ps_[A-Za-z0-9_-]{22}$/.test(this.sessionId)) {
      throw new Error("Teti Presence session ID is invalid.");
    }
    this.snapshotValue = this.createSnapshot("stopped");
  }

  get snapshot(): RuntimePresenceSnapshot {
    return { ...this.snapshotValue };
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.publish(this.sleeping ? "sleeping" : "checking");
    if (!this.sleeping) this.requestImmediate();
  }

  async stop(): Promise<void> {
    if (!this.active && !this.inFlight) return;
    this.active = false;
    this.pendingImmediate = false;
    this.cancelTimer();
    this.inFlightAbort?.abort();
    await this.inFlight?.catch(() => undefined);
    this.publish("stopped");
  }

  setSleeping(sleeping: boolean): void {
    if (this.sleeping === sleeping) return;
    this.sleeping = sleeping;
    if (sleeping) {
      this.pendingImmediate = false;
      this.cancelTimer();
      this.inFlightAbort?.abort();
      this.publish("sleeping");
      return;
    }
    if (this.active) {
      this.publish("checking");
      this.requestImmediate();
    }
  }

  setForeground(foreground: boolean): void {
    if (this.foreground === foreground) return;
    const previous = this.mode();
    this.foreground = foreground;
    this.reportModeChange(previous);
  }

  setPanelVisible(visible: boolean): void {
    if (this.panelVisible === visible) return;
    const previous = this.mode();
    this.panelVisible = visible;
    this.reportModeChange(previous);
  }

  setCollaborationActive(active: boolean): void {
    if (this.collaborationActive === active) return;
    const previous = this.mode();
    this.collaborationActive = active;
    this.reportModeChange(previous);
  }

  reportStateChange(): void {
    if (this.active && !this.sleeping) this.requestImmediate();
  }

  async read(tetiId: string, signal?: AbortSignal): Promise<TetiNetworkPresenceReadResponse> {
    const { authentication } = await this.getAuthentication();
    return this.client.getPresence(tetiId, authentication, signal);
  }

  private reportModeChange(previous: TetiNetworkPresenceMode): void {
    this.publish(this.sleeping ? "sleeping" : this.snapshotValue.state);
    if (previous !== this.mode() && this.active && !this.sleeping) this.requestImmediate();
  }

  private requestImmediate(): void {
    if (!this.active || this.sleeping) return;
    this.cancelTimer();
    if (this.inFlight) {
      this.pendingImmediate = true;
      return;
    }
    this.startAttempt(this.newReport());
  }

  private newReport(): TetiNetworkPresenceReportRequest {
    const mode = this.mode();
    return {
      schemaVersion: 1,
      sessionId: this.sessionId,
      sequence: this.nextSequence++,
      mode,
      activityMarker: mode === "collaborating" ? "collaboration_active" : null
    };
  }

  private startAttempt(body: TetiNetworkPresenceReportRequest): void {
    if (!this.active || this.sleeping || this.inFlight) return;
    const abort = new AbortController();
    this.inFlightAbort = abort;
    const attempt = this.performAttempt(body, abort.signal).finally(() => {
      if (this.inFlight === attempt) this.inFlight = null;
      if (this.inFlightAbort === abort) this.inFlightAbort = null;
      if (!this.active || this.sleeping) return;
      if (this.pendingImmediate) {
        this.pendingImmediate = false;
        this.cancelTimer();
        this.startAttempt(this.newReport());
      }
    });
    this.inFlight = attempt;
  }

  private async performAttempt(
    body: TetiNetworkPresenceReportRequest,
    signal: AbortSignal
  ): Promise<void> {
    try {
      const { tetiId, authentication } = await this.getAuthentication();
      if (signal.aborted) return;
      const response = await this.client.reportPresence(body, authentication, signal);
      if (response.tetiId !== tetiId
        || response.sessionId !== body.sessionId
        || response.sequence !== body.sequence
        || response.mode !== body.mode
        || response.activityMarker !== body.activityMarker) {
        throw new TetiNetworkClientError({
          code: "NETWORK_INVALID_RESPONSE",
          operation: "presence_report",
          message: "Teti Network returned inconsistent Presence state.",
          retryable: false
        });
      }
      this.acceptedSequence = Math.max(this.acceptedSequence, body.sequence);
      this.failureCount = 0;
      this.publish("online", {
        lastReportedAt: response.reportedAt
      });
      this.scheduleReport(this.normalDelay(body.mode), () => this.startAttempt(this.newReport()));
    } catch (error) {
      if (signal.aborted || !this.active || this.sleeping) return;
      this.failureCount += 1;
      const networkError = error instanceof TetiNetworkClientError ? error : null;
      this.publish("unavailable", {
        errorCode: networkError?.code ?? "NETWORK_UNAVAILABLE"
      });
      if (networkError?.code === "PRESENCE_SEQUENCE_STALE") {
        this.scheduleReport(this.normalDelay(this.mode()), () => this.startAttempt(this.newReport()));
        return;
      }
      const retryable = networkError?.retryable ?? true;
      const delay = retryable
        ? this.retryDelay(networkError?.retryAfterMs)
        : TETI_PRESENCE_RETRY_DELAYS_MS.at(-1)!;
      this.scheduleReport(delay, () => this.startAttempt(body));
    }
  }

  private scheduleReport(delayMs: number, callback: () => void): void {
    if (!this.active || this.sleeping || this.pendingImmediate) return;
    this.cancelTimer();
    const scheduledAt = this.now().getTime() + delayMs;
    this.snapshotValue = { ...this.snapshotValue, nextReportAt: new Date(scheduledAt).toISOString() };
    this.onChange(this.snapshot);
    this.timer = this.schedule(() => {
      this.timer = undefined;
      callback();
    }, delayMs);
  }

  private normalDelay(mode: TetiNetworkPresenceMode): number {
    return jitter(TETI_PRESENCE_INTERVALS_MS[mode], 0.1, this.random);
  }

  private retryDelay(retryAfterMs?: number): number {
    const base = retryAfterMs ?? TETI_PRESENCE_RETRY_DELAYS_MS[
      Math.min(this.failureCount - 1, TETI_PRESENCE_RETRY_DELAYS_MS.length - 1)
    ];
    return jitter(Math.max(1, base), 0.2, this.random);
  }

  private mode(): TetiNetworkPresenceMode {
    if (this.collaborationActive) return "collaborating";
    if (this.panelVisible) return "viewing_connect";
    return this.foreground ? "online" : "background";
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return;
    this.cancel(this.timer);
    this.timer = undefined;
  }

  private publish(
    state: RuntimePresenceState,
    update: { lastReportedAt?: string; errorCode?: string } = {}
  ): void {
    this.snapshotValue = {
      ...this.createSnapshot(state),
      ...(this.snapshotValue.lastReportedAt ? { lastReportedAt: this.snapshotValue.lastReportedAt } : {}),
      ...(this.snapshotValue.nextReportAt ? { nextReportAt: this.snapshotValue.nextReportAt } : {}),
      ...(this.snapshotValue.errorCode ? { errorCode: this.snapshotValue.errorCode } : {}),
      ...update
    };
    if (update.errorCode === undefined && (state === "online" || state === "checking")) {
      delete this.snapshotValue.errorCode;
    }
    if (state === "sleeping" || state === "stopped") delete this.snapshotValue.nextReportAt;
    this.onChange(this.snapshot);
  }

  private createSnapshot(state: RuntimePresenceState): RuntimePresenceSnapshot {
    return {
      schemaVersion: 1,
      state,
      mode: this.mode(),
      sessionId: this.sessionId,
      sequence: this.acceptedSequence,
      foreground: this.foreground,
      panelVisible: this.panelVisible,
      collaborationActive: this.collaborationActive
    };
  }
}

export function createPresenceSessionId(): string {
  return `ps_${randomBytes(16).toString("base64url")}`;
}

function jitter(baseMs: number, ratio: number, random: () => number): number {
  const sample = Math.min(1, Math.max(0, random()));
  return Math.max(1, Math.round(baseMs * (1 - ratio + sample * ratio * 2)));
}
