import { TETI_AI_STATUS_SCHEMA_VERSION } from "./types.ts";

export const TETI_SUPPORTED_PASSPORT_SCHEMA_VERSIONS = [
  TETI_AI_STATUS_SCHEMA_VERSION
] as const;
export const MAX_PASSPORT_SCHEMA_VERSIONS = 8;

export type AiStatusSchemaVersion = typeof TETI_SUPPORTED_PASSPORT_SCHEMA_VERSIONS[number];

/**
 * Passport support is negotiated from an explicit Peer capability, never from
 * the last received Passport snapshot. Beta 0.2 waits for the peer's explicit
 * epoch-2 Presence and never speculatively sends or downgrades a Passport.
 */
export function selectAiStatusSchemaForPeer(
  remoteVersions?: readonly number[]
): AiStatusSchemaVersion | null {
  if (!remoteVersions) return null;
  const selected = [...TETI_SUPPORTED_PASSPORT_SCHEMA_VERSIONS]
    .sort((left, right) => right - left)
    .find((version) => remoteVersions.includes(version));
  return selected ?? null;
}

export function validatePassportSchemaVersions(
  value: unknown
): asserts value is number[] {
  if (!Array.isArray(value)
    || value.length === 0
    || value.length > MAX_PASSPORT_SCHEMA_VERSIONS) {
    throw new Error("Passport schema versions are invalid.");
  }

  const seen = new Set<number>();
  for (const version of value) {
    if (!Number.isSafeInteger(version) || version < 1 || version > 255 || seen.has(version)) {
      throw new Error("Passport schema versions are invalid.");
    }
    seen.add(version);
  }
}
