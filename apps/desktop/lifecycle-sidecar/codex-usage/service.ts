import type {
  CodexUsageSnapshot,
  CodexUsageState,
  SafeUsageError
} from "../../src/codex-usage/types.ts";
import { toSafeUsageError } from "./errors.ts";

export const CODEX_USAGE_REFRESH_INTERVAL_MS = 10 * 60 * 1_000;

export interface CodexUsageFetcher {
  fetchUsage(): Promise<CodexUsageSnapshot>;
}

export interface CodexUsageServiceOptions {
  provider: CodexUsageFetcher;
  intervalMs?: number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
  onRefresh?: (result: { ok: true; snapshot: CodexUsageSnapshot } | { ok: false; error: SafeUsageError }) => void;
}

export class CodexUsageService {
  private readonly provider: CodexUsageFetcher;
  private readonly intervalMs: number;
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private readonly onRefresh: NonNullable<CodexUsageServiceOptions["onRefresh"]>;
  private readonly subscribers = new Set<(state: CodexUsageState) => void>();
  private state: CodexUsageState = {
    status: "unavailable",
    error: {
      code: "NOT_STARTED",
      message: "Codex usage has not been refreshed yet.",
      recoverable: true
    }
  };
  private active = false;
  private timer: unknown;
  private inFlight: Promise<CodexUsageState> | null = null;

  constructor(options: CodexUsageServiceOptions) {
    this.provider = options.provider;
    this.intervalMs = options.intervalMs ?? CODEX_USAGE_REFRESH_INTERVAL_MS;
    this.schedule = options.schedule ?? defaultSchedule;
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.onRefresh = options.onRefresh ?? (() => undefined);
  }

  get isRunning(): boolean {
    return this.active;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    void this.refreshNow();
  }

  stop(): void {
    this.active = false;
    if (this.timer !== undefined) {
      this.cancel(this.timer);
      this.timer = undefined;
    }
  }

  refreshNow(): Promise<CodexUsageState> {
    if (this.inFlight) return this.inFlight;
    if (this.timer !== undefined) {
      this.cancel(this.timer);
      this.timer = undefined;
    }

    const refresh = this.runRefresh();
    this.inFlight = refresh;
    void refresh.finally(() => {
      if (this.inFlight === refresh) this.inFlight = null;
      if (this.active && this.timer === undefined) {
        this.timer = this.schedule(() => {
          this.timer = undefined;
          void this.refreshNow();
        }, this.intervalMs);
      }
    });
    return refresh;
  }

  getCurrentState(): CodexUsageState {
    return cloneState(this.state);
  }

  subscribe(listener: (state: CodexUsageState) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  private async runRefresh(): Promise<CodexUsageState> {
    try {
      const snapshot = await this.provider.fetchUsage();
      this.state = { status: "ready", snapshot: { ...snapshot, stale: false } };
      this.notifyRefresh({ ok: true, snapshot: this.state.snapshot });
    } catch (error) {
      const safeError = toSafeUsageError(error);
      const previous = this.state.status === "ready" || this.state.status === "stale"
        ? this.state.snapshot
        : null;
      this.state = previous
        ? { status: "stale", snapshot: { ...previous, stale: true }, error: safeError }
        : { status: "unavailable", error: safeError };
      this.notifyRefresh({ ok: false, error: safeError });
    }
    const next = cloneState(this.state);
    for (const subscriber of this.subscribers) {
      try {
        subscriber(cloneState(next));
      } catch {
        // Observers must not break refresh state or scheduling.
      }
    }
    return next;
  }

  private notifyRefresh(result: Parameters<NonNullable<CodexUsageServiceOptions["onRefresh"]>>[0]): void {
    try {
      this.onRefresh(result);
    } catch {
      // Diagnostic hooks are non-authoritative and may not fail a refresh.
    }
  }
}

function defaultSchedule(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
  const handle = setTimeout(callback, delayMs);
  handle.unref?.();
  return handle;
}

function cloneState(state: CodexUsageState): CodexUsageState {
  return structuredClone(state);
}
