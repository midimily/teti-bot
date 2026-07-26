import type {
  AgentObservation,
  AgentObservationSnapshotState,
  ObservationSafeError
} from "./types.ts";

/**
 * Local-only read model used by Desktop's Agent management settings.
 * `pathOverrides` must never be copied into Passport or peer payloads.
 */
export interface AgentManagementSnapshot {
  schemaVersion: 1;
  revision: number;
  state: AgentObservationSnapshotState;
  generatedAt: string;
  startedAt?: string;
  completedAt?: string;
  agents: AgentObservation[];
  pathOverrides: Record<string, string>;
  errors: ObservationSafeError[];
}

export function emptyAgentManagementSnapshot(now = new Date(0)): AgentManagementSnapshot {
  return {
    schemaVersion: 1,
    revision: 0,
    state: "idle",
    generatedAt: now.toISOString(),
    agents: [],
    pathOverrides: {},
    errors: []
  };
}
