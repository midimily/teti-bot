import assert from "node:assert/strict";
import test from "node:test";
import {
  CallableAdapterContractError,
  validateCallableAdapterDescriptor,
  validateCallableAdapterArtifactText,
  validateCallableAdapterLaunchSpec,
  validateCallableAdapterTaskRequest,
  type CallableAdapterDescriptor,
  type CallableAdapterTaskRequest
} from "./adapter.ts";
import { CallableTaskStateMachine, CallableTaskStateError } from "./task-machine.ts";

test("Callable Adapter contract freezes a bounded text-only local surface", () => {
  assert.doesNotThrow(() => validateCallableAdapterDescriptor(descriptor()));
  assert.throws(
    () => validateCallableAdapterDescriptor({ ...descriptor(), capabilityIds: [] }),
    CallableAdapterContractError
  );
  assert.throws(
    () => validateCallableAdapterDescriptor({ ...descriptor(), timeoutMs: 0 }),
    CallableAdapterContractError
  );
  assert.throws(
    () => validateCallableAdapterDescriptor({ ...descriptor(), maxOutputBytes: 10 }),
    CallableAdapterContractError
  );
});

test("local tasks cannot select another Agent, Adapter, or unsupported Capability", () => {
  assert.doesNotThrow(() => validateCallableAdapterTaskRequest(request(), descriptor()));
  assert.throws(
    () => validateCallableAdapterTaskRequest({ ...request(), adapterId: "remote.shell" }, descriptor()),
    /target/
  );
  assert.throws(
    () => validateCallableAdapterTaskRequest({ ...request(), agentId: "claude-code" }, descriptor()),
    /target/
  );
  assert.throws(
    () => validateCallableAdapterTaskRequest({ ...request(), capabilityId: "shell" }, descriptor()),
    /not supported/
  );
});

test("launch specs require an absolute fixed entrypoint and bounded argv/environment", () => {
  assert.doesNotThrow(() => validateCallableAdapterLaunchSpec({
    executable: "/usr/bin/true",
    args: ["--safe"],
    environment: { TETI_MODE: "test" }
  }));
  assert.throws(
    () => validateCallableAdapterLaunchSpec({ executable: "agent", args: [] }),
    /absolute local path/
  );
  assert.throws(
    () => validateCallableAdapterLaunchSpec(
      { executable: "/usr/bin/false", args: [] },
      "/usr/bin/true"
    ),
    /fixed entrypoint/
  );
  assert.throws(
    () => validateCallableAdapterLaunchSpec({
      executable: "/usr/bin/true",
      args: [],
      environment: { "BAD-NAME": "value" }
    }),
    /environment/
  );
});

test("controlled Artifacts are non-empty text within the frozen task limit", () => {
  assert.doesNotThrow(() => validateCallableAdapterArtifactText("safe result"));
  assert.throws(() => validateCallableAdapterArtifactText("   "), /contain text/);
  assert.throws(() => validateCallableAdapterArtifactText("x".repeat(56 * 1024 + 1)), /allowed size/);
});

test("task state machine permits only submitted -> working -> terminal", () => {
  let tick = 0;
  const machine = new CallableTaskStateMachine(request(), () => new Date(1_000 + tick++));
  assert.equal(machine.snapshot.state, "submitted");
  assert.equal(machine.start().state, "working");
  const completed = machine.complete("safe result");
  assert.equal(completed.state, "completed");
  assert.equal(completed.artifact?.text, "safe result");
  assert.throws(() => machine.fail("ADAPTER_INTERNAL_ERROR"), CallableTaskStateError);
});

test("failed and canceled tasks never retain a partial Artifact", () => {
  const failed = new CallableTaskStateMachine(request());
  failed.start();
  assert.deepEqual(failed.fail("ADAPTER_TIMEOUT").artifact, undefined);

  const canceled = new CallableTaskStateMachine({ ...request(), taskId: "task-canceled" });
  assert.equal(canceled.cancel("ADAPTER_CANCELED").state, "canceled");
  assert.equal(canceled.snapshot.artifact, undefined);
});

function descriptor(): CallableAdapterDescriptor {
  return {
    contractVersion: 1,
    adapterId: "test.fake-agent",
    adapterRevision: 1,
    agentId: "fake-agent",
    capabilityIds: ["code-analysis"],
    inputMode: "text",
    outputMode: "text",
    timeoutMs: 1_000,
    cancelGraceMs: 20,
    maxOutputBytes: 1_024
  };
}

function request(): CallableAdapterTaskRequest {
  return {
    schemaVersion: 1,
    taskId: "task-001",
    adapterId: "test.fake-agent",
    agentId: "fake-agent",
    capabilityId: "code-analysis",
    input: { kind: "text", text: "Review this pasted snippet." },
    createdAt: "2026-07-26T00:00:00.000Z"
  };
}
