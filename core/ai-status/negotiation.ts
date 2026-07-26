import {
  TETI_AI_STATUS_AGENT_SCHEMA_VERSION,
  TETI_AI_STATUS_LEGACY_SCHEMA_VERSION,
  TETI_AI_STATUS_SCHEMA_VERSION,
  type RemoteAiStatusSnapshot
} from "./types.ts";

export type AiStatusSchemaVersion = 1 | 2 | 3;

/**
 * Unknown peers receive one oldest-compatible Resource payload and one current
 * Callable Passport payload. A received payload is passive capability
 * negotiation: known peers receive exactly one best schema thereafter.
 */
export function selectAiStatusSchemasForPeer(
  remote: RemoteAiStatusSnapshot | undefined
): AiStatusSchemaVersion[] {
  if (remote?.schemaVersion === TETI_AI_STATUS_SCHEMA_VERSION) {
    return [TETI_AI_STATUS_SCHEMA_VERSION];
  }
  if (remote?.schemaVersion === TETI_AI_STATUS_AGENT_SCHEMA_VERSION) {
    return [TETI_AI_STATUS_AGENT_SCHEMA_VERSION];
  }
  if (remote?.schemaVersion === TETI_AI_STATUS_LEGACY_SCHEMA_VERSION) {
    return [TETI_AI_STATUS_LEGACY_SCHEMA_VERSION];
  }
  return [TETI_AI_STATUS_LEGACY_SCHEMA_VERSION, TETI_AI_STATUS_SCHEMA_VERSION];
}
