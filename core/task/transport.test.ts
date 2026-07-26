import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalTaskRequestJson,
  selectTaskProtocolVersion,
  TaskTransportContractError,
  validateTaskProtocolVersions,
  validateTaskReceiptPayload
} from "./transport-validation.ts";
import type { CollaborationTaskRequest } from "./types.ts";

const receivedAt = "2026-07-26T01:00:00.000Z";

test("Task receipt is strict, identity-bound metadata with advertised versions", () => {
  const receipt = {
    schemaVersion: 1,
    taskId: "task-001",
    requesterTetiId: "teti_sender001",
    targetTetiId: "teti_target001",
    status: "received",
    receivedAt,
    supportedTaskVersions: [1]
  };
  assert.doesNotThrow(() => validateTaskReceiptPayload(receipt));
  assert.throws(
    () => validateTaskReceiptPayload({ ...receipt, token: "must-not-cross" }),
    TaskTransportContractError
  );
  assert.throws(
    () => validateTaskReceiptPayload({ ...receipt, supportedTaskVersions: [1, 1] }),
    /versions/
  );
});

test("Task negotiation keeps v1 for unknown peers and selects the highest known common version", () => {
  assert.equal(selectTaskProtocolVersion(), 1);
  assert.equal(selectTaskProtocolVersion([2, 1]), 2);
  assert.equal(selectTaskProtocolVersion([2]), 2);
  assert.equal(selectTaskProtocolVersion([3]), null);
  assert.doesNotThrow(() => validateTaskProtocolVersions([1, 2]));
});

test("canonical Task comparison ignores JSON property insertion order", () => {
  const request = makeRequest();
  const reordered = {
    expiresAt: request.expiresAt,
    input: { text: request.input.text, kind: request.input.kind },
    capabilityId: request.capabilityId,
    offerId: request.offerId,
    targetTetiId: request.targetTetiId,
    requesterTetiId: request.requesterTetiId,
    taskId: request.taskId,
    createdAt: request.createdAt,
    schemaVersion: request.schemaVersion
  };
  assert.equal(canonicalTaskRequestJson(request), canonicalTaskRequestJson(reordered));
});

test("canonical Task comparison covers ordered v2 text and image parts", () => {
  const request: CollaborationTaskRequest = {
    ...makeRequest(),
    schemaVersion: 2,
    input: {
      kind: "parts",
      parts: [{ kind: "text", text: "Inspect these screenshots." }, {
        kind: "image",
        attachmentId: "image-001",
        mimeType: "image/png",
        byteLength: 1024,
        width: 640,
        height: 480,
        sha256: `sha256:${"a".repeat(64)}`
      }, {
        kind: "image",
        attachmentId: "image-002",
        mimeType: "image/jpeg",
        byteLength: 2048,
        width: 800,
        height: 600,
        sha256: `sha256:${"b".repeat(64)}`
      }]
    }
  };
  assert.equal(canonicalTaskRequestJson(request), canonicalTaskRequestJson(structuredClone(request)));
  const parts = request.input.kind === "parts" ? request.input.parts : [];
  const reorderedParts: CollaborationTaskRequest = {
    ...request,
    input: { kind: "parts", parts: [parts[0]!, parts[2]!, parts[1]!] }
  };
  assert.notEqual(canonicalTaskRequestJson(request), canonicalTaskRequestJson(reorderedParts));
});

function makeRequest(): CollaborationTaskRequest {
  return {
    schemaVersion: 1,
    taskId: "task-001",
    requesterTetiId: "teti_sender001",
    targetTetiId: "teti_target001",
    offerId: "offer-001",
    capabilityId: "code-analysis",
    input: { kind: "text", text: "Review this text." },
    createdAt: "2026-07-26T00:00:00.000Z",
    expiresAt: "2026-07-26T02:00:00.000Z"
  };
}
