import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalTaskRequestJson,
  selectTaskProtocolVersion,
  TaskTransportContractError,
  validateTaskAttachmentPayload,
  validateTaskAttachmentReceiptPayload,
  validateTaskArtifactFilePayload,
  validateTaskArtifactReceiptPayload,
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
    supportedTaskVersions: [7]
  };
  assert.doesNotThrow(() => validateTaskReceiptPayload(receipt));
  assert.throws(
    () => validateTaskReceiptPayload({ ...receipt, token: "must-not-cross" }),
    TaskTransportContractError
  );
  assert.throws(
    () => validateTaskReceiptPayload({ ...receipt, supportedTaskVersions: [5, 5] }),
    /versions/
  );
});

test("Beta 0.4.0 Task negotiation requires an explicit v7 advertisement and never downgrades", () => {
  assert.equal(selectTaskProtocolVersion(), null);
  assert.equal(selectTaskProtocolVersion([2, 1]), null);
  assert.equal(selectTaskProtocolVersion([2]), null);
  assert.equal(selectTaskProtocolVersion([3]), null);
  assert.equal(selectTaskProtocolVersion([4]), null);
  assert.equal(selectTaskProtocolVersion([5]), null);
  assert.equal(selectTaskProtocolVersion([6]), null);
  assert.equal(selectTaskProtocolVersion([7]), 7);
  assert.doesNotThrow(() => validateTaskProtocolVersions([1, 2, 3, 4, 5, 6, 7]));
});

test("Task v6 attachment receipts are explicit, strict, and bound to one attachment", () => {
  const part = {
    kind: "image" as const,
    attachmentId: "image-001",
    mimeType: "image/png" as const,
    byteLength: 1024,
    width: 640,
    height: 480,
    sha256: `sha256:${"a".repeat(64)}`
  };
  const attachment = {
    schemaVersion: 1,
    taskId: "task-001",
    requesterTetiId: "teti_sender001",
    targetTetiId: "teti_target001",
    purpose: "input",
    part,
    createdAt: "2026-07-26T00:00:00.000Z",
    expiresAt: "2026-07-26T02:00:00.000Z",
    deliveryReceiptRequested: true
  };
  assert.doesNotThrow(() => validateTaskAttachmentPayload(attachment));
  assert.throws(
    () => validateTaskAttachmentPayload({ ...attachment, deliveryReceiptRequested: false }),
    /receipt request/
  );

  const receipt = {
    schemaVersion: 1,
    taskId: attachment.taskId,
    requesterTetiId: attachment.requesterTetiId,
    targetTetiId: attachment.targetTetiId,
    purpose: "input",
    attachmentId: part.attachmentId,
    receivedAt
  };
  assert.doesNotThrow(() => validateTaskAttachmentReceiptPayload(receipt));
  assert.throws(
    () => validateTaskAttachmentReceiptPayload({ ...receipt, artifactId: "artifact-not-allowed" }),
    /cannot name an Artifact/
  );
  assert.throws(
    () => validateTaskAttachmentReceiptPayload({ ...receipt, localPath: "/private/result.png" }),
    /unsupported field/
  );
});

test("Task v7 Artifact file descriptor and durable receipt are digest-bound", () => {
  const descriptor = {
    schemaVersion: 1,
    taskId: "task-001",
    requesterTetiId: "teti_sender001",
    targetTetiId: "teti_target001",
    artifactId: "artifact-001",
    byteLength: 11_625,
    sha256: `sha256:${"c".repeat(64)}`,
    createdAt: "2026-07-26T01:00:00.000Z",
    expiresAt: "2026-07-26T02:00:00.000Z",
    deliveryReceiptRequested: true
  };
  assert.doesNotThrow(() => validateTaskArtifactFilePayload(descriptor));
  assert.throws(
    () => validateTaskArtifactFilePayload({ ...descriptor, byteLength: 65 * 1024 }),
    /integrity metadata/
  );
  assert.throws(
    () => validateTaskArtifactFilePayload({ ...descriptor, sha256: "sha256:truncated" }),
    /integrity metadata/
  );

  const receipt = {
    schemaVersion: 1,
    taskId: descriptor.taskId,
    requesterTetiId: descriptor.requesterTetiId,
    targetTetiId: descriptor.targetTetiId,
    artifactId: descriptor.artifactId,
    sha256: descriptor.sha256,
    receivedAt
  };
  assert.doesNotThrow(() => validateTaskArtifactReceiptPayload(receipt));
  assert.throws(
    () => validateTaskArtifactReceiptPayload({ ...receipt, byteLength: descriptor.byteLength }),
    /unsupported field/
  );
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
