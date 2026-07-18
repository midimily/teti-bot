import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AiStatusSharingSettings } from "../../../../core/ai-status/types.ts";

interface StoredAiStatusSettings {
  version: 1;
  statusSharing: boolean;
}

export interface AiStatusSettingsStore {
  load(): Promise<AiStatusSharingSettings>;
  save(settings: AiStatusSharingSettings): Promise<void>;
}

export class FileAiStatusSettingsStore implements AiStatusSettingsStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<AiStatusSharingSettings> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      return validateStoredSettings(value);
    } catch (error) {
      if (isNotFound(error)) return { statusSharing: false };
      throw error;
    }
  }

  async save(settings: AiStatusSharingSettings): Promise<void> {
    const value: StoredAiStatusSettings = {
      version: 1,
      statusSharing: settings.statusSharing
    };
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.path);
  }
}

export class MemoryAiStatusSettingsStore implements AiStatusSettingsStore {
  private settings: AiStatusSharingSettings;

  constructor(settings: AiStatusSharingSettings = { statusSharing: false }) {
    this.settings = settings;
  }

  async load(): Promise<AiStatusSharingSettings> {
    return { ...this.settings };
  }

  async save(settings: AiStatusSharingSettings): Promise<void> {
    this.settings = { ...settings };
  }
}

function validateStoredSettings(value: unknown): AiStatusSharingSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Teti AI status settings must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.statusSharing !== "boolean") {
    throw new Error("Unsupported Teti AI status settings.");
  }
  return { statusSharing: record.statusSharing };
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
