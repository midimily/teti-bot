import assert from "node:assert/strict";
import test from "node:test";
import { emptyChildMemorySnapshot, type DurableMemoryScope } from "../../../core/memory/types.ts";
import {
  MemoryController,
  type ChildMemoryClient
} from "../src/memory/controller.ts";

test("Memory controller stores semantic codes and never raw backend messages", async () => {
  const client = new FailingMemoryClient();
  const controller = new MemoryController({ client, onChange: () => undefined });

  client.failure = new Error("private path /Users/example token=secret");
  await controller.saveTask("task-1", "child_agent");
  assert.equal(controller.snapshot.errorCode, "operation_failed");
  assert.equal(JSON.stringify(controller.snapshot).includes("/Users/example"), false);

  client.failure = Object.assign(new Error("ignored"), { name: "MEMORY_AUTHORIZATION_REQUIRED" });
  await controller.saveTask("task-1", "child_agent");
  assert.equal(controller.snapshot.errorCode, "authorization_required");
});

test("Memory initial read has its own stable failure code", async () => {
  const client = new FailingMemoryClient();
  client.failure = new Error("database details must remain diagnostic-only");
  const controller = new MemoryController({ client, onChange: () => undefined });

  await controller.start();

  assert.equal(controller.snapshot.errorCode, "read_failed");
});

class FailingMemoryClient implements ChildMemoryClient {
  failure: unknown;

  async get() {
    if (this.failure) throw this.failure;
    return emptyChildMemorySnapshot();
  }

  async setAuthorization(_input: {
    scope: DurableMemoryScope;
    workspaceId: string | null;
    childAgentId: string;
    enabled: boolean;
  }) {
    if (this.failure) throw this.failure;
    return emptyChildMemorySnapshot();
  }

  async saveTask() {
    if (this.failure) throw this.failure;
    return emptyChildMemorySnapshot();
  }

  async delete() {
    if (this.failure) throw this.failure;
    return false;
  }

  async export() {
    if (this.failure) throw this.failure;
    return {
      schemaVersion: 1 as const,
      fileName: "memory.json",
      path: "/safe/memory.json",
      recordCount: 0,
      createdAt: new Date(0).toISOString()
    };
  }
}
