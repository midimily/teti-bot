import type { AiToolStatusSnapshot } from "../../../../core/ai-status/types.ts";
import type { CodexUsageSnapshot, CodexUsageState } from "./types.ts";

export const CODEX_TOOL_ID = "openai.codex";

export type CodexPlanTone = "free" | "plus" | "pro" | "unknown" | "unavailable";

export interface CodexUsagePresentation {
  tone: CodexPlanTone;
  planKey: "free" | "plus" | "pro" | null;
  planLabel: string;
  remainingPercent: number | null;
  resetAt: string | null;
  inferred: boolean;
  stale: boolean;
  unavailableReason: "signed-out" | "unknown-plan" | "unavailable" | null;
}

export function presentCodexUsage(state: CodexUsageState): CodexUsagePresentation {
  if (state.status === "unavailable") {
    const signedOut = ["AUTH_FILE_NOT_FOUND", "AUTH_TOKEN_MISSING"].includes(state.error.code);
    return {
      tone: "unavailable",
      planKey: null,
      planLabel: signedOut ? "未登录" : "暂不可用",
      remainingPercent: null,
      resetAt: null,
      inferred: false,
      stale: false,
      unavailableReason: signedOut ? "signed-out" : "unavailable"
    };
  }

  const plan = normalizeCodexPlan(state.snapshot.planTypeRaw);
  return {
    tone: plan?.key ?? "unknown",
    planKey: plan?.key ?? null,
    planLabel: plan?.label ?? "计划未知",
    remainingPercent: state.snapshot.weekly?.remainingPercent ?? null,
    resetAt: state.snapshot.weekly?.resetAt ?? null,
    inferred: state.snapshot.weekly?.identification === "inferred",
    stale: state.status === "stale" || state.snapshot.stale,
    unavailableReason: plan ? null : "unknown-plan"
  };
}

export function createShareableCodexStatus(state: CodexUsageState, now = new Date()): AiToolStatusSnapshot {
  const snapshot = state.status === "ready" || state.status === "stale" ? state.snapshot : null;
  const plan = normalizeCodexPlan(snapshot?.planTypeRaw ?? null);
  return {
    toolId: CODEX_TOOL_ID,
    status: state.status === "ready" ? "ready" : state.status === "stale" ? "stale" : "unavailable",
    plan: {
      key: plan?.key ?? null,
      membershipVerified: false
    },
    quotas: snapshot?.weekly ? [{
      period: "week",
      remainingPercent: Math.round(snapshot.weekly.remainingPercent),
      resetAt: snapshot.weekly.resetAt,
      windowSeconds: snapshot.weekly.windowSeconds,
      identification: snapshot.weekly.identification
    }] : [],
    observedAt: snapshot?.observedAt ?? now.toISOString()
  };
}

export function normalizeCodexPlan(
  planTypeRaw: CodexUsageSnapshot["planTypeRaw"]
): { key: "free" | "plus" | "pro"; label: string } | null {
  switch (planTypeRaw?.trim().toLowerCase()) {
    case "free":
      return { key: "free", label: "Free" };
    case "plus":
      return { key: "plus", label: "Plus" };
    case "pro":
      return { key: "pro", label: "Pro" };
    default:
      return null;
  }
}
