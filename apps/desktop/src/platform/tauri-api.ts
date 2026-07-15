export interface TauriInvoker {
  readonly runtime?: "native" | "preview" | "test";
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

export async function createTauriInvoker(): Promise<TauriInvoker> {
  if (typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window)) {
    return new BrowserPreviewTauriInvoker();
  }

  const api = await import("@tauri-apps/api/core");
  return {
    runtime: "native",
    invoke: api.invoke
  };
}

class BrowserPreviewTauriInvoker implements TauriInvoker {
  readonly runtime = "preview" as const;
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

  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    this.calls.push({ command, args });
    return this.responses.get(command) as T;
  }
}
