import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExecutionHandle } from "../../../../../core/callability/execution.ts";
import type { CollaborationTaskTransportRecord } from "../../../../../core/task/transport.ts";
import {
  CHILD_MEMORY_LIMITS,
  TETI_CHILD_MEMORY_SCHEMA_VERSION,
  type ChildMemoryProvider,
  type ChildMemorySnapshot,
  type DurableMemoryScope,
  type MemoryAuthorization,
  type MemoryContextSelection,
  type MemoryExportResult,
  type MemoryRecord,
  type MemoryRecordSummary,
  type SelectChildMemoryInput
} from "../../../../../core/memory/types.ts";
import {
  validateMemoryAuthorization,
  validateMemoryContextSelection,
  validateMemoryRecord
} from "../../../../../core/memory/validation.ts";

const MEMORY_STORE_SCHEMA_VERSION = 1;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const SAFE_CHILD_AGENT_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

interface ChildMemoryStoreState {
  schemaVersion: 1;
  records: MemoryRecord[];
  authorizations: MemoryAuthorization[];
}

export interface ChildMemoryStore {
  load(): Promise<ChildMemoryStoreState>;
  save(state: ChildMemoryStoreState): Promise<void>;
}

export class FileChildMemoryStore implements ChildMemoryStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<ChildMemoryStoreState> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      validateStoreState(value);
      return structuredClone(value);
    } catch (error) {
      if (isNotFound(error)) return emptyState();
      throw error;
    }
  }

  async save(state: ChildMemoryStoreState): Promise<void> {
    validateStoreState(state);
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

export class MemoryChildMemoryStore implements ChildMemoryStore {
  private state: ChildMemoryStoreState;

  constructor(initial = emptyState()) {
    validateStoreState(initial);
    this.state = structuredClone(initial);
  }

  async load(): Promise<ChildMemoryStoreState> {
    return structuredClone(this.state);
  }

  async save(state: ChildMemoryStoreState): Promise<void> {
    validateStoreState(state);
    this.state = structuredClone(state);
  }
}

export class ChildMemoryService implements ChildMemoryProvider {
  private operation = Promise.resolve();
  private readonly options: {
    store: ChildMemoryStore;
    exportRoot: string;
    now?: () => Date;
  };

  constructor(options: {
    store: ChildMemoryStore;
    exportRoot: string;
    now?: () => Date;
  }) {
    this.options = options;
  }

  list(): Promise<ChildMemorySnapshot> {
    return this.mutate((state, now) => ({
      schemaVersion: TETI_CHILD_MEMORY_SCHEMA_VERSION,
      generatedAt: now.toISOString(),
      records: state.records
        .map(toSummary)
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)),
      authorizations: structuredClone(state.authorizations)
        .sort((left, right) => authorizationKey(left).localeCompare(authorizationKey(right)))
    }));
  }

  setAuthorization(input: {
    scope: DurableMemoryScope;
    workspaceId: string | null;
    childAgentId: string;
    enabled: boolean;
  }): Promise<ChildMemorySnapshot> {
    return this.mutate((state, now) => {
      requireAuthorizationInput(input);
      const key = authorizationInputKey(input);
      state.authorizations = state.authorizations.filter(
        (authorization) => authorizationKey(authorization) !== key
      );
      if (input.enabled) {
        state.authorizations.push({
          schemaVersion: TETI_CHILD_MEMORY_SCHEMA_VERSION,
          scope: input.scope,
          workspaceId: input.scope === "workspace" ? input.workspaceId : null,
          childAgentId: input.childAgentId,
          authorizedAt: now.toISOString()
        });
      }
      return snapshotFromState(state, now);
    });
  }

  saveFromTask(input: {
    task: CollaborationTaskTransportRecord;
    execution: ExecutionHandle;
    scope: DurableMemoryScope;
    confirmed: true;
  }): Promise<MemoryRecord> {
    return this.mutate((state, now) => {
      if (input.confirmed !== true
        || input.task.direction !== "incoming"
        || input.task.state !== "completed"
        || input.task.request.taskId !== input.execution.taskId) {
        throw new ChildMemoryServiceError(
          "MEMORY_WRITE_NOT_AUTHORIZED",
          "Only an explicitly confirmed, completed local execution can be saved."
        );
      }
      const workspace = input.task.workspaceBinding;
      if (!workspace || workspace.workspaceId !== input.execution.workspaceId) {
        throw new ChildMemoryServiceError("MEMORY_SOURCE_INVALID", "Task Workspace binding is unavailable.");
      }
      if (input.scope === "workspace" && workspace.mode !== "durable_collaboration") {
        throw new ChildMemoryServiceError(
          "MEMORY_WORKSPACE_NOT_DURABLE",
          "Workspace Memory requires a durable Collaboration Workspace."
        );
      }
      if (!hasAuthorization(
        state.authorizations,
        input.scope,
        input.scope === "workspace" ? workspace.workspaceId : null,
        input.execution.childAgentId
      )) {
        throw new ChildMemoryServiceError(
          "MEMORY_SCOPE_DISABLED",
          "The selected long-term Memory scope is disabled."
        );
      }
      const artifact = [...(input.task.artifacts ?? [])].reverse().find(
        (candidate) => artifactText(candidate).trim()
      );
      if (!artifact) {
        throw new ChildMemoryServiceError("MEMORY_SOURCE_INVALID", "Task has no completed text Artifact.");
      }
      const content = boundedContent(artifactText(artifact));
      const existing = state.records.find((record) =>
        record.scope === input.scope
        && record.sourceTaskId === input.task.request.taskId
        && record.childAgentId === input.execution.childAgentId
        && record.provenance.sourceArtifactId === artifact.artifactId
      );
      if (existing) return structuredClone(existing);
      if (state.records.length >= CHILD_MEMORY_LIMITS.maximumRecords) {
        throw new ChildMemoryServiceError("MEMORY_STORE_FULL", "Child Memory store is full.");
      }
      const createdAt = now.toISOString();
      const record: MemoryRecord = {
        schemaVersion: TETI_CHILD_MEMORY_SCHEMA_VERSION,
        memoryId: randomUUID(),
        scope: input.scope,
        workspaceId: workspace.workspaceId,
        childAgentId: input.execution.childAgentId,
        sourceTaskId: input.task.request.taskId,
        sourcePeerId: input.task.peerTetiId,
        content,
        contentDigest: digest(content),
        createdAt,
        expiresAt: new Date(now.getTime() + CHILD_MEMORY_LIMITS.defaultRetentionMs).toISOString(),
        provenance: {
          kind: "task_artifact_user_saved",
          actor: "local_user",
          sourceArtifactId: artifact.artifactId,
          authorizedAt: createdAt
        }
      };
      validateMemoryRecord(record);
      state.records.push(record);
      return structuredClone(record);
    });
  }

  delete(memoryId: string): Promise<boolean> {
    return this.mutate((state) => {
      if (!SAFE_ID_PATTERN.test(memoryId)) {
        throw new ChildMemoryServiceError("MEMORY_ID_INVALID", "Memory ID is invalid.");
      }
      const before = state.records.length;
      state.records = state.records.filter((record) => record.memoryId !== memoryId);
      return state.records.length !== before;
    });
  }

  selectContext(input: SelectChildMemoryInput): Promise<MemoryContextSelection> {
    return this.mutate((state) => {
      requireSelectionInput(input);
      const eligible = state.records
        .filter((record) => record.childAgentId === input.childAgentId)
        .filter((record) => record.scope === "child_agent"
          ? hasAuthorization(state.authorizations, "child_agent", null, input.childAgentId)
          : record.scope === "workspace"
            && record.workspaceId === input.workspaceId
            && hasAuthorization(
              state.authorizations,
              "workspace",
              input.workspaceId,
              input.childAgentId
            ))
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
      const records = [];
      let byteLength = 0;
      for (const record of eligible) {
        const bytes = utf8Size(record.content);
        if (records.length >= CHILD_MEMORY_LIMITS.maximumContextRecords
          || byteLength + bytes > CHILD_MEMORY_LIMITS.maximumContextBytes) continue;
        records.push({
          memoryId: record.memoryId,
          scope: record.scope as DurableMemoryScope,
          contentDigest: record.contentDigest,
          content: record.content
        });
        byteLength += bytes;
      }
      const selection: MemoryContextSelection = {
        schemaVersion: TETI_CHILD_MEMORY_SCHEMA_VERSION,
        records,
        byteLength
      };
      validateMemoryContextSelection(selection);
      return selection;
    });
  }

  export(): Promise<MemoryExportResult> {
    return this.mutate(async (state, now) => {
      const createdAt = now.toISOString();
      const fileName = `teti-child-memory-${createdAt.replace(/[:.]/g, "-")}.json`;
      const path = join(this.options.exportRoot, fileName);
      await mkdir(this.options.exportRoot, { recursive: true, mode: 0o700 });
      await writeFile(path, `${JSON.stringify({
        schemaVersion: TETI_CHILD_MEMORY_SCHEMA_VERSION,
        exportedAt: createdAt,
        records: state.records,
        authorizations: state.authorizations
      }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await chmod(path, 0o600);
      return {
        schemaVersion: TETI_CHILD_MEMORY_SCHEMA_VERSION,
        fileName,
        path,
        recordCount: state.records.length,
        createdAt
      };
    });
  }

  private mutate<T>(operation: (
    state: ChildMemoryStoreState,
    now: Date
  ) => T | Promise<T>): Promise<T> {
    return this.serialize(async () => {
      const state = await this.options.store.load();
      const now = this.options.now?.() ?? new Date();
      state.records = state.records.filter((record) => Date.parse(record.expiresAt) > now.getTime());
      const result = await operation(state, now);
      await this.options.store.save(state);
      return result;
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operation.then(operation, operation);
    this.operation = next.then(() => undefined, () => undefined);
    return next;
  }
}

export class ChildMemoryServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ChildMemoryServiceError";
  }
}

function emptyState(): ChildMemoryStoreState {
  return { schemaVersion: MEMORY_STORE_SCHEMA_VERSION, records: [], authorizations: [] };
}

function snapshotFromState(state: ChildMemoryStoreState, now: Date): ChildMemorySnapshot {
  return {
    schemaVersion: TETI_CHILD_MEMORY_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    records: state.records.map(toSummary)
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)),
    authorizations: structuredClone(state.authorizations)
      .sort((left, right) => authorizationKey(left).localeCompare(authorizationKey(right)))
  };
}

function toSummary(record: MemoryRecord): MemoryRecordSummary {
  const { content, ...summary } = record;
  return {
    ...structuredClone(summary),
    contentPreview: [...content].slice(0, CHILD_MEMORY_LIMITS.maximumPreviewCharacters).join("")
  };
}

function validateStoreState(value: unknown): asserts value is ChildMemoryStoreState {
  if (!isRecord(value)
    || value.schemaVersion !== MEMORY_STORE_SCHEMA_VERSION
    || Object.keys(value).sort().join(",") !== "authorizations,records,schemaVersion"
    || !Array.isArray(value.records)
    || !Array.isArray(value.authorizations)
    || value.records.length > CHILD_MEMORY_LIMITS.maximumRecords
    || value.authorizations.length > CHILD_MEMORY_LIMITS.maximumAuthorizations) {
    throw new Error("Child Memory store is invalid.");
  }
  const memoryIds = new Set<string>();
  for (const record of value.records) {
    validateMemoryRecord(record);
    if (record.contentDigest !== digest(record.content)) {
      throw new Error("Memory content digest does not match the stored content.");
    }
    if (memoryIds.has(record.memoryId)) throw new Error("Memory ID is duplicated.");
    memoryIds.add(record.memoryId);
  }
  const authorizationKeys = new Set<string>();
  for (const authorization of value.authorizations) {
    validateMemoryAuthorization(authorization);
    const key = authorizationKey(authorization);
    if (authorizationKeys.has(key)) throw new Error("Memory authorization is duplicated.");
    authorizationKeys.add(key);
  }
}

function requireAuthorizationInput(input: {
  scope: DurableMemoryScope;
  workspaceId: string | null;
  childAgentId: string;
  enabled: boolean;
}): void {
  if ((input.scope !== "workspace" && input.scope !== "child_agent")
    || !SAFE_CHILD_AGENT_PATTERN.test(input.childAgentId)
    || typeof input.enabled !== "boolean"
    || (input.scope === "workspace"
      ? typeof input.workspaceId !== "string" || !SAFE_ID_PATTERN.test(input.workspaceId)
      : input.workspaceId !== null)) {
    throw new ChildMemoryServiceError("MEMORY_AUTHORIZATION_INVALID", "Memory authorization is invalid.");
  }
}

function requireSelectionInput(input: SelectChildMemoryInput): void {
  if (!SAFE_ID_PATTERN.test(input.taskId)
    || !SAFE_ID_PATTERN.test(input.workspaceId)
    || !SAFE_CHILD_AGENT_PATTERN.test(input.childAgentId)) {
    throw new ChildMemoryServiceError("MEMORY_QUERY_INVALID", "Memory context query is invalid.");
  }
}

function hasAuthorization(
  authorizations: readonly MemoryAuthorization[],
  scope: DurableMemoryScope,
  workspaceId: string | null,
  childAgentId: string
): boolean {
  return authorizations.some((authorization) =>
    authorization.scope === scope
    && authorization.workspaceId === workspaceId
    && authorization.childAgentId === childAgentId
  );
}

function authorizationKey(value: Pick<MemoryAuthorization, "scope" | "workspaceId" | "childAgentId">): string {
  return `${value.scope}:${value.workspaceId ?? "none"}:${value.childAgentId}`;
}

function authorizationInputKey(value: {
  scope: DurableMemoryScope;
  workspaceId: string | null;
  childAgentId: string;
}): string {
  return `${value.scope}:${value.scope === "workspace" ? value.workspaceId : "none"}:${value.childAgentId}`;
}

function artifactText(artifact: NonNullable<CollaborationTaskTransportRecord["artifacts"]>[number]): string {
  return artifact.schemaVersion === 1
    ? artifact.text
    : artifact.parts
        .filter((part): part is { kind: "text"; text: string } => part.kind === "text")
        .map((part) => part.text)
        .join("\n");
}

function boundedContent(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new ChildMemoryServiceError("MEMORY_SOURCE_INVALID", "Memory content is empty.");
  const encoded = new TextEncoder().encode(normalized);
  if (encoded.byteLength <= CHILD_MEMORY_LIMITS.maximumContentBytes) return normalized;
  const suffix = "\n[…已按 Child Memory v1 上限截断]";
  const suffixBytes = utf8Size(suffix);
  let result = "";
  for (const character of normalized) {
    if (utf8Size(result + character) + suffixBytes > CHILD_MEMORY_LIMITS.maximumContentBytes) break;
    result += character;
  }
  return `${result}${suffix}`;
}

function digest(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function utf8Size(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
