import assert from "node:assert/strict";
import test from "node:test";
import {
  CODEBUDDY_JSONL_LIMITS,
  classifyCodeBuddyFailure,
  decodeCodeBuddyArtifact,
  parseCodeBuddyJsonl
} from "../../../integrations/agents/codebuddy/jsonl.ts";

test("CodeBuddy JSONL projects only the final successful text", () => {
  const output = jsonl([
    {
      type: "system",
      subtype: "init",
      session_id: "private-session",
      apiKeySource: "private-auth-source",
      cwd: "/private/path",
      tools: ["Read", "Bash"]
    },
    { type: "system", subtype: "status", status: null },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Private reasoning must not project." },
          { type: "text", text: "Safe final answer." }
        ]
      },
      usage: { input_tokens: 10 }
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Safe final answer.",
      total_cost_usd: 1,
      session_id: "private-session"
    }
  ]);

  assert.deepEqual(parseCodeBuddyJsonl(output), {
    terminalState: "completed",
    failureKind: null,
    finalMessage: "Safe final answer.",
    eventCount: 4,
    initialized: true
  });
  assert.equal(decodeCodeBuddyArtifact(output), "Safe final answer.");
});

test("CodeBuddy JSONL recognizes authentication failure even when the process exits zero", () => {
  const output = jsonl([
    { type: "system", subtype: "init" },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{
          type: "text",
          text: "Authentication required. Please use /login command to sign in."
        }]
      }
    },
    {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["Authentication required. Please use /login command to sign in."]
    }
  ]);

  assert.equal(parseCodeBuddyJsonl(output).failureKind, "auth");
  assert.equal(classifyCodeBuddyFailure(output), "ADAPTER_AUTH_REQUIRED");
  assert.throws(
    () => decodeCodeBuddyArtifact(output),
    (error: unknown) => errorCode(error) === "ADAPTER_AUTH_REQUIRED"
  );
});

test("CodeBuddy JSONL rejects tool and non-text content instead of projecting it", () => {
  const output = jsonl([
    { type: "system", subtype: "init" },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Read", input: { path: "/secret" } }]
      }
    },
    { type: "result", subtype: "success", is_error: false }
  ]);

  assert.throws(
    () => decodeCodeBuddyArtifact(output),
    (error: unknown) => errorCode(error) === "ADAPTER_UPSTREAM_FAILED"
  );
});

test("CodeBuddy JSONL fails closed for malformed, incomplete, unknown, or post-terminal events", () => {
  const invalid = [
    "not-json\n",
    jsonl([{ type: "assistant", message: { role: "assistant", content: [] } }]),
    jsonl([{ type: "system", subtype: "init" }]),
    jsonl([{ type: "system", subtype: "init" }, { type: "future.event" }]),
    jsonl([
      { type: "system", subtype: "init" },
      { type: "result", subtype: "success", is_error: false, result: "ok" },
      { type: "system", subtype: "status" }
    ])
  ];

  for (const output of invalid) {
    assert.throws(
      () => decodeCodeBuddyArtifact(output),
      (error: unknown) => errorCode(error) === "ADAPTER_OUTPUT_INVALID"
    );
  }
});

test("CodeBuddy JSONL enforces event and line limits", () => {
  const tooMany = Array.from(
    { length: CODEBUDDY_JSONL_LIMITS.maximumEvents + 1 },
    () => ({ type: "system", subtype: "status" })
  );
  assert.throws(() => parseCodeBuddyJsonl(jsonl(tooMany)));
  assert.throws(() => parseCodeBuddyJsonl(jsonl([{
    type: "system",
    subtype: "init",
    padding: "x".repeat(CODEBUDDY_JSONL_LIMITS.maximumLineBytes)
  }])));
});

function jsonl(values: unknown[]): string {
  return `${values.map((value) => JSON.stringify(value)).join("\n")}\n`;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "safeErrorCode" in error
    && typeof error.safeErrorCode === "string"
    ? error.safeErrorCode
    : undefined;
}
