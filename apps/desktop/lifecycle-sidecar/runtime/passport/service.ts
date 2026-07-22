import type { TetiAccount } from "../../../../../core/account/model.ts";
import {
  RUNTIME_PASSPORT_SNAPSHOT_SCHEMA_VERSION,
  type RuntimePassportSnapshot
} from "../../../../../core/passport/snapshot.ts";
import {
  DEFAULT_PASSPORT_SHARING_POLICY,
  TETI_CAPABILITY_PASSPORT_SCHEMA_VERSION,
  type PassportSharingPolicy
} from "../../../../../core/passport/types.ts";
import type { CodexUsageState } from "../../../src/codex-usage/types.ts";
import type { PeerConnectionDto } from "../../../src/lifecycle-bridge/protocol.ts";
import { mapAccountIdentity, mapCodexUsageResource, mapPeerConnection } from "./mappers.ts";

export interface RuntimePassportSources {
  loadAccount(): Promise<TetiAccount | null>;
  getConnections(): readonly PeerConnectionDto[];
  getCodexUsage(): CodexUsageState;
  getSharing(): Promise<PassportSharingPolicy>;
}

export class RuntimePassportService {
  private readonly sources: RuntimePassportSources;
  private readonly now: () => Date;
  private readonly fallbackObservedAt: string;
  private revision = 0;
  private fingerprint?: string;
  private cached?: RuntimePassportSnapshot;

  constructor(options: { sources: RuntimePassportSources; now?: () => Date }) {
    this.sources = options.sources;
    this.now = options.now ?? (() => new Date());
    this.fallbackObservedAt = this.now().toISOString();
  }

  async getSnapshot(): Promise<RuntimePassportSnapshot> {
    const now = this.now();
    const [account, sharing] = await Promise.all([
      this.sources.loadAccount(),
      this.sources.getSharing().catch(() => ({ ...DEFAULT_PASSPORT_SHARING_POLICY }))
    ]);
    const content = {
      identity: mapAccountIdentity(account),
      resources: [mapCodexUsageResource(this.sources.getCodexUsage(), this.fallbackObservedAt)],
      connections: this.sources.getConnections().map((connection) => mapPeerConnection(connection, now)),
      sharing
    };
    const fingerprint = JSON.stringify(content);
    if (fingerprint === this.fingerprint && this.cached) return structuredClone(this.cached);

    const generatedAt = now.toISOString();
    const snapshot: RuntimePassportSnapshot = {
      schemaVersion: RUNTIME_PASSPORT_SNAPSHOT_SCHEMA_VERSION,
      revision: ++this.revision,
      generatedAt,
      identity: content.identity,
      localPassport: {
        schemaVersion: TETI_CAPABILITY_PASSPORT_SCHEMA_VERSION,
        generatedAt,
        resources: content.resources,
        agents: [],
        capabilities: [],
        bindings: []
      },
      connections: content.connections,
      sharing: content.sharing
    };
    this.fingerprint = fingerprint;
    this.cached = structuredClone(snapshot);
    return snapshot;
  }
}
