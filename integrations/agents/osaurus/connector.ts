import { request } from "node:http";
import type { Socket } from "node:net";
import type { AgentAdapterReadiness } from "../../../core/callability/types.ts";
import { CallableAdapterOutputError } from "../../../core/callability/adapter.ts";
import type {
  AgentConnector,
  AgentConnectorContext
} from "../../../core/callability/agent-core.ts";
import { TETI_LOCAL_TEXT_COMPUTE_OFFER_ID } from "../../../core/callability/agent-core.ts";
import type { LoopbackRuntimeIdentityVerifier } from "../../../apps/desktop/lifecycle-sidecar/runtime/callable/transports/loopback-http.ts";
import {
  decodeLoopbackFailure,
  LoopbackRuntimeIdentityError
} from "../../../apps/desktop/lifecycle-sidecar/runtime/callable/transports/loopback-http.ts";
import {
  OsaurusRuntimeIdentityVerifier,
  type OsaurusRuntimeDiscovery,
  type OsaurusRuntimeIdentity
} from "./runtime-identity.ts";

export const OSAURUS_RUNTIME_CHILD = {
  connectorId: "osaurus.runtime.bonsai-chat",
  childAgentId: "osaurus-runtime",
  connectorRevision: 2,
  capabilityIds: ["general-text-assistance"],
  model: "OsaurusAI/Bonsai-27b-1bit-JANG",
  minimumRuntimeVersion: "0.22.2",
  timeoutMs: 10 * 60 * 1_000,
  cancelGraceMs: 2_000,
  maxOutputBytes: 512 * 1024
} as const;

export type OsaurusInsightsRetention = "disabled" | "retained" | "unknown";

export interface OsaurusRuntimeTrustVerifier extends LoopbackRuntimeIdentityVerifier {
  discoverLatestTrustedRuntime(): Promise<OsaurusRuntimeIdentity | null>;
  discoverRuntime?(): Promise<OsaurusRuntimeDiscovery>;
}

export interface OsaurusRuntimeApiProbeResult {
  healthy: boolean;
  models: Array<{ id: string; ownedBy: string }>;
}

export interface QualifyOsaurusConnectorOptions {
  signal?: AbortSignal;
  now?: () => Date;
  trustVerifier?: OsaurusRuntimeTrustVerifier;
  probeApi?: (
    identity: OsaurusRuntimeIdentity,
    verifier: LoopbackRuntimeIdentityVerifier
  ) => Promise<OsaurusRuntimeApiProbeResult>;
  inspectInsightsRetention?: (
    identity: OsaurusRuntimeIdentity
  ) => Promise<OsaurusInsightsRetention>;
}

export interface OsaurusConnectorQualification {
  readiness: AgentAdapterReadiness;
  connector: OsaurusRuntimeConnector | null;
  identity: OsaurusRuntimeIdentity | null;
  releaseBlockers: string[];
}

/**
 * Model-inference facade only. It is deliberately not named or projected as an
 * Osaurus Native Agent and carries no Agent prompt, Memory, tools, or Workspace.
 */
export class OsaurusRuntimeConnector implements AgentConnector {
  readonly descriptor = {
    contractVersion: 2 as const,
    connectorId: OSAURUS_RUNTIME_CHILD.connectorId,
    connectorRevision: OSAURUS_RUNTIME_CHILD.connectorRevision,
    childAgentId: OSAURUS_RUNTIME_CHILD.childAgentId,
    capabilityIds: [...OSAURUS_RUNTIME_CHILD.capabilityIds],
    inputModes: ["text"] as const,
    outputModes: ["text"] as const,
    transportKind: "loopback_http" as const,
    origin: "runtime_facade" as const,
    workspacePolicy: "none" as const,
    maxConcurrentExecutions: 1,
    maxQueuedExecutions: 8,
    executionCapabilities: {
      supportsProgress: false,
      supportsPause: false,
      supportsResume: false,
      supportsCheckpoint: false,
      supportsCancel: true
    },
    executionSemantics: "external_side_effects_possible" as const,
    timeoutMs: OSAURUS_RUNTIME_CHILD.timeoutMs,
    cancelGraceMs: OSAURUS_RUNTIME_CHILD.cancelGraceMs,
    maxOutputBytes: OSAURUS_RUNTIME_CHILD.maxOutputBytes
  };
  readonly computeOffer = {
    offerId: TETI_LOCAL_TEXT_COMPUTE_OFFER_ID,
    capability: "general-text-assistance" as const,
    resourceClass: "local_model" as const,
    executionLocation: "receiver_local" as const,
    inputModes: ["text"] as const,
    outputModes: ["text"] as const,
    concurrency: 1 as const,
    approval: "allow_once" as const
  };
  readonly resourceBinding = {
    schemaVersion: 1 as const,
    bindingId: "osaurus.loopback.bonsai-text",
    childAgentId: OSAURUS_RUNTIME_CHILD.childAgentId,
    connectorId: OSAURUS_RUNTIME_CHILD.connectorId,
    transportKind: "loopback_http" as const,
    capabilityIds: [...OSAURUS_RUNTIME_CHILD.capabilityIds]
  };
  private readonly identity: OsaurusRuntimeIdentity;
  private readonly refreshIdentity: () => Promise<OsaurusRuntimeIdentity>;

  constructor(
    identity: OsaurusRuntimeIdentity,
    refreshIdentity: () => Promise<OsaurusRuntimeIdentity> = async () => identity
  ) {
    this.identity = structuredClone(identity);
    this.refreshIdentity = refreshIdentity;
  }

  async createExecutionSpec(context: Readonly<AgentConnectorContext>) {
    if (context.workspacePath !== null || context.images.length !== 0) {
      throw new Error("Osaurus Runtime facade accepts text without a Host Workspace.");
    }
    // Re-qualify on every task. If Osaurus stopped, restarted under a different
    // PID, lost its model, or changed identity, the old listener binding can
    // never be reused. A later task can recover after the Runtime is healthy.
    const identity = await this.refreshIdentity();
    return {
      kind: "loopback_http" as const,
      endpoint: identity.endpoint,
      requestId: context.taskId,
      runtimeInstanceId: identity.instanceId,
      model: OSAURUS_RUNTIME_CHILD.model,
      listenerPid: identity.listenerPid,
      codeIdentityHash: identity.codeIdentityHash
    };
  }

  classifyFailure(stdout: string) {
    return decodeLoopbackFailure(stdout) ?? "ADAPTER_EXIT_NONZERO";
  }
}

export async function qualifyOsaurusConnector(
  options: QualifyOsaurusConnectorOptions = {}
): Promise<OsaurusConnectorQualification> {
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  const trustVerifier = options.trustVerifier ?? new OsaurusRuntimeIdentityVerifier();
  if (options.signal?.aborted) {
    return blocked("degraded", checkedAt, "OSAURUS_QUALIFICATION_ABORTED");
  }

  let discovery: OsaurusRuntimeDiscovery;
  try {
    discovery = trustVerifier.discoverRuntime
      ? await trustVerifier.discoverRuntime()
      : await legacyDiscovery(trustVerifier);
  } catch {
    return blocked("degraded", checkedAt, "OSAURUS_RUNTIME_IDENTITY_FAILED");
  }
  if (discovery.state === "untrusted") {
    return blocked("degraded", checkedAt, "OSAURUS_RUNTIME_UNTRUSTED");
  }
  if (discovery.state === "not_running") {
    return blocked("not_detected", checkedAt, "OSAURUS_TRUSTED_RUNTIME_NOT_RUNNING");
  }
  const identity = discovery.identity;
  if (!identity.appVersion
    || compareNumericVersions(identity.appVersion, OSAURUS_RUNTIME_CHILD.minimumRuntimeVersion) < 0) {
    return blocked("detected", checkedAt, "OSAURUS_RUNTIME_VERSION_UNSUPPORTED", identity);
  }
  if (options.signal?.aborted) {
    return blocked("degraded", checkedAt, "OSAURUS_QUALIFICATION_ABORTED", identity);
  }

  let api: OsaurusRuntimeApiProbeResult;
  try {
    api = await (options.probeApi ?? probeOsaurusRuntimeApi)(identity, trustVerifier);
  } catch {
    return blocked("degraded", checkedAt, "OSAURUS_RUNTIME_API_UNAVAILABLE", identity);
  }
  if (!api.healthy) {
    return blocked("degraded", checkedAt, "OSAURUS_RUNTIME_UNHEALTHY", identity);
  }
  const fixedModel = api.models.find((model) => model.id === OSAURUS_RUNTIME_CHILD.model);
  if (!fixedModel || fixedModel.ownedBy !== "osaurus") {
    return blocked("detected", checkedAt, "OSAURUS_BONSAI_MODEL_NOT_INSTALLED", identity);
  }

  const insightsRetention = await (options.inspectInsightsRetention
    ?? inspectCurrentOsaurusInsightsRetention)(identity).catch(() => "unknown" as const);
  if (insightsRetention !== "disabled") {
    return blocked(
      "degraded",
      checkedAt,
      insightsRetention === "retained"
        ? "OSAURUS_INSIGHTS_BODY_RETENTION"
        : "OSAURUS_INSIGHTS_POLICY_UNVERIFIED",
      identity
    );
  }

  return {
    readiness: readiness("ready", checkedAt),
    connector: new OsaurusRuntimeConnector(identity, async () => {
      const refreshed = await qualifyOsaurusConnector(options);
      if (!refreshed.connector || !refreshed.identity) {
        const reason = refreshed.readiness.reasonCode ?? "OSAURUS_RUNTIME_UNAVAILABLE";
        throw new CallableAdapterOutputError(
          qualificationSafeCode(reason),
          reason
        );
      }
      return refreshed.identity;
    }),
    identity,
    releaseBlockers: []
  };
}

function qualificationSafeCode(reason: string) {
  if (reason === "OSAURUS_BONSAI_MODEL_NOT_INSTALLED"
    || reason === "OSAURUS_RUNTIME_VERSION_UNSUPPORTED") {
    return "ADAPTER_MODEL_UNAVAILABLE" as const;
  }
  if (reason === "OSAURUS_RUNTIME_UNTRUSTED"
    || reason === "OSAURUS_RUNTIME_IDENTITY_FAILED"
    || reason === "OSAURUS_INSIGHTS_BODY_RETENTION"
    || reason === "OSAURUS_INSIGHTS_POLICY_UNVERIFIED") {
    return "ADAPTER_RUNTIME_UNTRUSTED" as const;
  }
  return "ADAPTER_RUNTIME_UNAVAILABLE" as const;
}

/**
 * Current official Osaurus source always passes the decoded request body to
 * InsightsService. There is no public per-request opt-out as of the 0.2.3
 * integration review, so production qualification must fail closed.
 */
export async function inspectCurrentOsaurusInsightsRetention(
  _identity: OsaurusRuntimeIdentity
): Promise<OsaurusInsightsRetention> {
  return "retained";
}

export async function probeOsaurusRuntimeApi(
  identity: OsaurusRuntimeIdentity,
  verifier: LoopbackRuntimeIdentityVerifier
): Promise<OsaurusRuntimeApiProbeResult> {
  const [health, models] = await Promise.all([
    trustedLoopbackJson(identity, verifier, "/health"),
    trustedLoopbackJson(identity, verifier, "/v1/models")
  ]);
  const healthRoot = record(health);
  const modelsRoot = record(models);
  const data = Array.isArray(modelsRoot?.data) ? modelsRoot.data : [];
  return {
    healthy: healthRoot?.status === "healthy",
    models: data.flatMap((item) => {
      const model = record(item);
      return typeof model?.id === "string" && typeof model.owned_by === "string"
        ? [{ id: model.id, ownedBy: model.owned_by }]
        : [];
    })
  };
}

export async function trustedLoopbackJson(
  identity: OsaurusRuntimeIdentity,
  verifier: LoopbackRuntimeIdentityVerifier,
  path: string
): Promise<unknown> {
  if (!/^\/(?:health|v1\/models|agents\/[0-9a-f-]{36})$/i.test(path)) {
    throw new Error("Osaurus API probe path is invalid.");
  }
  await verifier.verifyListener({
    endpoint: identity.endpoint,
    runtimeInstanceId: identity.instanceId,
    listenerPid: identity.listenerPid,
    codeIdentityHash: identity.codeIdentityHash
  });
  const serverPort = Number(new URL(identity.endpoint).port);
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    const client = request({
      protocol: "http:",
      hostname: "127.0.0.1",
      port: serverPort,
      path,
      method: "GET",
      agent: false,
      headers: { Accept: "application/json", Connection: "close", "User-Agent": "Teti/0.2.7" }
    });
    client.setTimeout(5_000, () => client.destroy(new Error("timeout")));
    client.once("socket", (socket: Socket) => {
      const verifyAndSend = async () => {
        if (!socket.localPort
          || socket.remoteAddress !== "127.0.0.1"
          || socket.remotePort !== serverPort) {
          throw new LoopbackRuntimeIdentityError();
        }
        await verifier.verifyConnectedSocket({
          endpoint: identity.endpoint,
          runtimeInstanceId: identity.instanceId,
          listenerPid: identity.listenerPid,
          codeIdentityHash: identity.codeIdentityHash,
          clientPort: socket.localPort,
          serverPort
        });
        client.setTimeout(0);
        client.end();
      };
      const rejectAndDestroy = (error: unknown) => {
        client.destroy(error instanceof Error ? error : new LoopbackRuntimeIdentityError());
        reject(error);
      };
      if (socket.connecting) {
        socket.once("connect", () => { void verifyAndSend().catch(rejectAndDestroy); });
      } else {
        void verifyAndSend().catch(rejectAndDestroy);
      }
    });
    client.once("response", (response) => {
      if ((response.statusCode ?? 0) !== 200
        || response.headers.location !== undefined
        || !(response.headers["content-type"] ?? "").toLowerCase().includes("application/json")) {
        response.resume();
        reject(new Error("Osaurus API probe failed."));
        return;
      }
      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > 256 * 1024) {
          response.destroy();
          reject(new Error("Osaurus API response exceeded the probe limit."));
          return;
        }
        chunks.push(buffer);
      });
      response.once("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          reject(new Error("Osaurus API response was invalid."));
        }
      });
      response.once("error", reject);
    });
    client.once("error", reject);
  });
}

function blocked(
  state: AgentAdapterReadiness["state"],
  checkedAt: string,
  reasonCode: string,
  identity: OsaurusRuntimeIdentity | null = null
): OsaurusConnectorQualification {
  return {
    readiness: readiness(state, checkedAt, reasonCode),
    connector: null,
    identity,
    releaseBlockers: [reasonCode]
  };
}

function readiness(
  state: AgentAdapterReadiness["state"],
  checkedAt: string,
  reasonCode?: string
): AgentAdapterReadiness {
  return {
    schemaVersion: 1,
    agentId: OSAURUS_RUNTIME_CHILD.childAgentId,
    adapterId: OSAURUS_RUNTIME_CHILD.connectorId,
    adapterRevision: OSAURUS_RUNTIME_CHILD.connectorRevision,
    state,
    capabilityIds: [...OSAURUS_RUNTIME_CHILD.capabilityIds],
    inputModes: ["text"],
    outputModes: ["text"],
    checkedAt,
    ...(reasonCode ? { reasonCode } : {})
  };
}

function record(value: unknown): Record<string, any> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

async function legacyDiscovery(
  verifier: OsaurusRuntimeTrustVerifier
): Promise<OsaurusRuntimeDiscovery> {
  const identity = await verifier.discoverLatestTrustedRuntime();
  return identity
    ? { state: "trusted", identity }
    : { state: "not_running", identity: null };
}

function compareNumericVersions(left: string, right: string): number {
  const leftParts = left.split(/[.+_-]/).map(toVersionPart);
  const rightParts = right.split(/[.+_-]/).map(toVersionPart);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function toVersionPart(value: string): number {
  return /^\d+$/.test(value) ? Number(value) : -1;
}
