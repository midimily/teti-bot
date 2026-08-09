import type { TetiAccount } from "../../../../../core/account/model.ts";
import type { RegistryStatus } from "../../../../../core/account/model.ts";
import {
  RUNTIME_PASSPORT_SNAPSHOT_SCHEMA_VERSION,
  type RuntimePassportSnapshot
} from "../../../../../core/passport/snapshot.ts";
import {
  DEFAULT_PASSPORT_SHARING_POLICY,
  TETI_CAPABILITY_PASSPORT_SCHEMA_VERSION,
  type PassportSharingPolicy
} from "../../../../../core/passport/types.ts";
import type { CallableAgent } from "../../../../../core/callability/types.ts";
import type { AgentComputeOffer } from "../../../../../core/callability/agent-core.ts";
import { projectCallablePassport } from "../../../../../core/passport/callable-projection.ts";
import type { CodexUsageState } from "../../../src/codex-usage/types.ts";
import type { PeerConnectionDto } from "../../../src/lifecycle-bridge/protocol.ts";
import type { NetworkPeerPresenceSnapshot } from "../../../../../core/passport/snapshot.ts";
import { mapAccountIdentity, mapCodexUsageResource, mapPeerConnection } from "./mappers.ts";

export interface RuntimePassportSources {
  loadAccount(): Promise<TetiAccount | null>;
  getConnections(): readonly PeerConnectionDto[];
  getCodexUsage(): CodexUsageState;
  getCallableAgents?(): readonly CallableAgent[];
  getComputeOffers?(): readonly AgentComputeOffer[];
  getRegistry(): RegistryStatus;
  getNetworkPresence?(tetiId: string): NetworkPeerPresenceSnapshot | undefined;
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
    const callable = projectCallablePassport(
      this.sources.getCallableAgents?.() ?? [],
      this.sources.getComputeOffers?.() ?? []
    );
    const content = {
      identity: mapAccountIdentity(account),
      registry: this.sources.getRegistry(),
      resources: [mapCodexUsageResource(this.sources.getCodexUsage(), this.fallbackObservedAt)],
      callable,
      connections: this.sources.getConnections().map((connection) => {
        const mapped = mapPeerConnection(connection, now);
        const presence = this.sources.getNetworkPresence?.(connection.remoteTetiId);
        return presence ? { ...mapped, networkPresence: presence } : mapped;
      }),
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
      registry: content.registry,
      localPassport: {
        schemaVersion: TETI_CAPABILITY_PASSPORT_SCHEMA_VERSION,
        generatedAt,
        resources: content.resources,
        agents: content.callable.agents,
        capabilities: content.callable.capabilities,
        bindings: content.callable.bindings,
        computeOffers: content.callable.computeOffers
      },
      connections: content.connections,
      sharing: content.sharing
    };
    this.fingerprint = fingerprint;
    this.cached = structuredClone(snapshot);
    return snapshot;
  }
}
