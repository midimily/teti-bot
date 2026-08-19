import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

export interface TauriInvoker {
  readonly runtime?: "native" | "preview" | "test";
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  onFocusChanged?(handler: (focused: boolean) => void): Promise<() => void>;
  onDockActivate?(handler: () => void): Promise<() => void>;
  onSystemSleep?(handler: () => void): Promise<() => void>;
  onSystemWake?(handler: () => void): Promise<() => void>;
}

export async function createTauriInvoker(): Promise<TauriInvoker> {
  if (!isTauri()) {
    return new BrowserPreviewTauriInvoker();
  }

  const currentWindow = getCurrentWindow();
  return {
    runtime: "native",
    invoke,
    onFocusChanged: async (handler) => currentWindow.onFocusChanged(({ payload }) => handler(payload)),
    onDockActivate: async (handler) => listen("teti://dock-activate", handler),
    onSystemSleep: async (handler) => listen("teti://system-sleep", handler),
    onSystemWake: async (handler) => listen("teti://system-wake", handler)
  };
}

class BrowserPreviewTauriInvoker implements TauriInvoker {
  readonly runtime = "preview" as const;
  async onFocusChanged(): Promise<() => void> {
    return () => undefined;
  }

  async onDockActivate(): Promise<() => void> {
    return () => undefined;
  }

  async onSystemSleep(): Promise<() => void> {
    return () => undefined;
  }

  async onSystemWake(): Promise<() => void> {
    return () => undefined;
  }

  async invoke<T>(command: string): Promise<T> {
    if (command === "desktop_platform_info") {
      return {
        platform: "macos",
        architecture: "arm64",
        shell: "notch-panel",
        lifecycleRuntime: "mock",
        supportsDockReopen: false,
        supportsNativeSleepEvents: false,
        supportsRevealInFileManager: false
      } as T;
    }
    if (command === "current_monitor_info") {
      return {
        x: 0,
        y: 0,
        width: 1440,
        height: 900,
        scaleFactor: 2,
        hasNotch: false,
        notchWidth: 0,
        notchHeight: 0,
        safeTopInset: 0,
        menuBarHeight: 32
      } as T;
    }

    return undefined as T;
  }
}

export class RecordingTauriInvoker implements TauriInvoker {
  readonly runtime = "test" as const;
  readonly calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  responses = new Map<string, unknown>();
  private readonly focusHandlers = new Set<(focused: boolean) => void>();
  private readonly dockActivateHandlers = new Set<() => void>();
  private readonly systemSleepHandlers = new Set<() => void>();
  private readonly systemWakeHandlers = new Set<() => void>();

  async onFocusChanged(handler: (focused: boolean) => void): Promise<() => void> {
    this.focusHandlers.add(handler);
    return () => this.focusHandlers.delete(handler);
  }

  emitFocusChanged(focused: boolean): void {
    for (const handler of this.focusHandlers) handler(focused);
  }

  async onDockActivate(handler: () => void): Promise<() => void> {
    this.dockActivateHandlers.add(handler);
    return () => this.dockActivateHandlers.delete(handler);
  }

  emitDockActivate(): void {
    for (const handler of this.dockActivateHandlers) handler();
  }

  async onSystemSleep(handler: () => void): Promise<() => void> {
    this.systemSleepHandlers.add(handler);
    return () => this.systemSleepHandlers.delete(handler);
  }

  emitSystemSleep(): void {
    for (const handler of this.systemSleepHandlers) handler();
  }

  async onSystemWake(handler: () => void): Promise<() => void> {
    this.systemWakeHandlers.add(handler);
    return () => this.systemWakeHandlers.delete(handler);
  }

  emitSystemWake(): void {
    for (const handler of this.systemWakeHandlers) handler();
  }

  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    this.calls.push({ command, args });
    return this.responses.get(command) as T;
  }
}
