import { randomUUID } from "node:crypto";
import {
  TETI_APPLICATION_PROTOCOL_VERSION,
  type TetiApplicationEnvelope,
  type TetiApplicationMessageType
} from "./types.ts";
import {
  TetiApplicationProtocolError,
  validateApplicationEnvelope
} from "./validator.ts";

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
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new TetiApplicationProtocolError("Teti application message is not valid JSON.");
  }

  validateApplicationEnvelope(value);
  return value;
}
