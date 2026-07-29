import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PASSPORT_SHARING_POLICY } from "../passport/types.ts";
import {
  MAX_EXECUTION_GRANT_TTL_MS,
  MAX_TASK_INPUT_TEXT_BYTES,
  type CollaborationTaskRequest,
  type ExecutionGrant,
  type TaskArtifactV2,
  type TaskTextArtifact
} from "./types.ts";
import {
  TaskContractError,
  validateCollaborationTaskRequest,
  validateExecutionGrant,
  validateTaskArtifactV2,
  validateTaskTextArtifact
} from "./validation.ts";

const createdAt = "2026-07-26T00:00:00.000Z";

test("Task request accepts only explicit text addressed to a different confirmed identity", () => {
  const request = taskRequest();
  assert.doesNotThrow(() => validateCollaborationTaskRequest(request));
});

test("Task request cannot select a receiver path, command, Adapter, or local Agent", () => {
  for (const [field, value] of [
    ["cwd", "/Users/bob/private"],
    ["command", "rm -rf"],
    ["adapterId", "openai.codex.exec"],
    ["agentId", "codex"],
    ["token", "secret"]
  ] as const) {
    assert.throws(
      () => validateCollaborationTaskRequest({ ...taskRequest(), [field]: value }),
      TaskContractError
    );
  }
});

test("Task request rejects self-targeting, uppercase IDs, excessive TTL, and oversized text", () => {
  assert.throws(() => validateCollaborationTaskRequest({
    ...taskRequest(),
    targetTetiId: "teti_sender001"
  }), /different Tetis/);
  assert.throws(() => validateCollaborationTaskRequest({
    ...taskRequest(),
    requesterTetiId: "teti_SENDER001"
  }), /canonical lowercase/);
  assert.throws(() => validateCollaborationTaskRequest({
    ...taskRequest(),
    expiresAt: "2026-07-28T00:00:01.000Z"
  }), /expiry/);
  assert.throws(() => validateCollaborationTaskRequest({
    ...taskRequest(),
    input: { kind: "text", text: "x".repeat(MAX_TASK_INPUT_TEXT_BYTES + 1) }
  }), /allowed size/);
});

test("Task v1 artifact is text-only and rejects unsupported transport fields", () => {
  const artifact: TaskTextArtifact = {
    schemaVersion: 1,
    taskId: "task-001",
    artifactId: "artifact-001",
    kind: "text",
    text: "Analysis completed.",
    createdAt
  };
  assert.doesNotThrow(() => validateTaskTextArtifact(artifact));
  assert.throws(
    () => validateTaskTextArtifact({ ...artifact, filePath: "/tmp/result" }),
    /unsupported field/
  );
});

test("Task v2 accepts one leading instruction and bounded PNG/JPEG descriptors", () => {
  const request: CollaborationTaskRequest = {
    ...taskRequest(),
    schemaVersion: 2,
    input: {
      kind: "parts",
      parts: [{ kind: "text", text: "Inspect this screenshot." }, imagePart()]
    }
  };
  assert.doesNotThrow(() => validateCollaborationTaskRequest(request));
  assert.throws(() => validateCollaborationTaskRequest({
    ...request,
    input: { kind: "parts", parts: [imagePart(), { kind: "text", text: "late" }] }
  }), /text must be the first/);
  assert.throws(() => validateCollaborationTaskRequest({
    ...request,
    input: { kind: "parts", parts: [{ kind: "text", text: "x" }, { ...imagePart(), sha256: "bad" }] }
  }), /digest/);
});

test("Task v5 carries only an abstract Workspace request and rejects every remote path field", () => {
  const request: CollaborationTaskRequest = {
    ...taskRequest(),
    schemaVersion: 5,
    input: { kind: "parts", parts: [{ kind: "text", text: "Use a controlled Workspace." }] },
    workspace: { kind: "temporary", access: ["read", "write", "create_artifact"] }
  };
  assert.doesNotThrow(() => validateCollaborationTaskRequest(request));
  assert.throws(() => validateCollaborationTaskRequest({
    ...request,
    workspace: {
      kind: "reference",
      workspaceId: "workspace-001",
      workspaceRevision: 1,
      access: ["read"],
      path: "/Users/receiver/private"
    }
  }), /unsupported field/);
  assert.throws(() => validateCollaborationTaskRequest({
    ...request,
    workspace: {
      kind: "temporary",
      access: ["read"],
      remotePath: "../../escape"
    }
  }), /unsupported field/);
});

test("Task v2 Artifact supports bounded text and image parts without local paths", () => {
  const artifact: TaskArtifactV2 = {
    schemaVersion: 2,
    taskId: "task-001",
    artifactId: "artifact-002",
    parts: [{ kind: "text", text: "Annotated result." }, imagePart()],
    createdAt
  };
  assert.doesNotThrow(() => validateTaskArtifactV2(artifact));
  assert.throws(
    () => validateTaskArtifactV2({ ...artifact, filePath: "/private/result.png" }),
    /unsupported field/
  );
});

test("Execution Grant is short-lived, single-use, input-bound, and local-scope only", () => {
  const grant = executionGrant();
  assert.doesNotThrow(() => validateExecutionGrant(grant));
  assert.throws(() => validateExecutionGrant({ ...grant, singleUse: false }), /scope/);
  assert.throws(() => validateExecutionGrant({ ...grant, userFileAccess: "read" }), /scope/);
  assert.throws(() => validateExecutionGrant({ ...grant, inputDigest: "sha256:bad" }), /inputDigest/);
  assert.throws(() => validateExecutionGrant({
    ...grant,
    expiresAt: new Date(Date.parse(createdAt) + MAX_EXECUTION_GRANT_TTL_MS + 1).toISOString()
  }), /expiry/);
});

test("Passport sharing consent is never accepted as an Execution Grant", () => {
  assert.throws(
    () => validateExecutionGrant(DEFAULT_PASSPORT_SHARING_POLICY),
    TaskContractError
  );
});

function taskRequest(): CollaborationTaskRequest {
  return {
    schemaVersion: 1,
    taskId: "task-001",
    requesterTetiId: "teti_sender001",
    targetTetiId: "teti_target001",
    offerId: "offer-001",
    capabilityId: "code-analysis",
    input: {
      kind: "text",
      text: "Review this explicitly pasted code snippet."
    },
    createdAt,
    expiresAt: "2026-07-26T01:00:00.000Z"
  };
}

function executionGrant(): ExecutionGrant {
  return {
    schemaVersion: 2,
    grantId: "grant-001",
    taskId: "task-001",
    requesterTetiId: "teti_sender001",
    capabilityId: "code-analysis",
    agentId: "codex",
    adapterId: "openai.codex.exec",
    inputDigest: `sha256:${"a".repeat(64)}`,
    issuedAt: createdAt,
    expiresAt: "2026-07-26T00:05:00.000Z",
    singleUse: true,
    workspaceId: "workspace:task-001",
    workspaceRevision: 1,
    workspaceAccess: ["read", "write", "create_artifact"],
    userFileAccess: "none",
    commandPolicy: "fixed_adapter_entrypoint",
    networkPolicy: "agent_managed"
  };
}

function imagePart() {
  return {
    kind: "image" as const,
    attachmentId: "image-001",
    mimeType: "image/png" as const,
    byteLength: 1_024,
    width: 640,
    height: 480,
    sha256: `sha256:${"a".repeat(64)}`
  };
}
