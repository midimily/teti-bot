import type { TauriInvoker } from "./tauri-api.ts";

export type DesktopPlatform = "macos" | "windows" | "other";
export type DesktopArchitecture = "arm64" | "x64" | "other";
export type DesktopShell = "notch-panel" | "top-center-companion";
export type LifecycleRuntime = "bundled" | "mock";

export interface DesktopPlatformInfo {
  platform: DesktopPlatform;
  architecture: DesktopArchitecture;
  shell: DesktopShell;
  lifecycleRuntime: LifecycleRuntime;
  supportsDockReopen: boolean;
  supportsNativeSleepEvents: boolean;
  supportsRevealInFileManager: boolean;
}

export interface DesktopRuntimeDiagnostics {
  platform: DesktopPlatform;
  architecture: DesktopArchitecture;
  lifecycleRuntime: LifecycleRuntime;
  profileSecurity: "protected-acl" | "platform-default" | "unavailable";
  sidecarState: "running" | "stopped";
  descendantOwnership: "job-object" | "process-group";
}

export async function readDesktopPlatformInfo(
  tauri: TauriInvoker
): Promise<DesktopPlatformInfo> {
  return validateDesktopPlatformInfo(await tauri.invoke("desktop_platform_info"));
}

export async function readDesktopRuntimeDiagnostics(
  tauri: TauriInvoker
): Promise<DesktopRuntimeDiagnostics> {
  return validateDesktopRuntimeDiagnostics(await tauri.invoke("desktop_runtime_diagnostics"));
}

export function validateDesktopPlatformInfo(value: unknown): DesktopPlatformInfo {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      "platform",
      "architecture",
      "shell",
      "lifecycleRuntime",
      "supportsDockReopen",
      "supportsNativeSleepEvents",
      "supportsRevealInFileManager"
    ])
    || !isOneOf(value.platform, ["macos", "windows", "other"])
    || !isOneOf(value.architecture, ["arm64", "x64", "other"])
    || !isOneOf(value.shell, ["notch-panel", "top-center-companion"])
    || !isOneOf(value.lifecycleRuntime, ["bundled", "mock"])
    || typeof value.supportsDockReopen !== "boolean"
    || typeof value.supportsNativeSleepEvents !== "boolean"
    || typeof value.supportsRevealInFileManager !== "boolean") {
    throw new Error("Teti received invalid native platform information.");
  }
  return value as unknown as DesktopPlatformInfo;
}

export function validateDesktopRuntimeDiagnostics(value: unknown): DesktopRuntimeDiagnostics {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      "platform",
      "architecture",
      "lifecycleRuntime",
      "profileSecurity",
      "sidecarState",
      "descendantOwnership"
    ])
    || !isOneOf(value.platform, ["macos", "windows", "other"])
    || !isOneOf(value.architecture, ["arm64", "x64", "other"])
    || !isOneOf(value.lifecycleRuntime, ["bundled", "mock"])
    || !isOneOf(value.profileSecurity, ["protected-acl", "platform-default", "unavailable"])
    || !isOneOf(value.sidecarState, ["running", "stopped"])
    || !isOneOf(value.descendantOwnership, ["job-object", "process-group"])) {
    throw new Error("Teti received invalid native Runtime diagnostics.");
  }
  return value as unknown as DesktopRuntimeDiagnostics;
}

export function applyDocumentPlatform(
  document: Pick<Document, "documentElement">,
  platform: DesktopPlatformInfo
): void {
  document.documentElement.dataset.platform = platform.platform;
  document.documentElement.dataset.desktopShell = platform.shell;
  document.documentElement.dataset.lifecycleRuntime = platform.lifecycleRuntime;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function isOneOf<const Value extends string>(
  value: unknown,
  allowed: readonly Value[]
): value is Value {
  return typeof value === "string" && allowed.includes(value as Value);
}
