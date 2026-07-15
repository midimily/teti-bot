import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { rejectPrivateFields, validateConnectionRequest } from "./protocol.ts";
import {
  TETI_CONNECTION_VERSION,
  TetiConnectionState,
  type TetiConnectionRecord,
  type TetiConnectionStore
} from "./types.ts";

export interface TetiConnectionStorage {
  loadAll(): Promise<TetiConnectionRecord[]>;
  saveAll(connections: TetiConnectionRecord[]): Promise<void>;
  upsert(connection: TetiConnectionRecord): Promise<void>;
  update(requestId: string, patch: Partial<TetiConnectionRecord>): Promise<TetiConnectionRecord>;
  removeAll(): Promise<void>;
}

export class FileTetiConnectionStorage implements TetiConnectionStorage {
  private readonly connectionsPath: string;

  constructor(connectionsPath = defaultTetiConnectionsPath()) {
    this.connectionsPath = connectionsPath;
  }

  async loadAll(): Promise<TetiConnectionRecord[]> {
    try {
      const raw = await readFile(this.connectionsPath, "utf8");
      const store = JSON.parse(raw) as TetiConnectionStore;
      validateConnectionStore(store);
      return store.connections;
    } catch (error) {
      if (isNotFound(error)) {
        return [];
      }

      throw error;
    }
  }

  async saveAll(connections: TetiConnectionRecord[]): Promise<void> {
    const store: TetiConnectionStore = {
      version: TETI_CONNECTION_VERSION,
      connections
    };
    validateConnectionStore(store);

    await mkdir(dirname(this.connectionsPath), { recursive: true });
    const tmpPath = `${this.connectionsPath}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    await rename(tmpPath, this.connectionsPath);
  }

  async upsert(connection: TetiConnectionRecord): Promise<void> {
    validateConnectionRecord(connection);
    const connections = await this.loadAll();
    const existingIndex = connections.findIndex((item) => item.requestId === connection.requestId);
    if (existingIndex === -1) {
      connections.push(connection);
    } else {
      connections[existingIndex] = connection;
    }

    await this.saveAll(connections);
  }

  async update(
    requestId: string,
    patch: Partial<TetiConnectionRecord>
  ): Promise<TetiConnectionRecord> {
    const connections = await this.loadAll();
    const existingIndex = connections.findIndex((item) => item.requestId === requestId);
    if (existingIndex === -1) {
      throw new Error(`Teti connection request ${requestId} does not exist.`);
    }

    const updated = {
      ...connections[existingIndex],
      ...patch,
      requestId
    };
    validateConnectionRecord(updated);
    connections[existingIndex] = updated;
    await this.saveAll(connections);

    return updated;
  }

  async removeAll(): Promise<void> {
    await rm(this.connectionsPath, { force: true });
  }

  get path(): string {
    return this.connectionsPath;
  }
}

export class MemoryTetiConnectionStorage implements TetiConnectionStorage {
  private connections: TetiConnectionRecord[] = [];

  async loadAll(): Promise<TetiConnectionRecord[]> {
    return cloneConnections(this.connections);
  }

  async saveAll(connections: TetiConnectionRecord[]): Promise<void> {
    for (const connection of connections) {
      validateConnectionRecord(connection);
    }

    this.connections = cloneConnections(connections);
  }

  async upsert(connection: TetiConnectionRecord): Promise<void> {
    validateConnectionRecord(connection);
    const existingIndex = this.connections.findIndex((item) => item.requestId === connection.requestId);
    if (existingIndex === -1) {
      this.connections.push(cloneConnection(connection));
    } else {
      this.connections[existingIndex] = cloneConnection(connection);
    }
  }

  async update(
    requestId: string,
    patch: Partial<TetiConnectionRecord>
  ): Promise<TetiConnectionRecord> {
    const existingIndex = this.connections.findIndex((item) => item.requestId === requestId);
    if (existingIndex === -1) {
      throw new Error(`Teti connection request ${requestId} does not exist.`);
    }

    const updated = {
      ...this.connections[existingIndex],
      ...patch,
      requestId
    };
    validateConnectionRecord(updated);
    this.connections[existingIndex] = cloneConnection(updated);
    return cloneConnection(updated);
  }

  async removeAll(): Promise<void> {
    this.connections = [];
  }
}

export function defaultTetiConnectionsPath(): string {
  return join(homedir(), ".teti", "connections.json");
}

export function validateConnectionStore(store: TetiConnectionStore): void {
  if (store.version !== TETI_CONNECTION_VERSION) {
    throw new Error("Unsupported Teti connection store version.");
  }

  if (!Array.isArray(store.connections)) {
    throw new Error("Teti connection store connections must be an array.");
  }

  for (const connection of store.connections) {
    validateConnectionRecord(connection);
  }
}

export function validateConnectionRecord(connection: TetiConnectionRecord): void {
  rejectPrivateFields(connection as unknown as Record<string, unknown>, "Teti connection record");
  validateConnectionRequest(connection.request);

  if (connection.version !== TETI_CONNECTION_VERSION) {
    throw new Error("Unsupported Teti connection record version.");
  }

  if (!Object.values(TetiConnectionState).includes(connection.state)) {
    throw new Error("Teti connection state is invalid.");
  }

  if (connection.direction !== "incoming" && connection.direction !== "outgoing") {
    throw new Error("Teti connection direction is invalid.");
  }

  if (!connection.requestId || !connection.remoteTetiId || !connection.remoteAddress) {
    throw new Error("Teti connection record is missing required identity fields.");
  }
}

function cloneConnections(connections: TetiConnectionRecord[]): TetiConnectionRecord[] {
  return connections.map(cloneConnection);
}

function cloneConnection(connection: TetiConnectionRecord): TetiConnectionRecord {
  return JSON.parse(JSON.stringify(connection)) as TetiConnectionRecord;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
