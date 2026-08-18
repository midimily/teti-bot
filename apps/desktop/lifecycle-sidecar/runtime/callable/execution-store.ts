import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import {
  TETI_EXECUTION_HANDLE_SCHEMA_VERSION,
  TETI_EXECUTION_LEASE_MS,
  isTerminalExecutionProgress,
  validateExecutionHandle,
  type ConnectorExecutionCapabilities,
  type ExecutionHandle,
  type ExecutionHandleRegistry,
  type ExecutionProgressState,
  type ExecutionSemantics,
  type PrepareExecutionHandleInput
} from "../../../../../core/callability/execution.ts";

const EXECUTION_STORE_SCHEMA_VERSION = 2;
const MAX_EXECUTION_HANDLES = 512;

interface CheckpointIntegrityRecord {
  taskId: string;
  capturedExecutionEpoch: number;
  checkpointRef: string;
  sha256: string;
}

interface ExecutionHandleStoreState {
  schemaVersion: 2;
  handles: ExecutionHandle[];
  checkpointIntegrity: CheckpointIntegrityRecord[];
}

export interface ExecutionHandleStore {
  load(): Promise<ExecutionHandleStoreState>;
  save(state: ExecutionHandleStoreState): Promise<void>;
}

export class FileExecutionHandleStore implements ExecutionHandleStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<ExecutionHandleStoreState> {
    try {
      const value = migrateExecutionHandleStoreState(
        JSON.parse(await readFile(this.path, "utf8")) as unknown
      );
      validateExecutionHandleStoreState(value);
      return structuredClone(value);
    } catch (error) {
      if (isNotFound(error)) return emptyExecutionHandleStoreState();
      throw error;
    }
  }

  async save(state: ExecutionHandleStoreState): Promise<void> {
    validateExecutionHandleStoreState(state);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.path}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(temporaryPath, this.path);
    await chmod(this.path, 0o600);
  }
}

export class MemoryExecutionHandleStore implements ExecutionHandleStore {
  private state: ExecutionHandleStoreState;

  constructor(state: ExecutionHandleStoreState = emptyExecutionHandleStoreState()) {
    const migrated = migrateExecutionHandleStoreState(state);
    validateExecutionHandleStoreState(migrated);
    this.state = structuredClone(migrated);
  }

  async load(): Promise<ExecutionHandleStoreState> {
    return structuredClone(this.state);
  }

  async save(state: ExecutionHandleStoreState): Promise<void> {
    validateExecutionHandleStoreState(state);
    this.state = structuredClone(state);
  }
}

export class DurableExecutionRegistry implements ExecutionHandleRegistry {
  private readonly store: ExecutionHandleStore;
  private readonly checkpointRoot: string;
  private readonly now: () => Date;
  private readonly leaseMs: number;
  private operation = Promise.resolve();

  constructor(options: {
    store: ExecutionHandleStore;
    checkpointRoot: string;
    now?: () => Date;
    leaseMs?: number;
  }) {
    this.store = options.store;
    this.checkpointRoot = resolve(options.checkpointRoot);
    this.now = options.now ?? (() => new Date());
    this.leaseMs = options.leaseMs ?? TETI_EXECUTION_LEASE_MS;
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 1_000 || this.leaseMs > 5 * 60_000) {
      throw new Error("Execution lease duration is invalid.");
    }
  }

  async prepare(
    input: PrepareExecutionHandleInput,
    capabilities: ConnectorExecutionCapabilities,
    semantics: ExecutionSemantics
  ): Promise<ExecutionHandle> {
    const outcome = await this.mutate(async (state): Promise<
      { handle: ExecutionHandle; error?: never } | { handle?: never; error: string }
    > => {
      const previous = state.handles.find((item) => item.taskId === input.taskId);
      if (input.resume) {
        if (!previous
          || previous.resumeCapability !== "checkpoint_restart"
          || previous.checkpointRef === null
          || !["interrupted", "failed"].includes(previous.progress.state)
          || !capabilities.supportsResume
          || !capabilities.supportsCheckpoint
          || semantics !== "workspace_pure_compute") {
          throw new Error("EXECUTION_RESUME_UNAVAILABLE");
        }
        if (!(await this.isCheckpointIntact(state, previous))) {
          const now = this.now().toISOString();
          previous.checkpointRef = null;
          previous.resumeCapability = "none";
          previous.progress = {
            ...previous.progress,
            message: "检查点完整性验证失败，已禁止恢复",
            updatedAt: now
          };
          state.checkpointIntegrity = state.checkpointIntegrity.filter(
            (record) => record.taskId !== previous.taskId
          );
          return { error: "EXECUTION_CHECKPOINT_INTEGRITY_FAILED" };
        }
      } else if (previous) {
        throw new Error("EXECUTION_HANDLE_EXISTS");
      }
      const now = this.now();
      const handle: ExecutionHandle = {
        schemaVersion: TETI_EXECUTION_HANDLE_SCHEMA_VERSION,
        taskId: input.taskId,
        workspaceId: input.workspaceId,
        childAgentId: input.childAgentId,
        connectorId: input.connectorId,
        executionEpoch: (previous?.executionEpoch ?? 0) + 1,
        providerExecutionId: null,
        leaseExpiresAt: this.leaseExpiry(now),
        progress: {
          state: "queued",
          completedUnits: null,
          totalUnits: null,
          message: input.resume ? "正在从显式检查点重新开始" : "等待本机 Child Agent",
          updatedAt: now.toISOString()
        },
        checkpointRef: previous?.checkpointRef ?? null,
        resumeCapability: previous?.resumeCapability ?? "none"
      };
      validateExecutionHandle(handle);
      if (previous) state.handles.splice(state.handles.indexOf(previous), 1, handle);
      else state.handles.push(handle);
      pruneHandles(state);
      return { handle: structuredClone(handle) };
    });
    if ("error" in outcome) throw new Error(outcome.error);
    return outcome.handle;
  }

  get(taskId: string): Promise<ExecutionHandle | null> {
    return this.read(async (state) => structuredClone(
      state.handles.find((item) => item.taskId === taskId) ?? null
    ));
  }

  list(): Promise<ExecutionHandle[]> {
    return this.read(async (state) => structuredClone(state.handles));
  }

  markRunning(
    taskId: string,
    executionEpoch: number,
    providerExecutionId: string | null
  ): Promise<boolean> {
    return this.transition(taskId, executionEpoch, "running", {
      providerExecutionId,
      message: "本机 Child Agent 正在执行"
    });
  }

  renew(taskId: string, executionEpoch: number): Promise<boolean> {
    return this.mutate(async (state) => {
      const handle = currentHandle(state, taskId, executionEpoch);
      if (!handle || isTerminalExecutionProgress(handle.progress.state)) return false;
      handle.leaseExpiresAt = this.leaseExpiry(this.now());
      return true;
    });
  }

  async captureCheckpoint(input: {
    taskId: string;
    executionEpoch: number;
    sourcePath: string;
    workspacePath: string;
    resumeEligible: boolean;
  }): Promise<boolean> {
    if (!input.resumeEligible) return false;
    const workspaceRoot = await realpath(input.workspacePath);
    const source = await realpath(input.sourcePath);
    if (!isContained(workspaceRoot, source)) throw new Error("EXECUTION_CHECKPOINT_ESCAPE");
    const extension = safeCheckpointExtension(extname(basename(source)));
    const directory = join(
      this.checkpointRoot,
      safePathSegment(input.taskId),
      String(input.executionEpoch)
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const destination = join(directory, `checkpoint${extension}`);
    const temporary = join(directory, `.checkpoint-${randomUUID()}.tmp`);
    let checkpointDigest: string;
    try {
      await copyFile(source, temporary);
      await chmod(temporary, 0o600);
      checkpointDigest = await sha256File(temporary);
      await rename(temporary, destination);
      await chmod(destination, 0o600);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    return this.mutate(async (state) => {
      const handle = currentHandle(state, input.taskId, input.executionEpoch);
      if (!handle || isTerminalExecutionProgress(handle.progress.state)) return false;
      handle.checkpointRef = destination;
      handle.resumeCapability = "checkpoint_restart";
      state.checkpointIntegrity = state.checkpointIntegrity.filter(
        (record) => record.taskId !== input.taskId
      );
      state.checkpointIntegrity.push({
        taskId: input.taskId,
        capturedExecutionEpoch: input.executionEpoch,
        checkpointRef: destination,
        sha256: checkpointDigest
      });
      return true;
    });
  }

  finish(
    taskId: string,
    executionEpoch: number,
    state: "completed" | "failed" | "canceled",
    message?: string
  ): Promise<boolean> {
    return this.transition(taskId, executionEpoch, state, {
      message: message ?? terminalMessage(state),
      terminalOnlyOnce: true
    });
  }

  cancel(taskId: string, executionEpoch?: number): Promise<boolean> {
    return this.mutate(async (state) => {
      const handle = state.handles.find((item) => item.taskId === taskId);
      if (!handle
        || (executionEpoch !== undefined && handle.executionEpoch !== executionEpoch)
        || isTerminalExecutionProgress(handle.progress.state)) return false;
      const now = this.now();
      handle.progress = {
        state: "canceled",
        completedUnits: handle.progress.completedUnits,
        totalUnits: handle.progress.totalUnits,
        message: "执行已取消",
        updatedAt: now.toISOString()
      };
      handle.leaseExpiresAt = now.toISOString();
      return true;
    });
  }

  isCurrent(taskId: string, executionEpoch: number): Promise<boolean> {
    return this.read(async (state) => {
      const handle = currentHandle(state, taskId, executionEpoch);
      return Boolean(handle && !isTerminalExecutionProgress(handle.progress.state));
    });
  }

  reconcile(activeTaskIds: readonly string[]): Promise<ExecutionHandle[]> {
    const active = new Set(activeTaskIds);
    return this.mutate(async (state) => {
      const now = this.now();
      const interrupted: ExecutionHandle[] = [];
      for (const handle of state.handles) {
        if (isTerminalExecutionProgress(handle.progress.state) || active.has(handle.taskId)) continue;
        handle.progress = {
          state: "interrupted",
          completedUnits: handle.progress.completedUnits,
          totalUnits: handle.progress.totalUnits,
          message: handle.resumeCapability === "checkpoint_restart"
            ? "执行已中断，可从显式检查点重新开始"
            : "执行已中断，当前 Child Agent 不支持恢复",
          updatedAt: now.toISOString()
        };
        handle.providerExecutionId = null;
        handle.leaseExpiresAt = now.toISOString();
        interrupted.push(structuredClone(handle));
      }
      return interrupted;
    });
  }

  private transition(
    taskId: string,
    executionEpoch: number,
    next: ExecutionProgressState,
    options: {
      providerExecutionId?: string | null;
      message: string;
      terminalOnlyOnce?: boolean;
    }
  ): Promise<boolean> {
    return this.mutate(async (state) => {
      const handle = currentHandle(state, taskId, executionEpoch);
      if (!handle || (options.terminalOnlyOnce && isTerminalExecutionProgress(handle.progress.state))) {
        return false;
      }
      if (isTerminalExecutionProgress(handle.progress.state)) return false;
      const now = this.now();
      if (options.providerExecutionId !== undefined) {
        handle.providerExecutionId = options.providerExecutionId;
      }
      handle.progress = {
        state: next,
        completedUnits: next === "completed" ? 1 : handle.progress.completedUnits,
        totalUnits: next === "completed" ? 1 : handle.progress.totalUnits,
        message: options.message,
        updatedAt: now.toISOString()
      };
      handle.leaseExpiresAt = isTerminalExecutionProgress(next)
        ? now.toISOString()
        : this.leaseExpiry(now);
      return true;
    });
  }

  private leaseExpiry(now: Date): string {
    return new Date(now.getTime() + this.leaseMs).toISOString();
  }

  private async isCheckpointIntact(
    state: ExecutionHandleStoreState,
    handle: ExecutionHandle
  ): Promise<boolean> {
    const record = state.checkpointIntegrity.find((candidate) =>
      candidate.taskId === handle.taskId
      && candidate.checkpointRef === handle.checkpointRef
    );
    if (!record || !handle.checkpointRef) return false;
    try {
      const checkpointRoot = await realpath(this.checkpointRoot);
      const checkpoint = await realpath(handle.checkpointRef);
      return isContained(checkpointRoot, checkpoint)
        && await sha256File(checkpoint) === record.sha256;
    } catch {
      return false;
    }
  }

  private read<T>(operation: (state: ExecutionHandleStoreState) => Promise<T>): Promise<T> {
    return this.serialize(async () => operation(await this.store.load()));
  }

  private mutate<T>(operation: (state: ExecutionHandleStoreState) => Promise<T>): Promise<T> {
    return this.serialize(async () => {
      const state = await this.store.load();
      const result = await operation(state);
      await this.store.save(state);
      return result;
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operation.then(operation, operation);
    this.operation = next.then(() => undefined, () => undefined);
    return next;
  }
}

function emptyExecutionHandleStoreState(): ExecutionHandleStoreState {
  return {
    schemaVersion: EXECUTION_STORE_SCHEMA_VERSION,
    handles: [],
    checkpointIntegrity: []
  };
}

function migrateExecutionHandleStoreState(value: unknown): unknown {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || Object.keys(value).sort().join(",") !== "handles,schemaVersion") {
    return value;
  }
  return {
    schemaVersion: EXECUTION_STORE_SCHEMA_VERSION,
    handles: value.handles,
    checkpointIntegrity: []
  };
}

function validateExecutionHandleStoreState(
  value: unknown
): asserts value is ExecutionHandleStoreState {
  if (!isRecord(value)
    || value.schemaVersion !== EXECUTION_STORE_SCHEMA_VERSION
    || Object.keys(value).sort().join(",") !== "checkpointIntegrity,handles,schemaVersion"
    || !Array.isArray(value.handles)
    || value.handles.length > MAX_EXECUTION_HANDLES
    || !Array.isArray(value.checkpointIntegrity)
    || value.checkpointIntegrity.length > MAX_EXECUTION_HANDLES) {
    throw new Error("Execution Handle store is invalid.");
  }
  const taskIds = new Set<string>();
  for (const handle of value.handles) {
    validateExecutionHandle(handle);
    if (taskIds.has(handle.taskId)) throw new Error("Execution Handle task ID is duplicated.");
    taskIds.add(handle.taskId);
  }
  const integrityTaskIds = new Set<string>();
  for (const record of value.checkpointIntegrity) {
    if (!isRecord(record)
      || Object.keys(record).sort().join(",")
        !== "capturedExecutionEpoch,checkpointRef,sha256,taskId"
      || typeof record.taskId !== "string"
      || !Number.isSafeInteger(record.capturedExecutionEpoch)
      || Number(record.capturedExecutionEpoch) < 1
      || typeof record.checkpointRef !== "string"
      || !/^sha256:[a-f0-9]{64}$/.test(String(record.sha256))
      || integrityTaskIds.has(record.taskId)) {
      throw new Error("Execution checkpoint integrity state is invalid.");
    }
    const handle = value.handles.find((candidate) => candidate.taskId === record.taskId);
    if (!handle
      || handle.checkpointRef !== record.checkpointRef
      || handle.resumeCapability !== "checkpoint_restart") {
      throw new Error("Execution checkpoint integrity state is orphaned.");
    }
    integrityTaskIds.add(record.taskId);
  }
}

function currentHandle(
  state: ExecutionHandleStoreState,
  taskId: string,
  executionEpoch: number
): ExecutionHandle | undefined {
  return state.handles.find((item) =>
    item.taskId === taskId && item.executionEpoch === executionEpoch
  );
}

function pruneHandles(state: ExecutionHandleStoreState): void {
  if (state.handles.length <= MAX_EXECUTION_HANDLES) return;
  const terminal = state.handles
    .filter((handle) => isTerminalExecutionProgress(handle.progress.state))
    .sort((left, right) => Date.parse(left.progress.updatedAt) - Date.parse(right.progress.updatedAt));
  for (const handle of terminal) {
    if (state.handles.length <= MAX_EXECUTION_HANDLES) break;
    state.handles.splice(state.handles.indexOf(handle), 1);
  }
  if (state.handles.length > MAX_EXECUTION_HANDLES) {
    throw new Error("Execution Handle store capacity is exhausted.");
  }
  state.checkpointIntegrity = state.checkpointIntegrity.filter((record) =>
    state.handles.some((handle) =>
      handle.taskId === record.taskId
      && handle.checkpointRef === record.checkpointRef
      && handle.resumeCapability === "checkpoint_restart"
    )
  );
}

async function sha256File(path: string): Promise<string> {
  return `sha256:${createHash("sha256").update(await readFile(path)).digest("hex")}`;
}

function isContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return !isAbsolute(path)
    && path !== ".."
    && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function safeCheckpointExtension(value: string): string {
  return /^\.[A-Za-z0-9]{1,10}$/.test(value) ? value.toLowerCase() : ".bin";
}

function terminalMessage(state: "completed" | "failed" | "canceled"): string {
  if (state === "completed") return "执行已完成";
  if (state === "canceled") return "执行已取消";
  return "执行失败";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT";
}
