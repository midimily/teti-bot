import type { NotchWindowController, NotchWindowGeometry } from "../first-launch/notch-window.ts";
import type { FirstLaunchViewModel } from "../first-launch/view-model.ts";
import type { TauriInvoker } from "./tauri-api.ts";

export type IslandVisualMode = "hidden" | "idle" | "onboarding" | "processing" | "error" | "ready";

export class TauriNotchWindowController implements NotchWindowController {
  private readonly tauri: TauriInvoker;
  private modeQueue: Promise<void> = Promise.resolve();
  private modeRevision = 0;

  constructor(tauri: TauriInvoker) {
    this.tauri = tauri;
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

  setMode(mode: IslandVisualMode, reason: string): Promise<void> {
    const revision = ++this.modeRevision;
    const pending = this.modeQueue.then(async () => {
      if (revision !== this.modeRevision) return;
      await this.tauri.invoke("set_island_mode", { mode, reason });
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
