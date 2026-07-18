import {
  TETI_AI_STATUS_SCHEMA_VERSION,
  type AiStatusSyncPayload,
  type AiToolQuotaStatus,
  type AiToolStatusSnapshot
} from "./types.ts";

const MAX_TOOLS = 8;
const MAX_QUOTAS_PER_TOOL = 8;
const MAX_TOOL_ID_LENGTH = 64;
const MAX_SHORT_VALUE_LENGTH = 32;
const MAX_TTL_MS = 60 * 60 * 1_000;
const TOOL_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const SHORT_KEY_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export class AiStatusProtocolError extends Error {}

export function validateAiStatusSyncPayload(value: unknown): asserts value is AiStatusSyncPayload {
  const payload = record(value, "AI status payload");
  exactKeys(payload, ["schemaVersion", "sharing", "generatedAt", "expiresAt", "tools"], "AI status payload");
  if (payload.schemaVersion !== TETI_AI_STATUS_SCHEMA_VERSION) {
    throw new AiStatusProtocolError("Unsupported AI status schema version.");
  }
  if (payload.sharing !== "enabled" && payload.sharing !== "disabled") {
    throw new AiStatusProtocolError("AI status sharing state is invalid.");
  }
  const generatedAt = isoTimestamp(payload.generatedAt, "generatedAt");
  const expiresAt = isoTimestamp(payload.expiresAt, "expiresAt");
  if (expiresAt <= generatedAt) {
    throw new AiStatusProtocolError("AI status expiresAt must be after generatedAt.");
  }
  if (expiresAt - generatedAt > MAX_TTL_MS) {
    throw new AiStatusProtocolError("AI status expiry exceeds the allowed TTL.");
  }
  if (!Array.isArray(payload.tools) || payload.tools.length > MAX_TOOLS) {
    throw new AiStatusProtocolError("AI status tools must be a bounded array.");
  }
  if (payload.sharing === "disabled" && payload.tools.length !== 0) {
    throw new AiStatusProtocolError("A disabled AI status payload cannot contain tools.");
  }
  for (const tool of payload.tools) validateTool(tool);
}

function validateTool(value: unknown): asserts value is AiToolStatusSnapshot {
  const tool = record(value, "AI tool status");
  exactKeys(tool, ["toolId", "status", "plan", "quotas", "observedAt"], "AI tool status");
  shortString(tool.toolId, "toolId", MAX_TOOL_ID_LENGTH);
  if (!TOOL_ID_PATTERN.test(tool.toolId as string)) {
    throw new AiStatusProtocolError("AI tool status toolId is invalid.");
  }
  if (!["ready", "stale", "unavailable"].includes(tool.status as string)) {
    throw new AiStatusProtocolError("AI tool status state is invalid.");
  }
  isoTimestamp(tool.observedAt, "observedAt");

  const plan = record(tool.plan, "AI tool plan");
  exactKeys(plan, ["key", "membershipVerified"], "AI tool plan");
  if (plan.key !== null) shortKey(plan.key, "plan key");
  if (typeof plan.membershipVerified !== "boolean") {
    throw new AiStatusProtocolError("AI tool plan membershipVerified must be boolean.");
  }

  if (!Array.isArray(tool.quotas) || tool.quotas.length > MAX_QUOTAS_PER_TOOL) {
    throw new AiStatusProtocolError("AI tool quotas must be a bounded array.");
  }
  for (const quota of tool.quotas) validateQuota(quota);
}

function validateQuota(value: unknown): asserts value is AiToolQuotaStatus {
  const quota = record(value, "AI tool quota");
  exactKeys(
    quota,
    ["period", "remainingPercent", "resetAt", "windowSeconds", "identification"],
    "AI tool quota"
  );
  shortKey(quota.period, "quota period");
  if (typeof quota.remainingPercent !== "number"
    || !Number.isFinite(quota.remainingPercent)
    || quota.remainingPercent < 0
    || quota.remainingPercent > 100) {
    throw new AiStatusProtocolError("AI tool quota remainingPercent is invalid.");
  }
  if (quota.resetAt !== null) isoTimestamp(quota.resetAt, "resetAt");
  if (quota.windowSeconds !== null
    && (typeof quota.windowSeconds !== "number"
      || !Number.isFinite(quota.windowSeconds)
      || quota.windowSeconds <= 0)) {
    throw new AiStatusProtocolError("AI tool quota windowSeconds is invalid.");
  }
  if (quota.identification !== "exact" && quota.identification !== "inferred") {
    throw new AiStatusProtocolError("AI tool quota identification is invalid.");
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AiStatusProtocolError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra) throw new AiStatusProtocolError(`${label} contains an unsupported field.`);
  const missing = allowed.find((key) => !(key in value));
  if (missing) throw new AiStatusProtocolError(`${label} is missing a required field.`);
}

function shortString(value: unknown, label: string, maxLength: number): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new AiStatusProtocolError(`${label} is invalid.`);
  }
}

function shortKey(value: unknown, label: string): asserts value is string {
  shortString(value, label, MAX_SHORT_VALUE_LENGTH);
  if (!SHORT_KEY_PATTERN.test(value)) {
    throw new AiStatusProtocolError(`${label} is invalid.`);
  }
}

function isoTimestamp(value: unknown, label: string): number {
  if (typeof value !== "string" || !value.trim()) {
    throw new AiStatusProtocolError(`AI status ${label} is required.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new AiStatusProtocolError(`AI status ${label} is invalid.`);
  return parsed;
}
