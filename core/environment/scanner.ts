import { access, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { arch, release } from "node:os";
import { delimiter } from "node:path";
import {
  defaultEnvironmentDetectors
} from "./detectors/index.ts";
import type {
  DetectedAiTool,
  EnvironmentDeviceMetadata,
  EnvironmentDetector,
  EnvironmentDetectorContext,
  EnvironmentLocationMetadata,
  EnvironmentScan,
  PublicEnvironmentProfile,
  ScanEnvironmentOptions
} from "./types.ts";

const execFileAsync = promisify(execFile);

const PRIVATE_ENVIRONMENT_FIELDS = new Set([
  "ip",
  "ipAddress",
  "mac",
  "macAddress",
  "hostname",
  "username",
  "user",
  "serialNumber",
  "filesystemPath",
  "path",
  "apiKey",
  "credentials",
  "password",
  "prompts",
  "sourceCode",
  "documents",
  "files"
]);

export class TetiEnvironmentPrivacyError extends Error {}

export async function scanEnvironment(
  options: ScanEnvironmentOptions = {}
): Promise<EnvironmentScan> {
  const platform = options.platform ?? detectPlatform();
  const context = createDetectorContext(platform);
  const detectors = options.detectors ?? defaultEnvironmentDetectors;
  const detected = new Map<string, DetectedAiTool>();

  for (const detector of detectors) {
    for (const tool of await safeDetect(detector, context)) {
      detected.set(tool.id, sanitizeTool(tool));
    }
  }

  const scan: EnvironmentScan = {
    platform,
    device: await detectDeviceMetadata(platform, options.device),
    aiTools: [...detected.values()].sort((a, b) => a.name.localeCompare(b.name)),
    timestamp: options.now?.() ?? new Date().toISOString()
  };
  const location = sanitizeLocation(options.location);
  if (location) {
    scan.location = location;
  }

  return scan;
}

export function environmentScanToPublicProfile(
  scan: EnvironmentScan
): PublicEnvironmentProfile {
  const profile: PublicEnvironmentProfile = {
    platform: sanitizeSmallString(scan.platform) ?? "unknown",
    device: sanitizeDeviceMetadata(scan.device ?? createUnknownDeviceMetadata(scan.platform)),
    aiEnvironment: scan.aiTools
      .map((tool) => sanitizeSmallString(tool.name))
      .filter((name): name is string => typeof name === "string")
      .slice(0, 20),
    lastSeen: scan.timestamp
  };
  const location = sanitizeLocation(scan.location);
  if (location) {
    profile.location = location;
  }

  return profile;
}

export function filterPublicEnvironmentProfile(
  input: Record<string, unknown>
): PublicEnvironmentProfile {
  rejectPrivateEnvironmentFields(input);
  const platform = sanitizeSmallString(input.platform) ?? "unknown";
  const device = sanitizeDeviceMetadata(
    isRecord(input.device)
      ? (input.device as Partial<EnvironmentDeviceMetadata>)
      : createUnknownDeviceMetadata(platform)
  );
  const location = isRecord(input.location)
    ? sanitizeLocation(input.location as EnvironmentLocationMetadata)
    : undefined;
  const aiEnvironment = Array.isArray(input.aiEnvironment)
    ? input.aiEnvironment
        .map(sanitizeSmallString)
        .filter((value): value is string => typeof value === "string")
        .slice(0, 20)
    : [];
  const lastSeen = sanitizeSmallString(input.lastSeen) ?? new Date().toISOString();

  const profile: PublicEnvironmentProfile = {
    platform,
    device,
    aiEnvironment,
    lastSeen
  };
  if (location) {
    profile.location = location;
  }

  return profile;
}

export async function detectDeviceMetadata(
  platform: string,
  overrides: Partial<EnvironmentDeviceMetadata> = {}
): Promise<EnvironmentDeviceMetadata> {
  const base = createUnknownDeviceMetadata(platform);
  const model = overrides.hardware?.model ?? await detectHardwareModel(platform);
  const vendor = overrides.hardware?.vendor ?? detectHardwareVendor(platform, model);

  return sanitizeDeviceMetadata({
    os: {
      name: overrides.os?.name ?? base.os.name,
      version: overrides.os?.version ?? release()
    },
    hardware: {
      vendor,
      model,
      architecture: overrides.hardware?.architecture ?? arch()
    }
  });
}

export function rejectPrivateEnvironmentFields(value: unknown, path = "environment"): void {
  if (!value || typeof value !== "object") {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectPrivateEnvironmentFields(item, `${path}[${index}]`));
    return;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (PRIVATE_ENVIRONMENT_FIELDS.has(key)) {
      throw new TetiEnvironmentPrivacyError(`${path}.${key} must not be published.`);
    }

    rejectPrivateEnvironmentFields(nestedValue, `${path}.${key}`);
  }
}

function createDetectorContext(platform: string): EnvironmentDetectorContext {
  return {
    platform,
    commandExists,
    pathExists,
    async listDirectory(path) {
      try {
        return await readdir(path);
      } catch {
        return [];
      }
    }
  };
}

async function safeDetect(
  detector: EnvironmentDetector,
  context: EnvironmentDetectorContext
): Promise<DetectedAiTool[]> {
  try {
    return await detector.detect(context);
  } catch {
    return [];
  }
}

async function commandExists(command: string): Promise<boolean> {
  const paths = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const path of paths) {
    if (await pathExists(`${path}/${command}`)) {
      return true;
    }
  }

  return false;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function sanitizeTool(tool: DetectedAiTool): DetectedAiTool {
  return {
    id: sanitizeSmallString(tool.id) ?? "unknown",
    name: sanitizeSmallString(tool.name) ?? "Unknown AI Tool",
    source: tool.source
  };
}

function sanitizeDeviceMetadata(input: Partial<EnvironmentDeviceMetadata> = {}): EnvironmentDeviceMetadata {
  return {
    os: {
      name: sanitizeSmallString(input.os?.name) ?? "unknown",
      version: sanitizeSmallString(input.os?.version) ?? "unknown"
    },
    hardware: {
      vendor: sanitizeSmallString(input.hardware?.vendor),
      model: sanitizeSmallString(input.hardware?.model),
      architecture: sanitizeSmallString(input.hardware?.architecture) ?? arch()
    }
  };
}

function sanitizeLocation(
  location: EnvironmentLocationMetadata | undefined
): EnvironmentLocationMetadata | undefined {
  if (!location) {
    return undefined;
  }

  const sanitized: EnvironmentLocationMetadata = {};
  const country = sanitizeSmallString(location.country);
  const city = sanitizeSmallString(location.city);
  if (country) {
    sanitized.country = country;
  }
  if (city) {
    sanitized.city = city;
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function createUnknownDeviceMetadata(platform: string): EnvironmentDeviceMetadata {
  return {
    os: {
      name: platform,
      version: release()
    },
    hardware: {
      architecture: arch()
    }
  };
}

async function detectHardwareModel(platform: string): Promise<string | undefined> {
  if (platform !== "macOS") {
    return undefined;
  }

  try {
    const { stdout } = await execFileAsync("/usr/sbin/sysctl", ["-n", "hw.model"], {
      timeout: 1000
    });
    return sanitizeSmallString(stdout);
  } catch {
    return "Mac";
  }
}

function detectHardwareVendor(platform: string, model: string | undefined): string | undefined {
  if (platform === "macOS" || model?.toLowerCase().includes("mac")) {
    return "Apple";
  }

  return undefined;
}

function sanitizeSmallString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed && trimmed.length <= 64 ? trimmed : undefined;
}

function detectPlatform(): string {
  if (process.platform === "darwin") {
    return "macOS";
  }

  if (process.platform === "win32") {
    return "Windows";
  }

  if (process.platform === "linux") {
    return "Linux";
  }

  return process.platform;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
