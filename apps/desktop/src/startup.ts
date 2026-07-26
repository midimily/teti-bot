import type { DesktopApp, DesktopAppOptions } from "./app.ts";
import type { TauriInvoker } from "./platform/tauri-api.ts";

export interface DesktopStartupOptions {
  root: HTMLElement;
  env: Record<string, string | undefined>;
  createTauri(): Promise<TauriInvoker>;
  createApp(options: DesktopAppOptions): Promise<DesktopApp>;
  renderFailure(error: unknown): void;
}

/** Keeps a bootstrap failure visible instead of leaving Tauri's transparent shell empty. */
export async function bootstrapDesktopApp(
  options: DesktopStartupOptions
): Promise<DesktopApp | null> {
  let tauri: TauriInvoker | undefined;
  try {
    tauri = await options.createTauri();
    return await options.createApp({
      root: options.root,
      tauri,
      env: options.env
    });
  } catch (error) {
    try {
      options.renderFailure(error);
    } catch {
      // The native error mode below still makes an otherwise transparent panel visible.
    }
    await tauri?.invoke("set_island_mode", {
      mode: "error",
      reason: "startup-failed"
    }).catch(() => undefined);
    return null;
  }
}
