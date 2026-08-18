import type { DesktopApp, DesktopAppOptions } from "./app.ts";
import { applyDocumentLocale, type DesktopI18n } from "./i18n/index.ts";
import { applyDocumentPlatform, readDesktopPlatformInfo } from "./platform/contract.ts";
import type { TauriInvoker } from "./platform/tauri-api.ts";

export interface DesktopStartupOptions {
  root: HTMLElement;
  env: Record<string, string | undefined>;
  i18n: DesktopI18n;
  createTauri(): Promise<TauriInvoker>;
  createApp(options: DesktopAppOptions): Promise<DesktopApp>;
  renderFailure(error: unknown): void;
}

/** Keeps a bootstrap failure visible instead of leaving Tauri's transparent shell empty. */
export async function bootstrapDesktopApp(
  options: DesktopStartupOptions
): Promise<DesktopApp | null> {
  applyDocumentLocale(options.root.ownerDocument, options.i18n);
  let tauri: TauriInvoker | undefined;
  try {
    tauri = await options.createTauri();
    const platform = await readDesktopPlatformInfo(tauri);
    applyDocumentPlatform(options.root.ownerDocument, platform);
    return await options.createApp({
      root: options.root,
      tauri,
      env: options.env,
      i18n: options.i18n,
      platform
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
