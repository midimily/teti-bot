export const TETI_RELEASE_POLICY_SCHEMA_VERSION = 1 as const;
export const TETI_RELEASE_STATUS_SCHEMA_VERSION = 1 as const;

export interface TetiReleasePolicy {
  schemaVersion: typeof TETI_RELEASE_POLICY_SCHEMA_VERSION;
  policyVersion: number;
  channel: "beta";
  minimumSupportedVersion: string;
  effectiveAt: string;
}

export type LocalReleaseState =
  | "checking"
  | "supported"
  | "update_required"
  | "temporarily_unavailable";

export interface LocalReleaseStatus {
  schemaVersion: typeof TETI_RELEASE_STATUS_SCHEMA_VERSION;
  state: LocalReleaseState;
  currentVersion: string;
  buildTimestamp: string;
  source: "none" | "cache" | "network";
  checkedAt?: string;
  minimumSupportedVersion?: string;
  policyVersion?: number;
  effectiveAt?: string;
  diagnosticCode?: "RELEASE_POLICY_UNAVAILABLE" | "RELEASE_POLICY_INVALID";
}

export function validateTetiReleasePolicy(value: unknown): TetiReleasePolicy {
  if (!isRecord(value)) throw new Error("Release Policy must be an object.");
  if (value.schemaVersion !== TETI_RELEASE_POLICY_SCHEMA_VERSION) {
    throw new Error("Release Policy schema is unsupported.");
  }
  if (!Number.isSafeInteger(value.policyVersion) || Number(value.policyVersion) < 1) {
    throw new Error("Release Policy version is invalid.");
  }
  if (value.channel !== "beta") throw new Error("Release Policy channel is unsupported.");
  const minimumSupportedVersion = requireTetiVersion(value.minimumSupportedVersion);
  const effectiveAt = requireIsoTimestamp(value.effectiveAt, "Release Policy effective time");
  return {
    schemaVersion: TETI_RELEASE_POLICY_SCHEMA_VERSION,
    policyVersion: Number(value.policyVersion),
    channel: "beta",
    minimumSupportedVersion,
    effectiveAt
  };
}

export function releaseStateForPolicy(
  currentVersion: string,
  policy: TetiReleasePolicy,
  now = new Date()
): "supported" | "update_required" {
  const version = requireTetiVersion(currentVersion);
  if (Date.parse(policy.effectiveAt) > now.getTime()) return "supported";
  return compareTetiVersions(version, policy.minimumSupportedVersion) < 0
    ? "update_required"
    : "supported";
}

export function compareTetiVersions(left: string, right: string): number {
  const a = parseTetiVersion(left);
  const b = parseTetiVersion(right);
  for (let index = 0; index < a.core.length; index += 1) {
    const difference = a.core[index]! - b.core[index]!;
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) < Number(rightPart) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

export function isTetiVersion(value: unknown): value is string {
  return typeof value === "string"
    && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/.test(value);
}

function requireTetiVersion(value: unknown): string {
  if (!isTetiVersion(value)) throw new Error("Teti version must use semantic versioning.");
  parseTetiVersion(value);
  return value;
}

function parseTetiVersion(value: string): {
  core: [number, number, number];
  prerelease: string[];
} {
  if (!isTetiVersion(value)) throw new Error("Teti version must use semantic versioning.");
  const separator = value.indexOf("-");
  const core = separator === -1 ? value : value.slice(0, separator);
  const prerelease = separator === -1 ? "" : value.slice(separator + 1);
  const parts = core.split(".").map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) {
    throw new Error("Teti version component is invalid.");
  }
  return {
    core: parts as [number, number, number],
    prerelease: prerelease ? prerelease.split(".") : []
  };
}

function requireIsoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} is invalid.`);
  }
  return new Date(value).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
