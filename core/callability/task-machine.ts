import {
  TETI_CALLABLE_TASK_SCHEMA_VERSION,
  type CallableAdapterSafeErrorCode,
  type CallableAdapterTaskRequest,
  type CallableAdapterTaskSnapshot,
  type CallableAdapterTaskState
} from "./adapter.ts";

const TERMINAL_STATES = new Set<CallableAdapterTaskState>([
  "completed",
  "failed",
  "canceled"
]);

export class CallableTaskStateError extends Error {}

/**
 * Local execution state only. It reuses the frozen A2A-aligned Task vocabulary
 * and is never serialized to Chatmail by the 0.1.4 Kernel.
 */
export class CallableTaskStateMachine {
  private value: CallableAdapterTaskSnapshot;
  private readonly now: () => Date;

  constructor(request: CallableAdapterTaskRequest, now: () => Date = () => new Date()) {
    this.now = now;
    this.value = {
      schemaVersion: TETI_CALLABLE_TASK_SCHEMA_VERSION,
      taskId: request.taskId,
      adapterId: request.adapterId,
      agentId: request.agentId,
      capabilityId: request.capabilityId,
      state: "submitted",
      submittedAt: request.createdAt,
      updatedAt: request.createdAt
    };
  }

  get snapshot(): CallableAdapterTaskSnapshot {
    return structuredClone(this.value);
  }

  get isTerminal(): boolean {
    return TERMINAL_STATES.has(this.value.state);
  }

  start(): CallableAdapterTaskSnapshot {
    this.requireState("submitted");
    const timestamp = this.timestamp();
    this.value = {
      ...this.value,
      state: "working",
      startedAt: timestamp,
      updatedAt: timestamp
    };
    return this.snapshot;
  }

  complete(text: string): CallableAdapterTaskSnapshot {
    this.requireState("working");
    const timestamp = this.timestamp();
    this.value = {
      ...this.value,
      state: "completed",
      updatedAt: timestamp,
      completedAt: timestamp,
      artifact: { kind: "text", text }
    };
    return this.snapshot;
  }

  fail(code: CallableAdapterSafeErrorCode): CallableAdapterTaskSnapshot {
    this.requireNonTerminal();
    const timestamp = this.timestamp();
    this.value = {
      ...withoutArtifact(this.value),
      state: "failed",
      updatedAt: timestamp,
      completedAt: timestamp,
      safeErrorCode: code
    };
    return this.snapshot;
  }

  cancel(code: "ADAPTER_CANCELED" | "ADAPTER_RUNTIME_SHUTDOWN"): CallableAdapterTaskSnapshot {
    this.requireNonTerminal();
    const timestamp = this.timestamp();
    this.value = {
      ...withoutArtifact(this.value),
      state: "canceled",
      updatedAt: timestamp,
      completedAt: timestamp,
      safeErrorCode: code
    };
    return this.snapshot;
  }

  private requireState(expected: CallableAdapterTaskState): void {
    if (this.value.state !== expected) {
      throw new CallableTaskStateError(
        `Callable task cannot transition from ${this.value.state}; expected ${expected}.`
      );
    }
  }

  private requireNonTerminal(): void {
    if (this.isTerminal) {
      throw new CallableTaskStateError(`Callable task ${this.value.taskId} is already terminal.`);
    }
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

function withoutArtifact(
  value: CallableAdapterTaskSnapshot
): Omit<CallableAdapterTaskSnapshot, "artifact"> {
  const { artifact: _artifact, ...snapshot } = value;
  return snapshot;
}
