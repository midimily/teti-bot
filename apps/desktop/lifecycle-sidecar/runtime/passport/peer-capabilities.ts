import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { validatePassportSchemaVersions } from "../../../../../core/ai-status/negotiation.ts";
import { validateTaskProtocolVersions } from "../../../../../core/task/transport-validation.ts";
import { isCanonicalTetiPublicId } from "../../../../../core/identity/public-id.ts";

export const TETI_PEER_PROTOCOL_CAPABILITY_STORE_SCHEMA_VERSION = 2;
export const MAX_PEER_PROTOCOL_CAPABILITIES = 512;

export interface PassportPeerProtocolCapability {
  tetiId: string;
  collaborationProtocolEpoch: number;
  taskProtocolVersions?: number[];
  passportSchemaVersions?: number[];
  observedAt: string;
}

export interface PeerProtocolCapabilityStoreState {
  schemaVersion: 2;
  peers: PassportPeerProtocolCapability[];
}

export interface PeerProtocolCapabilityStore {
  get(tetiId: string): Promise<PassportPeerProtocolCapability | undefined>;
  list(): Promise<PassportPeerProtocolCapability[]>;
  observe(capability: PassportPeerProtocolCapability): Promise<boolean>;
}

export class FilePeerProtocolCapabilityStore implements PeerProtocolCapabilityStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async get(tetiId: string): Promise<PassportPeerProtocolCapability | undefined> {
    const peer = (await this.load()).peers.find((item) => item.tetiId === tetiId);
    return peer ? structuredClone(peer) : undefined;
  }

  async list(): Promise<PassportPeerProtocolCapability[]> {
    return structuredClone((await this.load()).peers);
  }

  async observe(capability: PassportPeerProtocolCapability): Promise<boolean> {
    validatePeerProtocolCapability(capability);
    const state = await this.load();
    const changed = rememberPeerProtocolCapability(state, capability);
    if (changed) await this.save(state);
    return changed;
  }

  private async load(): Promise<PeerProtocolCapabilityStoreState> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      validatePeerProtocolCapabilityStoreState(value);
      return structuredClone(value);
    } catch (error) {
      if (isNotFound(error)) return emptyPeerProtocolCapabilityStoreState();
      throw error;
    }
  }

  private async save(state: PeerProtocolCapabilityStoreState): Promise<void> {
    validatePeerProtocolCapabilityStoreState(state);
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(temporaryPath, this.path);
    await chmod(this.path, 0o600);
  }
}

export class MemoryPeerProtocolCapabilityStore implements PeerProtocolCapabilityStore {
  private state: PeerProtocolCapabilityStoreState;

  constructor(state: PeerProtocolCapabilityStoreState = emptyPeerProtocolCapabilityStoreState()) {
    validatePeerProtocolCapabilityStoreState(state);
    this.state = structuredClone(state);
  }

  async get(tetiId: string): Promise<PassportPeerProtocolCapability | undefined> {
    const peer = this.state.peers.find((item) => item.tetiId === tetiId);
    return peer ? structuredClone(peer) : undefined;
  }

  async list(): Promise<PassportPeerProtocolCapability[]> {
    return structuredClone(this.state.peers);
  }

  async observe(capability: PassportPeerProtocolCapability): Promise<boolean> {
    validatePeerProtocolCapability(capability);
    return rememberPeerProtocolCapability(this.state, capability);
  }
}

export function emptyPeerProtocolCapabilityStoreState(): PeerProtocolCapabilityStoreState {
  return {
    schemaVersion: TETI_PEER_PROTOCOL_CAPABILITY_STORE_SCHEMA_VERSION,
    peers: []
  };
}

export function validatePeerProtocolCapabilityStoreState(
  value: unknown
): asserts value is PeerProtocolCapabilityStoreState {
  if (!isRecord(value)
    || value.schemaVersion !== TETI_PEER_PROTOCOL_CAPABILITY_STORE_SCHEMA_VERSION
    || !Array.isArray(value.peers)
    || value.peers.length > MAX_PEER_PROTOCOL_CAPABILITIES
    || Object.keys(value).some((key) => !["schemaVersion", "peers"].includes(key))) {
    throw new Error("Unsupported Teti Peer protocol capability store.");
  }

  const tetiIds = new Set<string>();
  for (const peer of value.peers) {
    validatePeerProtocolCapability(peer);
    if (tetiIds.has(peer.tetiId)) {
      throw new Error("Teti Peer protocol capabilities contain a duplicate identity.");
    }
    tetiIds.add(peer.tetiId);
  }
}

function rememberPeerProtocolCapability(
  state: PeerProtocolCapabilityStoreState,
  capability: PassportPeerProtocolCapability
): boolean {
  const normalized = {
    ...structuredClone(capability),
    ...(capability.taskProtocolVersions
      ? { taskProtocolVersions: [...capability.taskProtocolVersions].sort((left, right) => left - right) }
      : {}),
    ...(capability.passportSchemaVersions
      ? { passportSchemaVersions: [...capability.passportSchemaVersions].sort((left, right) => left - right) }
      : {})
  };
  const existing = state.peers.find((peer) => peer.tetiId === normalized.tetiId);
  if (existing) {
    // Once a peer proves the current epoch, a delayed 0.1 message can never
    // downgrade it back to upgrade-required.
    if (normalized.collaborationProtocolEpoch < existing.collaborationProtocolEpoch) return false;
    if (Date.parse(normalized.observedAt) < Date.parse(existing.observedAt)) return false;
    if (normalized.collaborationProtocolEpoch === existing.collaborationProtocolEpoch
      && sameVersions(existing.taskProtocolVersions, normalized.taskProtocolVersions)
      && sameVersions(existing.passportSchemaVersions, normalized.passportSchemaVersions)) return false;
    existing.collaborationProtocolEpoch = normalized.collaborationProtocolEpoch;
    existing.taskProtocolVersions = normalized.taskProtocolVersions;
    existing.passportSchemaVersions = normalized.passportSchemaVersions;
    existing.observedAt = normalized.observedAt;
    return true;
  }
  if (state.peers.length >= MAX_PEER_PROTOCOL_CAPABILITIES) {
    throw new Error("Teti Peer protocol capability store is full.");
  }
  state.peers.push(normalized);
  return true;
}

function validatePeerProtocolCapability(
  value: unknown
): asserts value is PassportPeerProtocolCapability {
  if (!isRecord(value)
    || Object.keys(value).some((key) => ![
      "tetiId",
      "collaborationProtocolEpoch",
      "taskProtocolVersions",
      "passportSchemaVersions",
      "observedAt"
    ].includes(key))
    || !isCanonicalTetiPublicId(value.tetiId)
    || !Number.isSafeInteger(value.collaborationProtocolEpoch)
    || Number(value.collaborationProtocolEpoch) < 1
    || Number(value.collaborationProtocolEpoch) > 255
    || typeof value.observedAt !== "string"
    || !Number.isFinite(Date.parse(value.observedAt))) {
    throw new Error("Teti Peer protocol capability is invalid.");
  }
  if (value.passportSchemaVersions !== undefined) {
    validatePassportSchemaVersions(value.passportSchemaVersions);
  }
  if (value.taskProtocolVersions !== undefined) {
    validateTaskProtocolVersions(value.taskProtocolVersions);
  }
}

function sameVersions(left: readonly number[] | undefined, right: readonly number[] | undefined): boolean {
  if (!left || !right) return left === right;
  if (left.length !== right.length) return false;
  const normalizedLeft = [...left].sort((a, b) => a - b);
  const normalizedRight = [...right].sort((a, b) => a - b);
  return normalizedLeft.every((version, index) => version === normalizedRight[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
