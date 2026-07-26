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
        if (item?.type === "agent_message") {
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
        break;

      case "error":
        terminalState = "error";
        break;

      default:
        // Forward-compatible event types remain bounded but are not persisted.
        break;
    }
  }

  return {
    terminalState,
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
      "ADAPTER_UPSTREAM_FAILED",
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
      ? "ADAPTER_UPSTREAM_FAILED"
      : "ADAPTER_EXIT_NONZERO";
  } catch {
    return "ADAPTER_EXIT_NONZERO";
  }
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
