import { randomBytes, randomUUID } from "node:crypto";
import type { TetiAccount } from "../account/model.ts";
import {
  TETI_CONNECTION_VERSION,
  type TetiConnectionEnvelope,
  type TetiConnectionEnvelopeType,
  type TetiConnectionAccept,
  type TetiConnectionReject,
  type TetiConnectionRequest
} from "./types.ts";

export interface CreateConnectionRequestInput {
  localAccount: TetiAccount;
  requestId?: string;
  nonce?: string;
  createdAt?: string;
}

export interface CreateConnectionAcceptInput {
  localAccount: TetiAccount;
  requestId: string;
  nonce?: string;
  createdAt?: string;
}

export interface CreateConnectionRejectInput {
  requestId: string;
  reason?: string;
}

export class TetiConnectionProtocolError extends Error {}

export function createConnectionRequest(
  input: CreateConnectionRequestInput
): TetiConnectionRequest {
  const request: TetiConnectionRequest = {
    version: TETI_CONNECTION_VERSION,
    requestId: input.requestId ?? randomUUID(),
    fromTetiId: input.localAccount.id,
    fromAddress: input.localAccount.address,
    profile: input.localAccount.publicProfile,
    createdAt: input.createdAt ?? new Date().toISOString(),
    nonce: input.nonce ?? randomBytes(16).toString("hex")
  };

  if (input.localAccount.publicKey) {
    request.publicKey = input.localAccount.publicKey;
  }

  validateConnectionRequest(request);
  return request;
}

export function createConnectionRequestEnvelope(
  request: TetiConnectionRequest
): TetiConnectionEnvelope<TetiConnectionRequest> {
  validateConnectionRequest(request);
  return {
    type: "teti.connection.request",
    version: TETI_CONNECTION_VERSION,
    payload: request
  };
}

export function createConnectionAccept(input: CreateConnectionAcceptInput): TetiConnectionAccept {
  const accept: TetiConnectionAccept = {
    version: TETI_CONNECTION_VERSION,
    requestId: input.requestId,
    fromTetiId: input.localAccount.id,
    fromAddress: input.localAccount.address,
    createdAt: input.createdAt ?? new Date().toISOString(),
    nonce: input.nonce ?? randomBytes(16).toString("hex")
  };

  validateConnectionAccept(accept);
  return accept;
}

export function createConnectionAcceptEnvelope(
  accept: TetiConnectionAccept
): TetiConnectionEnvelope<TetiConnectionAccept> {
  validateConnectionAccept(accept);
  return {
    type: "teti.connection.accept",
    version: TETI_CONNECTION_VERSION,
    payload: accept
  };
}

export function createConnectionReject(input: CreateConnectionRejectInput): TetiConnectionReject {
  const reject: TetiConnectionReject = {
    requestId: input.requestId
  };

  if (input.reason) {
    reject.reason = input.reason;
  }

  validateConnectionReject(reject);
  return reject;
}

export function createConnectionRejectEnvelope(
  reject: TetiConnectionReject
): TetiConnectionEnvelope<TetiConnectionReject> {
  validateConnectionReject(reject);
  return {
    type: "teti.connection.reject",
    version: TETI_CONNECTION_VERSION,
    payload: reject
  };
}

export function serializeConnectionEnvelope(envelope: TetiConnectionEnvelope): string {
  validateConnectionEnvelope(envelope);
  return JSON.stringify(envelope);
}

export function parseConnectionEnvelope(raw: string): TetiConnectionEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new TetiConnectionProtocolError("Connection message is not valid JSON.");
  }

  validateConnectionEnvelope(value);
  return value;
}

export function parseConnectionRequestEnvelope(raw: string): TetiConnectionRequest {
  const envelope = parseConnectionEnvelope(raw);
  if (envelope.type !== "teti.connection.request") {
    throw new TetiConnectionProtocolError("Connection message is not a request.");
  }

  validateConnectionRequest(envelope.payload);
  return envelope.payload;
}

export function parseConnectionAcceptEnvelope(raw: string): TetiConnectionAccept {
  const envelope = parseConnectionEnvelope(raw);
  if (envelope.type !== "teti.connection.accept") {
    throw new TetiConnectionProtocolError("Connection message is not an accept.");
  }

  validateConnectionAccept(envelope.payload);
  return envelope.payload;
}

export function parseConnectionRejectEnvelope(raw: string): TetiConnectionReject {
  const envelope = parseConnectionEnvelope(raw);
  if (envelope.type !== "teti.connection.reject") {
    throw new TetiConnectionProtocolError("Connection message is not a reject.");
  }

  validateConnectionReject(envelope.payload);
  return envelope.payload;
}

export function validateConnectionEnvelope(value: unknown): asserts value is TetiConnectionEnvelope {
  if (!isRecord(value)) {
    throw new TetiConnectionProtocolError("Connection envelope must be an object.");
  }

  rejectPrivateFields(value, "Connection envelope");

  if (value.version !== TETI_CONNECTION_VERSION) {
    throw new TetiConnectionProtocolError("Unsupported connection envelope version.");
  }

  if (typeof value.type !== "string" || !isSupportedEnvelopeType(value.type)) {
    throw new TetiConnectionProtocolError("Connection envelope type is invalid.");
  }

  if (!("payload" in value)) {
    throw new TetiConnectionProtocolError("Connection envelope payload is required.");
  }

  if (value.type === "teti.connection.request") {
    validateConnectionRequest(value.payload);
  }

  if (value.type === "teti.connection.accept") {
    validateConnectionAccept(value.payload);
  }

  if (value.type === "teti.connection.reject") {
    validateConnectionReject(value.payload);
  }
}

export function validateConnectionRequest(value: unknown): asserts value is TetiConnectionRequest {
  if (!isRecord(value)) {
    throw new TetiConnectionProtocolError("Connection request must be an object.");
  }

  rejectPrivateFields(value, "Connection request");

  if (value.version !== TETI_CONNECTION_VERSION) {
    throw new TetiConnectionProtocolError("Unsupported connection request version.");
  }

  requireNonEmptyString(value.requestId, "requestId");
  requireNonEmptyString(value.fromTetiId, "fromTetiId");
  requireNonEmptyString(value.fromAddress, "fromAddress");
  requireNonEmptyString(value.createdAt, "createdAt");
  requireNonEmptyString(value.nonce, "nonce");

  if (!isRecord(value.profile)) {
    throw new TetiConnectionProtocolError("Connection request profile is required.");
  }

  rejectPrivateFields(value.profile, "Connection request profile");

  if ("publicKey" in value && value.publicKey !== undefined && typeof value.publicKey !== "string") {
    throw new TetiConnectionProtocolError("Connection request publicKey must be a string.");
  }
}

export function validateConnectionAccept(value: unknown): asserts value is TetiConnectionAccept {
  if (!isRecord(value)) {
    throw new TetiConnectionProtocolError("Connection accept must be an object.");
  }

  rejectPrivateFields(value, "Connection accept");

  if (value.version !== TETI_CONNECTION_VERSION) {
    throw new TetiConnectionProtocolError("Unsupported connection accept version.");
  }

  requireNonEmptyString(value.requestId, "requestId");
  requireNonEmptyString(value.fromTetiId, "fromTetiId");
  requireNonEmptyString(value.fromAddress, "fromAddress");
  requireNonEmptyString(value.createdAt, "createdAt");
  requireNonEmptyString(value.nonce, "nonce");
}

export function validateConnectionReject(value: unknown): asserts value is TetiConnectionReject {
  if (!isRecord(value)) {
    throw new TetiConnectionProtocolError("Connection reject must be an object.");
  }

  rejectPrivateFields(value, "Connection reject");
  requireNonEmptyString(value.requestId, "requestId");

  if ("reason" in value && value.reason !== undefined && typeof value.reason !== "string") {
    throw new TetiConnectionProtocolError("Connection reject reason must be a string.");
  }
}

export function rejectPrivateFields(value: Record<string, unknown>, label: string): void {
  const forbiddenFields = [
    "privateKey",
    "secretKey",
    "password",
    "credentials",
    "chatmailPassword",
    "databasePath",
    "dbPath",
    "chatHistory",
    "messages"
  ];

  for (const field of forbiddenFields) {
    if (value[field] !== undefined) {
      throw new TetiConnectionProtocolError(`${label} must not contain ${field}.`);
    }
  }
}

function requireNonEmptyString(value: unknown, fieldName: string): void {
  if (typeof value !== "string" || !value.trim()) {
    throw new TetiConnectionProtocolError(`Connection request ${fieldName} is required.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSupportedEnvelopeType(value: string): value is TetiConnectionEnvelopeType {
  return [
    "teti.connection.request",
    "teti.connection.accept",
    "teti.connection.reject",
    "teti.profile.update"
  ].includes(value);
}
