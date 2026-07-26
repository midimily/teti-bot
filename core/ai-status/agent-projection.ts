import type {
  AiAgentStatusSnapshot
} from "./types.ts";
import type { AiAgent } from "../passport/types.ts";

/**
 * Projects every field in the frozen, privacy-safe local AiAgent contract.
 * Sensitive detector internals never enter AiAgent and therefore cannot cross
 * this boundary.
 */
export function createShareableAgentStatus(agent: AiAgent): AiAgentStatusSnapshot {
  return {
    agentId: agent.id,
    name: agent.name,
    provider: agent.provider ?? null,
    type: agent.type,
    surfaces: [...(agent.surfaces ?? [agent.type])],
    installationStatus: agent.installationStatus,
    detectionSource: agent.detectionSource ?? null,
    version: agent.version ?? null,
    runtimeStatus: agent.runtimeStatus ?? "unknown",
    processCount: agent.processCount ?? null,
    confidence: agent.confidence ?? null,
    lastSeenAt: agent.lastSeenAt ?? null,
    observedAt: agent.observedAt
  };
}
