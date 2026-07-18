import type { CodexUsageSnapshot, CodexWeeklyUsage } from "../../src/codex-usage/types.ts";
import { CodexUsageError } from "./errors.ts";

const WEEK_SECONDS = 7 * 24 * 60 * 60;
const WEEK_TOLERANCE_SECONDS = 60 * 60;
const MIN_INFERRED_WINDOW_SECONDS = 24 * 60 * 60;

interface ParsedBucket {
  remainingPercent: number;
  resetAt: string | null;
  windowSeconds: number | null;
}

export function parseCodexUsagePayload(
  payload: unknown,
  options: { observedAt: Date; fetchedAt?: Date }
): CodexUsageSnapshot {
  const root = asRecord(payload);
  const rate = asRecord(root?.rate_limit) ?? asRecord(root?.rate_limits);
  if (!root || !rate) {
    throw new CodexUsageError("PAYLOAD_SCHEMA_MISMATCH", { recoverable: false });
  }

  const candidates = [
    asRecord(rate.primary) ?? asRecord(rate.primary_window),
    asRecord(rate.secondary) ?? asRecord(rate.secondary_window)
  ].flatMap((bucket) => {
    const parsed = parseBucket(bucket, options.observedAt);
    return parsed ? [parsed] : [];
  });

  const planTypeRaw = typeof root.plan_type === "string" ? root.plan_type : null;
  return {
    source: "live",
    planTypeRaw,
    // No billing-grade mapping has been confirmed in teti-bot yet.
    planDisplayName: null,
    membershipVerified: false,
    weekly: selectWeekly(candidates),
    observedAt: options.observedAt.toISOString(),
    fetchedAt: (options.fetchedAt ?? options.observedAt).toISOString(),
    stale: false
  };
}

function parseBucket(bucket: Record<string, unknown> | null, observedAt: Date): ParsedBucket | null {
  if (!bucket) return null;
  const remainingPercent = readRemainingPercent(bucket);
  if (remainingPercent === null) return null;
  return {
    remainingPercent,
    resetAt: readResetAt(bucket, observedAt),
    windowSeconds: readWindowSeconds(bucket)
  };
}

function selectWeekly(candidates: ParsedBucket[]): CodexWeeklyUsage | null {
  const exact = candidates
    .filter((bucket) => bucket.windowSeconds !== null
      && Math.abs(bucket.windowSeconds - WEEK_SECONDS) <= WEEK_TOLERANCE_SECONDS)
    .sort((a, b) => Math.abs((a.windowSeconds ?? 0) - WEEK_SECONDS)
      - Math.abs((b.windowSeconds ?? 0) - WEEK_SECONDS))[0];
  if (exact) return toWeekly(exact, "exact");

  const inferred = candidates
    .filter((bucket) => bucket.windowSeconds !== null
      && bucket.windowSeconds >= MIN_INFERRED_WINDOW_SECONDS)
    .sort((a, b) => (b.windowSeconds ?? 0) - (a.windowSeconds ?? 0))[0];
  return inferred ? toWeekly(inferred, "inferred") : null;
}

function toWeekly(bucket: ParsedBucket, identification: "exact" | "inferred"): CodexWeeklyUsage {
  return {
    remainingPercent: bucket.remainingPercent,
    usedPercent: clamp(100 - bucket.remainingPercent),
    resetAt: bucket.resetAt,
    windowSeconds: bucket.windowSeconds,
    identification
  };
}

function readRemainingPercent(bucket: Record<string, unknown>): number | null {
  const remaining = finiteNumber(bucket.remaining_percent);
  if (remaining !== null) return clamp(remaining);
  const used = finiteNumber(bucket.used_percent);
  return used === null ? null : clamp(100 - used);
}

function readWindowSeconds(bucket: Record<string, unknown>): number | null {
  for (const key of ["limit_window_seconds", "window_seconds"] as const) {
    const value = finiteNumber(bucket[key]);
    if (value !== null && value > 0) return value;
  }
  const minutes = finiteNumber(bucket.window_minutes);
  return minutes !== null && minutes > 0 ? minutes * 60 : null;
}

function readResetAt(bucket: Record<string, unknown>, observedAt: Date): string | null {
  for (const key of ["reset_at", "resets_at", "reset_time", "expires_at", "window_reset_at"] as const) {
    if (bucket[key] !== undefined && bucket[key] !== null) {
      const parsed = absoluteDate(bucket[key]);
      if (parsed) return parsed.toISOString();
    }
  }
  for (const key of ["reset_after_seconds", "seconds_until_reset", "reset_in_seconds"] as const) {
    const seconds = finiteNumber(bucket[key]);
    if (seconds !== null) {
      const date = new Date(observedAt.getTime() + seconds * 1_000);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
  }
  return null;
}

function absoluteDate(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = Math.abs(value) > 999_999_999_999 ? value : value * 1_000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return absoluteDate(numeric);
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
