export interface TauriInvoker {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

export async function createTauriInvoker(): Promise<TauriInvoker> {
  const api = await import("@tauri-apps/api/core");
  return {
    invoke: api.invoke
  };
}

export class RecordingTauriInvoker implements TauriInvoker {
  readonly calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  responses = new Map<string, unknown>();

  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    this.calls.push({ command, args });
    return this.responses.get(command) as T;
  }
}
