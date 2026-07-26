export const TETI_AGENT_CALLABILITY_SCHEMA_VERSION = 1;

export type AgentCallabilityState =
  | "not_detected"
  | "detected"
  | "adapter_available"
  | "needs_login"
  | "ready"
  | "degraded"
  | "disabled";

export type AgentTaskContentMode = "text" | "image";

/**
 * Readiness is independent from Agent observation. Installation or a running
 * process can move an Agent to `detected`, but only a successful Adapter probe
 * may report `ready`.
 */
export interface AgentAdapterReadiness {
  schemaVersion: 1;
  agentId: string;
  adapterId: string;
  adapterRevision: number;
  state: AgentCallabilityState;
  capabilityIds: string[];
  inputModes: AgentTaskContentMode[];
  outputModes: AgentTaskContentMode[];
  checkedAt: string;
  reasonCode?: string;
}

/**
 * This is the only Agent shape eligible for the future callable Passport
 * projection. It contains no executable path, command, credential, prompt, or
 * task result.
 */
export interface CallableAgent {
  schemaVersion: 1;
  agentId: string;
  adapterId: string;
  adapterRevision: number;
  capabilityIds: string[];
  inputModes: AgentTaskContentMode[];
  outputModes: AgentTaskContentMode[];
  readyAt: string;
}

const SAFE_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

/**
 * Fail-closed projection used by Runtime to enforce the Observation ->
 * Callability -> Passport boundary.
 */
export function projectCallableAgent(
  readiness: AgentAdapterReadiness
): CallableAgent | null {
  if (readiness.schemaVersion !== TETI_AGENT_CALLABILITY_SCHEMA_VERSION) return null;
  if (readiness.state !== "ready") return null;
  if (!SAFE_ID_PATTERN.test(readiness.agentId)
    || !SAFE_ID_PATTERN.test(readiness.adapterId)
    || !Number.isInteger(readiness.adapterRevision)
    || readiness.adapterRevision <= 0) {
    return null;
  }

  const capabilityIds = uniqueSafeIds(readiness.capabilityIds);
  if (capabilityIds === null || capabilityIds.length === 0) return null;
  const inputModes = safeModes(readiness.inputModes, true);
  const outputModes = safeModes(readiness.outputModes, true);
  if (!inputModes || !outputModes) return null;
  if (!isIsoTimestamp(readiness.checkedAt)) return null;

  return {
    schemaVersion: TETI_AGENT_CALLABILITY_SCHEMA_VERSION,
    agentId: readiness.agentId,
    adapterId: readiness.adapterId,
    adapterRevision: readiness.adapterRevision,
    capabilityIds,
    inputModes,
    outputModes,
    readyAt: readiness.checkedAt
  };
}

function uniqueSafeIds(values: readonly string[]): string[] | null {
  if (values.length > 32) return null;
  const unique = [...new Set(values)];
  if (unique.length !== values.length || unique.some((value) => !SAFE_ID_PATTERN.test(value))) {
    return null;
  }
  return unique;
}

function safeModes(
  values: readonly AgentTaskContentMode[],
  requireText: boolean
): AgentTaskContentMode[] | null {
  if (values.length === 0 || values.length > 2) return null;
  const unique = [...new Set(values)];
  if (unique.length !== values.length
    || unique.some((value) => value !== "text" && value !== "image")
    || (requireText && !unique.includes("text"))) {
    return null;
  }
  return unique.sort((left, right) => left === "text" ? -1 : right === "text" ? 1 : left.localeCompare(right));
}

function isIsoTimestamp(value: string): boolean {
  return Boolean(value.trim()) && Number.isFinite(Date.parse(value));
}
