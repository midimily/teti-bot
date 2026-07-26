import {
  CallableAdapterOutputError,
  type CallableAdapterSafeErrorCode
} from "../../../core/callability/adapter.ts";
import { MAX_TASK_ARTIFACT_TEXT_BYTES } from "../../../core/task/types.ts";

export const CODEBUDDY_JSONL_LIMITS = {
  maximumEvents: 4_096,
  maximumLineBytes: 128 * 1024
} as const;

export interface CodeBuddyJsonlSummary {
  terminalState: "completed" | "failed" | "missing";
  failureKind: "auth" | "upstream" | null;
  finalMessage: string | null;
  eventCount: number;
  initialized: boolean;
}

/**
 * Parses only the documented Headless stream surface required by Teti. Session
 * identifiers, account source, cwd, tool catalogs, model, usage, cost,
 * timestamps, diagnostics, and permission details are never projected.
 */
export function parseCodeBuddyJsonl(stdout: string): CodeBuddyJsonlSummary {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0 || lines.length > CODEBUDDY_JSONL_LIMITS.maximumEvents) {
    throw invalidOutput("CodeBuddy JSONL event count is invalid.");
  }

  let initialized = false;
  let terminalState: CodeBuddyJsonlSummary["terminalState"] = "missing";
  let failureKind: CodeBuddyJsonlSummary["failureKind"] = null;
  let finalMessage: string | null = null;

  for (const line of lines) {
    if (utf8Size(line) > CODEBUDDY_JSONL_LIMITS.maximumLineBytes) {
      throw invalidOutput("CodeBuddy JSONL line exceeds the allowed size.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw invalidOutput("CodeBuddy JSONL contains malformed JSON.");
    }
    const event = record(parsed);
    if (!event || typeof event.type !== "string" || event.type.length > 80) {
      throw invalidOutput("CodeBuddy JSONL event type is invalid.");
    }
    if (terminalState !== "missing") {
      throw invalidOutput("CodeBuddy JSONL contains events after a terminal result.");
    }

    switch (event.type) {
      case "system":
        if (event.subtype === "init") initialized = true;
        break;

      case "assistant": {
        if (!initialized) {
          throw invalidOutput("CodeBuddy assistant output arrived before initialization.");
        }
        const message = record(event.message);
        if (!message || message.role !== "assistant" || !Array.isArray(message.content)) {
          throw invalidOutput("CodeBuddy assistant message is invalid.");
        }
        const textParts: string[] = [];
        for (const value of message.content) {
          const content = record(value);
          if (content?.type === "thinking" && typeof content.thinking === "string") {
            // Bounded by the JSONL line budget and intentionally discarded.
            continue;
          }
          if (!content || content.type !== "text" || typeof content.text !== "string") {
            throw new CallableAdapterOutputError(
              "ADAPTER_UPSTREAM_FAILED",
              "CodeBuddy attempted a non-text or tool output."
            );
          }
          if (content.text.trim()) textParts.push(content.text);
        }
        const messageText = textParts.join("\n").trim();
        if (messageText) {
          if (utf8Size(messageText) > MAX_TASK_ARTIFACT_TEXT_BYTES) {
            throw invalidOutput("CodeBuddy assistant message exceeds the Artifact limit.");
          }
          finalMessage = messageText;
        }
        break;
      }

      case "result": {
        if (!initialized || typeof event.is_error !== "boolean") {
          throw invalidOutput("CodeBuddy terminal result is invalid.");
        }
        const resultText = typeof event.result === "string" && event.result.trim()
          ? event.result.trim()
          : null;
        const failureText = collectFailureText(event, finalMessage);
        if (event.is_error || event.subtype !== "success") {
          terminalState = "failed";
          failureKind = isAuthenticationFailure(failureText) ? "auth" : "upstream";
          break;
        }
        if (resultText) {
          if (utf8Size(resultText) > MAX_TASK_ARTIFACT_TEXT_BYTES) {
            throw invalidOutput("CodeBuddy result exceeds the Artifact limit.");
          }
          finalMessage = resultText;
        }
        terminalState = "completed";
        break;
      }

      default:
        throw invalidOutput("CodeBuddy JSONL contains an unsupported event type.");
    }
  }

  return {
    terminalState,
    failureKind,
    finalMessage,
    eventCount: lines.length,
    initialized
  };
}

export function decodeCodeBuddyArtifact(stdout: string): string {
  const summary = parseCodeBuddyJsonl(stdout);
  if (summary.terminalState === "failed") {
    throw new CallableAdapterOutputError(
      summary.failureKind === "auth" ? "ADAPTER_AUTH_REQUIRED" : "ADAPTER_UPSTREAM_FAILED",
      "CodeBuddy reported a failed task."
    );
  }
  if (summary.terminalState !== "completed" || !summary.finalMessage) {
    throw invalidOutput("CodeBuddy JSONL is missing a completed final assistant message.");
  }
  return summary.finalMessage;
}

export function classifyCodeBuddyFailure(stdout: string): CallableAdapterSafeErrorCode {
  try {
    const summary = parseCodeBuddyJsonl(stdout);
    if (summary.failureKind === "auth") return "ADAPTER_AUTH_REQUIRED";
    if (summary.terminalState === "failed") return "ADAPTER_UPSTREAM_FAILED";
    return "ADAPTER_EXIT_NONZERO";
  } catch (error) {
    return error instanceof CallableAdapterOutputError
      ? error.safeErrorCode
      : "ADAPTER_EXIT_NONZERO";
  }
}

function collectFailureText(
  event: Record<string, unknown>,
  assistantText: string | null
): string {
  const values = [assistantText ?? ""];
  if (typeof event.result === "string") values.push(event.result);
  if (Array.isArray(event.errors)) {
    for (const value of event.errors) {
      if (typeof value === "string" && value.length <= 4_096) values.push(value);
    }
  }
  return values.join("\n").slice(0, 16 * 1024);
}

function isAuthenticationFailure(value: string): boolean {
  return /(?:authentication|login|sign[ -]?in).{0,32}(?:required|needed)|please use \/login|not (?:authenticated|logged in)|unauthori[sz]ed/i
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
