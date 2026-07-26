import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  DEFAULT_PASSPORT_SHARING_POLICY,
  type PassportSharingPolicy
} from "../../../../../core/passport/types.ts";

interface StoredPassportSettings {
  version: 4;
  passportSharing: PassportSharingPolicy;
}

interface PreviousStoredPassportSettings {
  version: 3;
  passportSharing: PassportSharingPolicy;
}

interface LegacyStoredPassportSettings {
  version: 2;
  passportSharing: PassportSharingPolicy;
}

interface LegacyStoredAiStatusSettings {
  version: 1;
  statusSharing: boolean;
}

export interface PassportSharingStore {
  load(): Promise<PassportSharingPolicy>;
  save(policy: PassportSharingPolicy): Promise<void>;
}

export class FilePassportSharingStore implements PassportSharingStore {
  private readonly path: string;
  private cached?: PassportSharingPolicy;
  private loading?: Promise<PassportSharingPolicy>;

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<PassportSharingPolicy> {
    if (this.cached) return clonePolicy(this.cached);
    this.loading ??= this.loadOnce();
    try {
      const policy = await this.loading;
      this.cached = policy;
      return clonePolicy(policy);
    } finally {
      this.loading = undefined;
    }
  }

  async save(policy: PassportSharingPolicy): Promise<void> {
    const validated = validatePolicy(policy);
    await this.writeStored(validated);
    this.cached = validated;
  }

  private async loadOnce(): Promise<PassportSharingPolicy> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      if (isLegacySettings(value)) {
        const migrated = resourceSharingPolicy(value.statusSharing);
        await this.writeStored(migrated);
        return migrated;
      }
      if (isLegacyPassportSettings(value)) {
        const legacy = validateLegacyPassportPolicy(value.passportSharing);
        const migrated = resourceSharingPolicy(legacy.resourceSummary && legacy.resourceQuota);
        await this.writeStored(migrated);
        return migrated;
      }
      if (isPreviousPassportSettings(value)) {
        const previous = validatePreviousPassportPolicy(value.passportSharing);
        const migrated = resourceSharingPolicy(
          previous.resourceSummary && previous.resourceQuota && previous.agents
        );
        await this.writeStored(migrated);
        return migrated;
      }
      return validateStoredSettings(value);
    } catch (error) {
      if (isNotFound(error)) return clonePolicy(DEFAULT_PASSPORT_SHARING_POLICY);
      throw error;
    }
  }

  private async writeStored(policy: PassportSharingPolicy): Promise<void> {
    const value: StoredPassportSettings = {
      version: 4,
      passportSharing: clonePolicy(policy)
    };
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.path);
  }
}

export class MemoryPassportSharingStore implements PassportSharingStore {
  private policy: PassportSharingPolicy;

  constructor(policy: PassportSharingPolicy = clonePolicy(DEFAULT_PASSPORT_SHARING_POLICY)) {
    this.policy = validatePolicy(policy);
  }

  async load(): Promise<PassportSharingPolicy> {
    return clonePolicy(this.policy);
  }

  async save(policy: PassportSharingPolicy): Promise<void> {
    this.policy = validatePolicy(policy);
  }
}

export function resourceSharingPolicy(enabled: boolean): PassportSharingPolicy {
  return {
    version: 1,
    audience: "confirmed_peers",
    resourceSummary: enabled,
    resourceQuota: enabled,
    agents: enabled,
    capabilities: enabled
  };
}

export function isResourceSharingEnabled(policy: PassportSharingPolicy): boolean {
  return policy.resourceSummary && policy.resourceQuota;
}

export function hasPassportSharingFields(policy: PassportSharingPolicy): boolean {
  return policy.resourceSummary || policy.resourceQuota || policy.agents || policy.capabilities;
}

export function validatePolicy(value: unknown): PassportSharingPolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Teti Passport sharing policy must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1
    || record.audience !== "confirmed_peers"
    || typeof record.resourceSummary !== "boolean"
    || typeof record.resourceQuota !== "boolean"
    || typeof record.agents !== "boolean"
    || typeof record.capabilities !== "boolean"
  ) {
    throw new Error("Unsupported Teti Passport sharing policy.");
  }
  const values = [
    record.resourceSummary,
    record.resourceQuota,
    record.agents,
    record.capabilities
  ];
  if (!values.every((field) => field === values[0])) {
    throw new Error("Beta Passport sharing uses one switch for all safe fields.");
  }
  return {
    version: 1,
    audience: "confirmed_peers",
    resourceSummary: record.resourceSummary,
    resourceQuota: record.resourceQuota,
    agents: record.agents,
    capabilities: record.capabilities
  };
}

function validateStoredSettings(value: unknown): PassportSharingPolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Teti Passport settings must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 4) throw new Error("Unsupported Teti Passport settings.");
  return validatePolicy(record.passportSharing);
}

function isPreviousPassportSettings(value: unknown): value is PreviousStoredPassportSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.version === 3 && "passportSharing" in record;
}

function validatePreviousPassportPolicy(value: unknown): PassportSharingPolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Teti Passport sharing policy must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1
    || record.audience !== "confirmed_peers"
    || typeof record.resourceSummary !== "boolean"
    || typeof record.resourceQuota !== "boolean"
    || typeof record.agents !== "boolean"
    || record.capabilities !== false
    || record.resourceSummary !== record.resourceQuota
    || record.resourceSummary !== record.agents
  ) {
    throw new Error("Unsupported previous Teti Passport sharing policy.");
  }
  return {
    version: 1,
    audience: "confirmed_peers",
    resourceSummary: record.resourceSummary,
    resourceQuota: record.resourceQuota,
    agents: record.agents,
    capabilities: false
  };
}

function isLegacyPassportSettings(value: unknown): value is LegacyStoredPassportSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.version === 2 && "passportSharing" in record;
}

function validateLegacyPassportPolicy(value: unknown): PassportSharingPolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Teti Passport sharing policy must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1
    || record.audience !== "confirmed_peers"
    || typeof record.resourceSummary !== "boolean"
    || typeof record.resourceQuota !== "boolean"
    || typeof record.agents !== "boolean"
    || typeof record.capabilities !== "boolean"
    || record.resourceSummary !== record.resourceQuota
    || record.agents
    || record.capabilities
  ) {
    throw new Error("Unsupported legacy Teti Passport sharing policy.");
  }
  return {
    version: 1,
    audience: "confirmed_peers",
    resourceSummary: record.resourceSummary,
    resourceQuota: record.resourceQuota,
    agents: false,
    capabilities: false
  };
}

function isLegacySettings(value: unknown): value is LegacyStoredAiStatusSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.version === 1 && typeof record.statusSharing === "boolean";
}

function clonePolicy(policy: Readonly<PassportSharingPolicy>): PassportSharingPolicy {
  return { ...policy };
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
