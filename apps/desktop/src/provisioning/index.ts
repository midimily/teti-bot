import type { FirstLaunchAccountLifecycle } from "../first-launch/coordinator.ts";
import type { TauriInvoker } from "../platform/tauri-api.ts";
import { createBridgeDesktopAccountLifecycle } from "./bridge-lifecycle.ts";
import { MockDesktopAccountLifecycle } from "./mock-lifecycle.ts";
import { readProvisioningMode, type ProvisioningModeConfig } from "./modes.ts";

export interface DesktopLifecycleSelection {
  config: ProvisioningModeConfig;
  lifecycle: FirstLaunchAccountLifecycle;
}

export async function createDesktopAccountLifecycle(
  env: Record<string, string | undefined>,
  tauri?: TauriInvoker
): Promise<DesktopLifecycleSelection> {
  const config = readProvisioningMode(env, tauri?.runtime === "native" ? "real" : "mock");
  if (config.mode === "real") {
    if (!tauri) {
      throw new Error("Real provisioning requires the Tauri lifecycle bridge.");
    }
    const bridge = await createBridgeDesktopAccountLifecycle(tauri);
    return {
      config,
      lifecycle: bridge.lifecycle
    };
  }

  return {
    config,
    lifecycle: new MockDesktopAccountLifecycle({
      scenario: config.mockScenario,
      delayMs: config.delayMs
    })
  };
}
