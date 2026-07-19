export interface TauriInvoker {
  readonly runtime?: "native" | "preview" | "test";
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  onFocusChanged?(handler: (focused: boolean) => void): Promise<() => void>;
  onDockActivate?(handler: () => void): Promise<() => void>;
}

export async function createTauriInvoker(): Promise<TauriInvoker> {
  if (typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window)) {
    return new BrowserPreviewTauriInvoker();
  }

  const [api, windowApi, eventApi] = await Promise.all([
    import("@tauri-apps/api/core"),
    import("@tauri-apps/api/window"),
    import("@tauri-apps/api/event")
  ]);
  const currentWindow = windowApi.getCurrentWindow();
  return {
    runtime: "native",
    invoke: api.invoke,
    onFocusChanged: async (handler) => currentWindow.onFocusChanged(({ payload }) => handler(payload)),
    onDockActivate: async (handler) => eventApi.listen("teti://dock-activate", handler)
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

  async invoke<T>(command: string): Promise<T> {
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

  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    this.calls.push({ command, args });
    return this.responses.get(command) as T;
  }
}
