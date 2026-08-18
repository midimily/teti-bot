import type { FirstLaunchAccountLifecycle } from "../first-launch/coordinator.ts";
import type { TauriInvoker } from "../platform/tauri-api.ts";
import type { DesktopPlatformInfo } from "../platform/contract.ts";
import { createBridgeDesktopAccountLifecycle } from "./bridge-lifecycle.ts";
import { MockDesktopAccountLifecycle } from "./mock-lifecycle.ts";
import { readProvisioningMode, type ProvisioningModeConfig } from "./modes.ts";

export interface DesktopLifecycleSelection {
  config: ProvisioningModeConfig;
  lifecycle: FirstLaunchAccountLifecycle;
}

export async function createDesktopAccountLifecycle(
  env: Record<string, string | undefined>,
  tauri?: TauriInvoker,
  platform?: DesktopPlatformInfo
): Promise<DesktopLifecycleSelection> {
  const requestedConfig = readProvisioningMode(env, tauri?.runtime === "native" ? "real" : "mock");
  const config: ProvisioningModeConfig = platform?.lifecycleRuntime === "mock"
    ? { ...requestedConfig, mode: "mock" }
    : requestedConfig;
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
      delayMs: config.delayMs,
      platform: platformDisplayName(platform?.platform)
    })
  };
}

function platformDisplayName(platform: DesktopPlatformInfo["platform"] | undefined): string {
  if (platform === "windows") return "Windows";
  if (platform === "macos") return "macOS";
  return platform === "other" ? "Teti Desktop" : "macOS";
}
