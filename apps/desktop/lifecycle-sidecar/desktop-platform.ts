export type LifecycleDesktopPlatform = "macos" | "windows";

export interface LifecyclePlatformCapabilities {
  agentObserver: "process-list";
  codexProcess: true;
  processTreeCancellation: "process-group" | "taskkill-tree";
  osaurusRuntime: boolean;
  osaurusNativeAgent: boolean;
}

export function lifecyclePlatformCapabilities(
  platform: LifecycleDesktopPlatform
): LifecyclePlatformCapabilities {
  return {
    agentObserver: "process-list",
    codexProcess: true,
    processTreeCancellation: platform === "windows" ? "taskkill-tree" : "process-group",
    osaurusRuntime: platform === "macos",
    osaurusNativeAgent: platform === "macos"
  };
}

export function resolveLifecycleDesktopPlatform(
  env: NodeJS.ProcessEnv = process.env,
  hostPlatform: NodeJS.Platform = process.platform
): LifecycleDesktopPlatform {
  const declared = env.TETI_DESKTOP_PLATFORM;
  if (declared !== undefined && declared !== "macos" && declared !== "windows") {
    throw new Error("TETI_DESKTOP_PLATFORM is invalid.");
  }
  const detected = hostPlatform === "darwin"
    ? "macos"
    : hostPlatform === "win32"
      ? "windows"
      : undefined;
  if (!detected) throw new Error("The lifecycle Runtime supports macOS and Windows only.");
  if (declared && declared !== detected) {
    throw new Error("The lifecycle Runtime platform does not match the native shell.");
  }
  return declared ?? detected;
}
