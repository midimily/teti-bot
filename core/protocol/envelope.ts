import { randomUUID } from "node:crypto";
import {
  MAX_TETI_APPLICATION_ENVELOPE_BYTES,
  TETI_APPLICATION_PROTOCOL_VERSION,
  type TetiApplicationEnvelope,
  type TetiApplicationMessageType
} from "./types.ts";
import {
  TetiApplicationProtocolError,
  validateApplicationEnvelope
} from "./validator.ts";
import { isCanonicalTetiPublicId } from "../identity/public-id.ts";

export interface CreateApplicationEnvelopeInput<TPayload> {
  type: TetiApplicationMessageType;
  fromTetiId: string;
  payload: TPayload;
  messageId?: string;
  createdAt?: string;
}

export function createApplicationEnvelope<TPayload>(
  input: CreateApplicationEnvelopeInput<TPayload>
): TetiApplicationEnvelope<TPayload> {
  const envelope: TetiApplicationEnvelope<TPayload> = {
    version: TETI_APPLICATION_PROTOCOL_VERSION,
    type: input.type,
    messageId: input.messageId ?? randomUUID(),
    fromTetiId: input.fromTetiId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    payload: input.payload
  };

  validateApplicationEnvelope(envelope);
  return envelope;
}

export function serializeApplicationEnvelope(envelope: TetiApplicationEnvelope): string {
  validateApplicationEnvelope(envelope);
  return JSON.stringify(envelope);
}

export function parseApplicationEnvelope(raw: string): TetiApplicationEnvelope {
  if (new TextEncoder().encode(raw).byteLength > MAX_TETI_APPLICATION_ENVELOPE_BYTES) {
    throw new TetiApplicationProtocolError("Teti application envelope exceeds the allowed size.");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new TetiApplicationProtocolError("Teti application message is not valid JSON.");
  }

  validateApplicationEnvelope(value);
  return value;
}

/**
 * Reads only the bounded outer identity/version header of an incompatible
 * Application Envelope. The payload is intentionally neither inspected nor
 * validated, so 0.1 messages can be classified as upgrade-required without
 * entering any 0.2 message handler.
 */
export function inspectApplicationEnvelopeHeader(raw: string): {
  version: number;
  fromTetiId: string;
  messageId?: string;
} | null {
  if (new TextEncoder().encode(raw).byteLength > MAX_TETI_APPLICATION_ENVELOPE_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const header = value as Record<string, unknown>;
  if (!Number.isSafeInteger(header.version) || !isCanonicalTetiPublicId(header.fromTetiId)) return null;
  return {
    version: Number(header.version),
    fromTetiId: header.fromTetiId,
    ...(typeof header.messageId === "string" && header.messageId.trim()
      ? { messageId: header.messageId }
      : {})
  };
}
