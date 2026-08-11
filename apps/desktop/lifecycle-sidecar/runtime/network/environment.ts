import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  DEFAULT_TETI_NETWORK_BASE_URL,
  DEVELOPMENT_TETI_NETWORK_BASE_URL,
  type TetiNetworkEnvironment
} from "../../../../../services/network/config.ts";

export type { TetiNetworkEnvironment } from "../../../../../services/network/config.ts";

export interface TetiNetworkEnvironmentPreference {
  schemaVersion: 1;
  useLocalDevelopmentNetwork: boolean;
}

export interface TetiNetworkEnvironmentSettings extends TetiNetworkEnvironmentPreference {
  activeEnvironment: TetiNetworkEnvironment;
  activeBaseUrl: string;
  configuredEnvironment: TetiNetworkEnvironment;
  configuredBaseUrl: string;
  restartRequired: boolean;
}

const DEFAULT_PREFERENCE: TetiNetworkEnvironmentPreference = Object.freeze({
  schemaVersion: 1,
  useLocalDevelopmentNetwork: false
});

export class FileTetiNetworkEnvironmentPreferenceStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<TetiNetworkEnvironmentPreference> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      return validatePreference(parsed);
    } catch (error) {
      if (isMissingFile(error)) return { ...DEFAULT_PREFERENCE };
      throw error;
    }
  }

  async save(preference: TetiNetworkEnvironmentPreference): Promise<void> {
    const validated = validatePreference(preference);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(temporary, this.path);
  }
}

export class TetiNetworkEnvironmentSettingsService {
  private configured: TetiNetworkEnvironmentPreference;
  private readonly store: FileTetiNetworkEnvironmentPreferenceStore;
  private readonly active: TetiNetworkEnvironmentPreference;

  constructor(
    store: FileTetiNetworkEnvironmentPreferenceStore,
    active: TetiNetworkEnvironmentPreference
  ) {
    this.store = store;
    this.active = active;
    this.configured = { ...active };
  }

  static async create(
    store: FileTetiNetworkEnvironmentPreferenceStore
  ): Promise<TetiNetworkEnvironmentSettingsService> {
    const preference = await store.load();
    return new TetiNetworkEnvironmentSettingsService(store, preference);
  }

  get settings(): TetiNetworkEnvironmentSettings {
    const activeEnvironment = environmentFor(this.active);
    const configuredEnvironment = environmentFor(this.configured);
    return {
      schemaVersion: 1,
      useLocalDevelopmentNetwork: this.configured.useLocalDevelopmentNetwork,
      activeEnvironment,
      activeBaseUrl: baseUrlFor(activeEnvironment),
      configuredEnvironment,
      configuredBaseUrl: baseUrlFor(configuredEnvironment),
      restartRequired: activeEnvironment !== configuredEnvironment
    };
  }

  async setUseLocalDevelopmentNetwork(enabled: boolean): Promise<TetiNetworkEnvironmentSettings> {
    if (typeof enabled !== "boolean") throw new Error("Network development setting is invalid.");
    const previous = this.configured;
    const configured = { schemaVersion: 1 as const, useLocalDevelopmentNetwork: enabled };
    this.configured = configured;
    try {
      await this.store.save(configured);
    } catch (error) {
      this.configured = previous;
      throw error;
    }
    return this.settings;
  }
}

export function environmentFor(
  preference: Pick<TetiNetworkEnvironmentPreference, "useLocalDevelopmentNetwork">
): TetiNetworkEnvironment {
  return preference.useLocalDevelopmentNetwork ? "local_development" : "production";
}

export function baseUrlFor(environment: TetiNetworkEnvironment): string {
  return environment === "local_development"
    ? DEVELOPMENT_TETI_NETWORK_BASE_URL
    : DEFAULT_TETI_NETWORK_BASE_URL;
}

function validatePreference(value: unknown): TetiNetworkEnvironmentPreference {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Network environment preference is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || typeof record.useLocalDevelopmentNetwork !== "boolean") {
    throw new Error("Network environment preference is invalid.");
  }
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "schemaVersion,useLocalDevelopmentNetwork") {
    throw new Error("Network environment preference contains unsupported fields.");
  }
  return {
    schemaVersion: 1,
    useLocalDevelopmentNetwork: record.useLocalDevelopmentNetwork
  };
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
