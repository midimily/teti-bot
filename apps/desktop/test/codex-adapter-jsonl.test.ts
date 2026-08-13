import assert from "node:assert/strict";
import test from "node:test";
import {
  CODEX_JSONL_LIMITS,
  classifyCodexFailure,
  decodeCodexArtifact,
  parseCodexJsonl
} from "../../../integrations/agents/codex/jsonl.ts";

test("Codex JSONL maps the documented lifecycle to one controlled Artifact", () => {
  const output = jsonl([
    { type: "thread.started", thread_id: "private-thread-id" },
    { type: "turn.started" },
    {
      type: "item.completed",
      item: {
        id: "command-item",
        type: "command_execution",
        command: "cat ~/.codex/auth.json",
        aggregated_output: "secret-must-never-project"
      }
    },
    {
      type: "item.completed",
      item: { id: "reasoning-item", type: "reasoning", text: "private reasoning" }
    },
    {
      type: "item.completed",
      item: { id: "message-item", type: "agent_message", text: "Safe final answer." }
    },
    { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 3 } }
  ]);

  assert.deepEqual(parseCodexJsonl(output), {
    terminalState: "completed",
    failureKind: null,
    finalMessage: "Safe final answer.",
    eventCount: 6,
    threadStarted: true,
    turnStarted: true
  });
  assert.equal(decodeCodexArtifact(output), "Safe final answer.");
  assert.equal(decodeCodexArtifact(output).includes("secret"), false);
  assert.equal(decodeCodexArtifact(output).includes("reasoning"), false);
});

test("Codex JSONL maps an expired local login to the safe authentication state", () => {
  const output = jsonl([
    { type: "thread.started" },
    { type: "turn.started" },
    { type: "turn.failed", error: { message: "Authentication token expired. Please login again." } }
  ]);

  assert.equal(parseCodexJsonl(output).failureKind, "auth");
  assert.equal(classifyCodexFailure(output), "ADAPTER_AUTH_REQUIRED");
  assert.throws(
    () => decodeCodexArtifact(output),
    (error: unknown) => readSafeCode(error) === "ADAPTER_AUTH_REQUIRED"
  );
  assert.equal(JSON.stringify(parseCodexJsonl(output)).includes("token expired"), false);
});

test("Codex JSONL uses the last completed agent message as final output", () => {
  const output = jsonl([
    { type: "thread.started", thread_id: "thread" },
    { type: "turn.started" },
    { type: "item.completed", item: { type: "agent_message", text: "Draft" } },
    { type: "item.completed", item: { type: "agent_message", text: "Final" } },
    { type: "turn.completed" }
  ]);
  assert.equal(decodeCodexArtifact(output), "Final");
});

test("Codex JSONL accepts the legacy documented assistant message shape", () => {
  const output = jsonl([
    { type: "thread.started", thread_id: "thread" },
    { type: "turn.started" },
    {
      type: "item.completed",
      item: { item_type: "assistant_message", text: "Legacy compatible final" }
    },
    { type: "turn.completed" }
  ]);
  assert.equal(decodeCodexArtifact(output), "Legacy compatible final");
});

test("Codex JSONL turns failed and error events into a safe upstream failure", () => {
  for (const terminal of ["turn.failed", "error"]) {
    const output = jsonl([
      { type: "thread.started", thread_id: "thread" },
      { type: "turn.started" },
      { type: terminal, message: "provider-private-message" }
    ]);
    assert.throws(
      () => decodeCodexArtifact(output),
      (error: unknown) => readSafeCode(error) === "ADAPTER_UPSTREAM_FAILED"
    );
    assert.equal(classifyCodexFailure(output), "ADAPTER_UPSTREAM_FAILED");
  }
});

test("Codex JSONL fails closed for malformed, incomplete, or invalid-order streams", () => {
  const invalid = [
    "not-json",
    jsonl([{ type: "thread.started", thread_id: "thread" }]),
    jsonl([{ type: "turn.started" }, { type: "turn.completed" }]),
    jsonl([
      { type: "thread.started", thread_id: "thread" },
      { type: "turn.started" },
      { type: "turn.completed" },
      { type: "item.completed", item: { type: "agent_message", text: "late" } }
    ]),
    jsonl([
      { type: "thread.started", thread_id: "thread" },
      { type: "turn.started" },
      { type: "turn.completed" }
    ])
  ];
  for (const output of invalid) {
    assert.throws(
      () => decodeCodexArtifact(output),
      (error: unknown) => readSafeCode(error) === "ADAPTER_OUTPUT_INVALID"
    );
  }
});

test("Codex JSONL enforces per-line and event-count bounds", () => {
  assert.throws(
    () => parseCodexJsonl(JSON.stringify({
      type: "unknown",
      padding: "x".repeat(CODEX_JSONL_LIMITS.maximumLineBytes)
    })),
    /line exceeds/
  );
  const events = Array.from(
    { length: CODEX_JSONL_LIMITS.maximumEvents + 1 },
    () => ({ type: "unknown" })
  );
  assert.throws(() => parseCodexJsonl(jsonl(events)), /event count/);
});

function jsonl(events: readonly unknown[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

function readSafeCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "safeErrorCode" in error
    && typeof error.safeErrorCode === "string"
    ? error.safeErrorCode
    : undefined;
}
