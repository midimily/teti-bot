import {
  CallableAdapterOutputError,
  type CallableAdapterSafeErrorCode
} from "../../../core/callability/adapter.ts";
import { MAX_TASK_ARTIFACT_TEXT_BYTES } from "../../../core/task/types.ts";

export const CODEX_JSONL_LIMITS = {
  maximumEvents: 4_096,
  maximumLineBytes: 128 * 1024
} as const;

export interface CodexJsonlSummary {
  terminalState: "completed" | "failed" | "error" | "missing";
  failureKind: "auth" | "upstream" | null;
  finalMessage: string | null;
  eventCount: number;
  threadStarted: boolean;
  turnStarted: boolean;
}

/**
 * Parses only the small documented event surface needed by Teti. Reasoning,
 * command output, file changes, tool calls, usage, thread IDs, and diagnostics
 * are intentionally ignored and never become an Artifact.
 */
export function parseCodexJsonl(stdout: string): CodexJsonlSummary {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0 || lines.length > CODEX_JSONL_LIMITS.maximumEvents) {
    throw invalidOutput("Codex JSONL event count is invalid.");
  }

  let threadStarted = false;
  let turnStarted = false;
  let terminalState: CodexJsonlSummary["terminalState"] = "missing";
  let failureKind: CodexJsonlSummary["failureKind"] = null;
  let finalMessage: string | null = null;

  for (const line of lines) {
    if (utf8Size(line) > CODEX_JSONL_LIMITS.maximumLineBytes) {
      throw invalidOutput("Codex JSONL line exceeds the allowed size.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw invalidOutput("Codex JSONL contains malformed JSON.");
    }
    const event = record(parsed);
    if (!event || typeof event.type !== "string" || event.type.length > 80) {
      throw invalidOutput("Codex JSONL event type is invalid.");
    }
    if (terminalState !== "missing") {
      throw invalidOutput("Codex JSONL contains events after a terminal state.");
    }

    switch (event.type) {
      case "thread.started":
        if (threadStarted || turnStarted) {
          throw invalidOutput("Codex JSONL thread state is invalid.");
        }
        threadStarted = true;
        break;

      case "turn.started":
        if (!threadStarted || turnStarted) {
          throw invalidOutput("Codex JSONL turn state is invalid.");
        }
        turnStarted = true;
        break;

      case "item.completed": {
        if (!turnStarted) throw invalidOutput("Codex JSONL item arrived before turn start.");
        const item = record(event.item);
        const itemType = typeof item?.type === "string"
          ? item.type
          : typeof item?.item_type === "string"
            ? item.item_type
            : null;
        // Current Codex uses `type: agent_message`. Older documented JSONL
        // clients used `item_type: assistant_message`; both represent the same
        // bounded final-answer surface and neither exposes tool/reasoning data.
        if (item && (itemType === "agent_message" || itemType === "assistant_message")) {
          if (typeof item.text !== "string" || !item.text.trim()) {
            throw invalidOutput("Codex agent message is invalid.");
          }
          if (utf8Size(item.text) > MAX_TASK_ARTIFACT_TEXT_BYTES) {
            throw invalidOutput("Codex agent message exceeds the Artifact limit.");
          }
          finalMessage = item.text;
        }
        break;
      }

      case "turn.completed":
        if (!threadStarted || !turnStarted) {
          throw invalidOutput("Codex JSONL completed without a started turn.");
        }
        terminalState = "completed";
        break;

      case "turn.failed":
        terminalState = "failed";
        failureKind = isAuthenticationFailure(collectFailureText(event)) ? "auth" : "upstream";
        break;

      case "error":
        terminalState = "error";
        failureKind = isAuthenticationFailure(collectFailureText(event)) ? "auth" : "upstream";
        break;

      default:
        // Forward-compatible event types remain bounded but are not persisted.
        break;
    }
  }

  return {
    terminalState,
    failureKind,
    finalMessage,
    eventCount: lines.length,
    threadStarted,
    turnStarted
  };
}

export function decodeCodexArtifact(stdout: string): string {
  const summary = parseCodexJsonl(stdout);
  if (summary.terminalState === "failed" || summary.terminalState === "error") {
    throw new CallableAdapterOutputError(
      summary.failureKind === "auth" ? "ADAPTER_AUTH_REQUIRED" : "ADAPTER_UPSTREAM_FAILED",
      "Codex reported a failed turn."
    );
  }
  if (summary.terminalState !== "completed" || !summary.finalMessage) {
    throw invalidOutput("Codex JSONL is missing a completed final agent message.");
  }
  return summary.finalMessage;
}

export function classifyCodexFailure(stdout: string): CallableAdapterSafeErrorCode {
  try {
    const summary = parseCodexJsonl(stdout);
    return summary.terminalState === "failed" || summary.terminalState === "error"
      ? summary.failureKind === "auth" ? "ADAPTER_AUTH_REQUIRED" : "ADAPTER_UPSTREAM_FAILED"
      : "ADAPTER_EXIT_NONZERO";
  } catch {
    return "ADAPTER_EXIT_NONZERO";
  }
}

function collectFailureText(event: Record<string, unknown>): string {
  const values: string[] = [];
  if (typeof event.message === "string") values.push(event.message);
  const error = record(event.error);
  if (typeof error?.message === "string") values.push(error.message);
  return values.join("\n").slice(0, 8 * 1024);
}

function isAuthenticationFailure(value: string): boolean {
  return /(?:authentication|login|sign[ -]?in).{0,32}(?:required|needed)|not (?:authenticated|logged in)|unauthori[sz]ed|token.{0,24}(?:expired|invalid)/i
    .test(value);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function invalidOutput(message: string): CallableAdapterOutputError {
  return new CallableAdapterOutputError("ADAPTER_OUTPUT_INVALID", message);
}

function utf8Size(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
