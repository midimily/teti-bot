import type { NotchWindowController, NotchWindowGeometry } from "../first-launch/notch-window.ts";
import type { FirstLaunchViewModel } from "../first-launch/view-model.ts";
import type { TauriInvoker } from "./tauri-api.ts";
import type { PanelDiagnosticSink } from "./panel-diagnostics.ts";

export type IslandVisualMode =
  | "hidden"
  | "idle"
  | "onboarding"
  | "connection_detail"
  | "processing"
  | "error"
  | "ready"
  | "task";

export class TauriNotchWindowController implements NotchWindowController {
  private readonly tauri: TauriInvoker;
  private readonly diagnostic: PanelDiagnosticSink;
  private modeQueue: Promise<void> = Promise.resolve();
  private modeRevision = 0;
  private latestMode: IslandVisualMode = "idle";
  private latestReason = "initial";

  constructor(tauri: TauriInvoker, diagnostic: PanelDiagnosticSink = () => undefined) {
    this.tauri = tauri;
    this.diagnostic = diagnostic;
  }

  async expand(reason: string): Promise<void> {
    await this.setMode("onboarding", reason);
  }

  async collapse(reason: string): Promise<void> {
    await this.setMode("idle", reason);
  }

  async setGeometry(geometry: Partial<NotchWindowGeometry>): Promise<void> {
    await this.tauri.invoke("position_island", { geometry: sanitizeGeometry(geometry) });
  }

  setConnectionDetailHeight(height: number, reason: string): Promise<void> {
    const revision = this.modeRevision;
    const safeHeight = finitePositiveNumber(height);
    const pending = this.modeQueue.then(async () => {
      if (revision !== this.modeRevision || safeHeight === undefined) return;
      try {
        await this.tauri.invoke("set_connection_detail_height", { height: safeHeight, reason });
      } catch (error) {
        this.diagnostic({
          level: "error",
          event: "panel.native.resize_failed",
          fields: { mode: "connection_detail", reason, errorKind: errorKind(error) }
        });
        throw error;
      }
    });
    this.modeQueue = pending.catch(() => undefined);
    return pending;
  }

  setMode(mode: IslandVisualMode, reason: string): Promise<void> {
    const revision = ++this.modeRevision;
    this.latestMode = mode;
    this.latestReason = reason;
    this.diagnostic({
      level: "debug",
      event: "panel.mode.requested",
      fields: { mode, reason, revision }
    });
    const pending = this.modeQueue.then(async () => {
      if (revision !== this.modeRevision) {
        this.diagnostic({
          level: mode === "idle" ? "warn" : "debug",
          event: mode === "idle" ? "panel.mode.collapse_superseded" : "panel.mode.coalesced",
          fields: {
            mode,
            reason,
            revision,
            currentRevision: this.modeRevision,
            replacementMode: this.latestMode,
            replacementReason: this.latestReason
          }
        });
        return;
      }
      try {
        await this.tauri.invoke("set_island_mode", { mode, reason });
        this.diagnostic({
          level: "debug",
          event: "panel.mode.applied",
          fields: { mode, reason, revision }
        });
      } catch (error) {
        this.diagnostic({
          level: "error",
          event: "panel.mode.failed",
          fields: { mode, reason, revision, errorKind: errorKind(error) }
        });
        throw error;
      }
    });
    this.modeQueue = pending.catch(() => undefined);
    return pending;
  }

  async show(reason = "show"): Promise<void> {
    await this.tauri.invoke("show_island", { reason });
  }

  async hide(reason = "hide"): Promise<void> {
    await this.tauri.invoke("hide_island", { reason });
  }
}

function errorKind(error: unknown): string {
  if (error instanceof Error && /^[a-zA-Z0-9_.:-]{1,80}$/.test(error.name)) return error.name;
  return "unknown";
}

export function visualModeForViewModel(viewModel: FirstLaunchViewModel): IslandVisualMode {
  if (viewModel.panel === "collapsed") {
    return "idle";
  }

  if (viewModel.character === "thinking") {
    return "processing";
  }

  if (viewModel.character === "error") {
    return "error";
  }

  if (viewModel.character === "ready") {
    return "ready";
  }

  return "onboarding";
}

function sanitizeGeometry(geometry: Partial<NotchWindowGeometry>): Partial<NotchWindowGeometry> {
  return {
    width: positiveNumber(geometry.width),
    height: positiveNumber(geometry.height),
    topInset: nonNegativeNumber(geometry.topInset),
    displayId: geometry.displayId,
    hasPhysicalNotch: geometry.hasPhysicalNotch
  };
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function finitePositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}
