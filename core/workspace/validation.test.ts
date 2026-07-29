import assert from "node:assert/strict";
import test from "node:test";
import {
  validateTaskWorkspaceRequest,
  validateWorkspaceRelativePath
} from "./validation.ts";

test("Task Workspace requests expose only temporary or confirmed ID references", () => {
  assert.doesNotThrow(() => validateTaskWorkspaceRequest({
    kind: "temporary",
    access: ["read", "write", "create_artifact"]
  }));
  assert.doesNotThrow(() => validateTaskWorkspaceRequest({
    kind: "reference",
    workspaceId: "ws_123",
    workspaceRevision: 3,
    access: ["read", "create_artifact"]
  }));

  for (const unsafe of [
    { kind: "temporary", access: ["read"], path: "/Users/alice/project" },
    { kind: "external_user_folder", access: ["read"] },
    { kind: "arbitrary_host_path", path: "/tmp/work" },
    { kind: "remote_path", path: "ssh://host/work" },
    { kind: "reference", workspaceId: "../escape", workspaceRevision: 1, access: ["read"] }
  ]) {
    assert.throws(() => validateTaskWorkspaceRequest(unsafe));
  }
});

test("Workspace manifest paths reject traversal, absolute paths, separators, and controls", () => {
  for (const safe of ["README.md", "src/index.ts", "资料/说明.txt"]) {
    assert.doesNotThrow(() => validateWorkspaceRelativePath(safe));
  }
  for (const unsafe of ["../secret", "src/../../secret", "/etc/passwd", "src\\escape", "a//b", "./a", "a/./b", "a\0b"]) {
    assert.throws(() => validateWorkspaceRelativePath(unsafe));
  }
});
