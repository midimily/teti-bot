import type { AiToolStatusSnapshot } from "../../../../core/ai-status/types.ts";
import { createDesktopI18n, type DesktopI18n } from "../i18n/index.ts";
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

export function presentCodexUsage(
  state: CodexUsageState,
  i18n: DesktopI18n = createDesktopI18n("zh-Hans")
): CodexUsagePresentation {
  if (state.status === "unavailable") {
    const signedOut = ["AUTH_FILE_NOT_FOUND", "AUTH_TOKEN_MISSING"].includes(state.error.code);
    return {
      tone: "unavailable",
      planKey: null,
      planLabel: signedOut
        ? i18n.messages.passport.usage.signedOut
        : i18n.messages.passport.usage.unavailable,
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
    planLabel: plan?.label ?? i18n.messages.passport.usage.unknownPlan,
    remainingPercent: state.snapshot.weekly?.remainingPercent ?? null,
    resetAt: state.snapshot.weekly?.resetAt ?? null,
    inferred: state.snapshot.weekly?.identification === "inferred",
    stale: state.status === "stale" || state.snapshot.stale,
    unavailableReason: plan ? null : "unknown-plan"
  };
}

export function createShareableCodexStatus(state: CodexUsageState, now = new Date()): AiToolStatusSnapshot {
  const snapshot = state.status === "ready" || state.status === "stale" ? state.snapshot : null;
  const providerSnapshot = snapshot?.source === "live" ? snapshot : null;
  const plan = normalizeCodexPlan(providerSnapshot?.planTypeRaw ?? null);
  return {
    toolId: CODEX_TOOL_ID,
    status: providerSnapshot
      ? state.status === "ready" ? "ready" : "stale"
      : "unavailable",
    plan: {
      key: plan?.key ?? null,
      membershipVerified: false
    },
    quotas: providerSnapshot?.weekly ? [{
      period: "week",
      remainingPercent: Math.round(providerSnapshot.weekly.remainingPercent),
      resetAt: providerSnapshot.weekly.resetAt,
      windowSeconds: providerSnapshot.weekly.windowSeconds,
      identification: providerSnapshot.weekly.identification
    }] : [],
    observedAt: providerSnapshot?.observedAt ?? now.toISOString()
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
