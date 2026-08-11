import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TetiNetworkEnvironment } from "./config.ts";
import type {
  TetiNetworkRelayBindingResult,
  TetiNetworkRelayBindingsEtag
} from "./types.ts";

export interface TetiNetworkPendingRelayBindingCommand {
  operation: "adopt" | "create" | "activate" | "revoke";
  path: string;
  rawBody: string;
  ifMatch: TetiNetworkRelayBindingsEtag;
  idempotencyKey: string;
}

export interface TetiNetworkRelayBindingState {
  schemaVersion: 1;
  environment: TetiNetworkEnvironment;
  result: TetiNetworkRelayBindingResult | null;
  verifiedAt: string | null;
  pending?: TetiNetworkPendingRelayBindingCommand;
}

export interface TetiNetworkRelayBindingStore {
  load(): Promise<TetiNetworkRelayBindingState | null>;
  save(state: TetiNetworkRelayBindingState): Promise<void>;
  remove(): Promise<void>;
}

export class FileTetiNetworkRelayBindingStore implements TetiNetworkRelayBindingStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<TetiNetworkRelayBindingState | null> {
    try {
      const state = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      validateState(state);
      return structuredClone(state);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async save(state: TetiNetworkRelayBindingState): Promise<void> {
    validateState(state);
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(temporaryPath, this.path);
  }

  async remove(): Promise<void> {
    await rm(this.path, { force: true });
    await rm(`${this.path}.tmp`, { force: true });
  }
}

export class MemoryTetiNetworkRelayBindingStore implements TetiNetworkRelayBindingStore {
  private state: TetiNetworkRelayBindingState | null = null;

  async load(): Promise<TetiNetworkRelayBindingState | null> {
    return this.state ? structuredClone(this.state) : null;
  }

  async save(state: TetiNetworkRelayBindingState): Promise<void> {
    validateState(state);
    this.state = structuredClone(state);
  }

  async remove(): Promise<void> {
    this.state = null;
  }
}

function validateState(value: unknown): asserts value is TetiNetworkRelayBindingState {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || (value.environment !== "production" && value.environment !== "local_development")
    || (value.verifiedAt !== null
      && (typeof value.verifiedAt !== "string" || !Number.isFinite(Date.parse(value.verifiedAt))))
    || (value.result !== null && !isRecord(value.result))) {
    throw new Error("Teti Network RelayBinding state is invalid.");
  }
  if (value.pending !== undefined) {
    const pending = value.pending;
    if (!isRecord(pending)
      || !["adopt", "create", "activate", "revoke"].includes(String(pending.operation))
      || typeof pending.path !== "string"
      || !pending.path.startsWith("/v1/relay-bindings/")
      || typeof pending.rawBody !== "string"
      || typeof pending.ifMatch !== "string"
      || !/^"relay-bindings-r(?:0|[1-9]\d*)"$/.test(pending.ifMatch)
      || typeof pending.idempotencyKey !== "string"
      || !/^[A-Za-z0-9._:-]{16,128}$/.test(pending.idempotencyKey)) {
      throw new Error("Teti Network pending RelayBinding command is invalid.");
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
