import type {
  ChildMemorySnapshot,
  DurableMemoryScope,
  MemoryExportResult
} from "../../../../core/memory/types.ts";
import { emptyChildMemorySnapshot } from "../../../../core/memory/types.ts";
import { validateChildMemorySnapshot } from "../../../../core/memory/validation.ts";
import type { LifecycleBridgeClient } from "../provisioning/bridge-lifecycle.ts";
import { readStableErrorCode } from "../errors/stable-error-code.ts";

export type MemoryUiErrorCode =
  | "read_failed"
  | "operation_failed"
  | "authorization_required"
  | "source_invalid"
  | "scope_invalid"
  | "store_full";

export interface MemoryControllerSnapshot {
  memory: ChildMemorySnapshot;
  busy: boolean;
  busyKey?: string;
  errorCode?: MemoryUiErrorCode;
  exportResult?: MemoryExportResult;
}

export interface ChildMemoryClient {
  get(): Promise<ChildMemorySnapshot>;
  setAuthorization(input: {
    scope: DurableMemoryScope;
    workspaceId: string | null;
    childAgentId: string;
    enabled: boolean;
  }): Promise<ChildMemorySnapshot>;
  saveTask(taskId: string, scope: DurableMemoryScope): Promise<ChildMemorySnapshot>;
  delete(memoryId: string): Promise<boolean>;
  export(): Promise<MemoryExportResult>;
}

export class MemoryController {
  private readonly client: ChildMemoryClient;
  private readonly onChange: () => void;
  private snapshotValue: MemoryControllerSnapshot = {
    memory: emptyChildMemorySnapshot(),
    busy: false
  };
  private disposed = false;

  constructor(options: { client: ChildMemoryClient; onChange: () => void }) {
    this.client = options.client;
    this.onChange = options.onChange;
  }

  get snapshot(): MemoryControllerSnapshot {
    return structuredClone(this.snapshotValue);
  }

  async start(): Promise<void> {
    try {
      const memory = await this.client.get();
      validateChildMemorySnapshot(memory);
      if (this.disposed) return;
      this.snapshotValue.memory = memory;
    } catch {
      if (!this.disposed) this.snapshotValue.errorCode = "read_failed";
    }
  }

  dispose(): void {
    this.disposed = true;
  }

  isAuthorized(
    scope: DurableMemoryScope,
    workspaceId: string | null,
    childAgentId: string
  ): boolean {
    return this.snapshotValue.memory.authorizations.some((authorization) =>
      authorization.scope === scope
      && authorization.workspaceId === workspaceId
      && authorization.childAgentId === childAgentId
    );
  }

  hasTaskMemory(taskId: string, scope: DurableMemoryScope): boolean {
    return this.snapshotValue.memory.records.some((record) =>
      record.sourceTaskId === taskId && record.scope === scope
    );
  }

  setAuthorization(input: {
    scope: DurableMemoryScope;
    workspaceId: string | null;
    childAgentId: string;
    enabled: boolean;
  }): Promise<void> {
    return this.run(`authorization:${input.scope}:${input.workspaceId ?? "-"}:${input.childAgentId}`, async () => {
      const memory = await this.client.setAuthorization(input);
      validateChildMemorySnapshot(memory);
      this.snapshotValue.memory = memory;
    });
  }

  saveTask(taskId: string, scope: DurableMemoryScope): Promise<void> {
    return this.run(`save:${scope}:${taskId}`, async () => {
      const memory = await this.client.saveTask(taskId, scope);
      validateChildMemorySnapshot(memory);
      this.snapshotValue.memory = memory;
    });
  }

  delete(memoryId: string): Promise<void> {
    return this.run(`delete:${memoryId}`, async () => {
      await this.client.delete(memoryId);
      const memory = await this.client.get();
      validateChildMemorySnapshot(memory);
      this.snapshotValue.memory = memory;
    });
  }

  export(): Promise<void> {
    return this.run("export", async () => {
      this.snapshotValue.exportResult = await this.client.export();
    });
  }

  private async run(key: string, operation: () => Promise<void>): Promise<void> {
    if (this.snapshotValue.busy || this.disposed) return;
    this.snapshotValue.busy = true;
    this.snapshotValue.busyKey = key;
    this.snapshotValue.errorCode = undefined;
    this.snapshotValue.exportResult = undefined;
    this.onChange();
    try {
      await operation();
    } catch (error) {
      this.snapshotValue.errorCode = memoryErrorCode(error);
    } finally {
      this.snapshotValue.busy = false;
      this.snapshotValue.busyKey = undefined;
      if (!this.disposed) this.onChange();
    }
  }
}

export class BridgeChildMemoryClient implements ChildMemoryClient {
  private readonly bridge: LifecycleBridgeClient;

  constructor(bridge: LifecycleBridgeClient) {
    this.bridge = bridge;
  }

  get(): Promise<ChildMemorySnapshot> {
    return this.bridge.request("memory.get") as Promise<ChildMemorySnapshot>;
  }

  setAuthorization(input: {
    scope: DurableMemoryScope;
    workspaceId: string | null;
    childAgentId: string;
    enabled: boolean;
  }): Promise<ChildMemorySnapshot> {
    return this.bridge.request(
      "memory.authorization.set",
      input as unknown as Record<string, unknown>
    ) as Promise<ChildMemorySnapshot>;
  }

  saveTask(taskId: string, scope: DurableMemoryScope): Promise<ChildMemorySnapshot> {
    return this.bridge.request("memory.task.save", {
      taskId,
      scope,
      confirmed: true
    }) as Promise<ChildMemorySnapshot>;
  }

  delete(memoryId: string): Promise<boolean> {
    return this.bridge.request("memory.delete", { memoryId }) as Promise<boolean>;
  }

  export(): Promise<MemoryExportResult> {
    return this.bridge.request("memory.export") as Promise<MemoryExportResult>;
  }
}

export class MockChildMemoryClient implements ChildMemoryClient {
  private memory = emptyChildMemorySnapshot(new Date());

  async get(): Promise<ChildMemorySnapshot> {
    return structuredClone(this.memory);
  }

  async setAuthorization(input: {
    scope: DurableMemoryScope;
    workspaceId: string | null;
    childAgentId: string;
    enabled: boolean;
  }): Promise<ChildMemorySnapshot> {
    this.memory.authorizations = this.memory.authorizations.filter((authorization) =>
      authorization.scope !== input.scope
      || authorization.workspaceId !== input.workspaceId
      || authorization.childAgentId !== input.childAgentId
    );
    if (input.enabled) {
      this.memory.authorizations.push({
        schemaVersion: 1,
        scope: input.scope,
        workspaceId: input.workspaceId,
        childAgentId: input.childAgentId,
        authorizedAt: new Date().toISOString()
      });
    }
    this.memory.generatedAt = new Date().toISOString();
    return this.get();
  }

  async saveTask(): Promise<ChildMemorySnapshot> {
    const error = new Error("MEMORY_SOURCE_INVALID");
    error.name = "MEMORY_SOURCE_INVALID";
    throw error;
  }

  async delete(memoryId: string): Promise<boolean> {
    const count = this.memory.records.length;
    this.memory.records = this.memory.records.filter((record) => record.memoryId !== memoryId);
    return this.memory.records.length !== count;
  }

  async export(): Promise<MemoryExportResult> {
    return {
      schemaVersion: 1,
      fileName: "teti-child-memory-mock.json",
      path: "mock://memory-export-not-written",
      recordCount: this.memory.records.length,
      createdAt: new Date().toISOString()
    };
  }
}

function memoryErrorCode(error: unknown): MemoryUiErrorCode {
  switch (readStableErrorCode(error)) {
    case "MEMORY_AUTHORIZATION_REQUIRED":
      return "authorization_required";
    case "MEMORY_SOURCE_INVALID":
      return "source_invalid";
    case "MEMORY_SCOPE_INVALID":
      return "scope_invalid";
    case "MEMORY_STORE_FULL":
      return "store_full";
    case "MEMORY_OPERATION_FAILED":
    default:
      return "operation_failed";
  }
}
