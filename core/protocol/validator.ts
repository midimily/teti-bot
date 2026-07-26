import {
  TETI_APPLICATION_PROTOCOL_VERSION,
  type TetiApplicationEnvelope,
  type TetiApplicationMessageType
} from "./types.ts";
import { isCanonicalTetiPublicId } from "../identity/public-id.ts";
import { validateAiStatusSyncPayload } from "../ai-status/protocol.ts";
import { validateCollaborationTaskRequest } from "../task/validation.ts";
import {
  validateTaskProtocolVersions,
  validateTaskArtifactPayload,
  validateTaskAttachmentPayload,
  validateTaskCancelPayload,
  validateTaskReceiptPayload,
  validateTaskStatusPayload
} from "../task/transport-validation.ts";

export class TetiApplicationProtocolError extends Error {}

export function validateApplicationEnvelope(
  value: unknown
): asserts value is TetiApplicationEnvelope {
  if (!isRecord(value)) {
    throw new TetiApplicationProtocolError("Teti application envelope must be an object.");
  }

  rejectPrivateFields(value, "Teti application envelope");

  if (value.version !== TETI_APPLICATION_PROTOCOL_VERSION) {
    throw new TetiApplicationProtocolError("Unsupported Teti application envelope version.");
  }

  if (typeof value.type !== "string" || !isSupportedApplicationType(value.type)) {
    throw new TetiApplicationProtocolError("Teti application envelope type is invalid.");
  }

  requireNonEmptyString(value.messageId, "messageId");
  if (!isCanonicalTetiPublicId(value.fromTetiId)) {
    throw new TetiApplicationProtocolError(
      "fromTetiId must match teti_ followed by exactly 9 ASCII lowercase letters or numbers."
    );
  }
  requireNonEmptyString(value.createdAt, "createdAt");

  if (!isRecord(value.payload)) {
    throw new TetiApplicationProtocolError("Teti application envelope payload is required.");
  }

  rejectPrivateFields(value.payload, "Teti application payload");
  validatePayload(value.type, value.payload);
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
      throw new TetiApplicationProtocolError(`${label} must not contain ${field}.`);
    }
  }
}

function validatePayload(type: TetiApplicationMessageType, payload: Record<string, unknown>): void {
  if (type === "teti.profile.sync") {
    if ("displayName" in payload && payload.displayName !== undefined && typeof payload.displayName !== "string") {
      throw new TetiApplicationProtocolError("Profile sync displayName must be a string.");
    }
    requireNonEmptyString(payload.platform, "platform");
    requireStringArray(payload.aiEnvironment, "aiEnvironment");
    return;
  }

  if (type === "teti.capability.offer") {
    requireStringArray(payload.capabilities, "capabilities");
    return;
  }

  if (type === "teti.presence") {
    requireNonEmptyString(payload.status, "status");
    requireNonEmptyString(payload.timestamp, "timestamp");
    if (payload.taskProtocolVersions !== undefined) {
      try {
        validateTaskProtocolVersions(payload.taskProtocolVersions);
      } catch {
        throw new TetiApplicationProtocolError("Presence task protocol versions are invalid.");
      }
    }
    return;
  }

  if (type === "teti.ai.status.sync") {
    try {
      validateAiStatusSyncPayload(payload);
    } catch {
      throw new TetiApplicationProtocolError("AI status sync payload is invalid.");
    }
    return;
  }

  if (type === "teti.task.request") {
    try {
      validateCollaborationTaskRequest(payload);
    } catch {
      throw new TetiApplicationProtocolError("Task request payload is invalid.");
    }
    return;
  }

  if (type === "teti.task.receipt") {
    try {
      validateTaskReceiptPayload(payload);
    } catch {
      throw new TetiApplicationProtocolError("Task receipt payload is invalid.");
    }
    return;
  }

  try {
    if (type === "teti.task.attachment") validateTaskAttachmentPayload(payload);
    else if (type === "teti.task.status") validateTaskStatusPayload(payload);
    else if (type === "teti.task.cancel") validateTaskCancelPayload(payload);
    else if (type === "teti.task.artifact") validateTaskArtifactPayload(payload);
  } catch {
    throw new TetiApplicationProtocolError("Task application payload is invalid.");
  }
}

function requireStringArray(value: unknown, fieldName: string): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TetiApplicationProtocolError(`${fieldName} must be a non-empty string array.`);
  }

  if (value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new TetiApplicationProtocolError(`${fieldName} must contain only non-empty strings.`);
  }
}

function requireNonEmptyString(value: unknown, fieldName: string): void {
  if (typeof value !== "string" || !value.trim()) {
    throw new TetiApplicationProtocolError(`${fieldName} is required.`);
  }
}

function isSupportedApplicationType(value: string): value is TetiApplicationMessageType {
  return [
    "teti.profile.sync",
    "teti.capability.offer",
    "teti.presence",
    "teti.ai.status.sync",
    "teti.task.request",
    "teti.task.receipt",
    "teti.task.attachment",
    "teti.task.status",
    "teti.task.cancel",
    "teti.task.artifact"
  ].includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
