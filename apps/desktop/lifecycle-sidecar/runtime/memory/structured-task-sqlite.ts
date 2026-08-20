import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  STRUCTURED_TASK_MEMORY_LIMITS,
  TETI_STRUCTURED_TASK_MEMORY_SCHEMA_VERSION,
  type LongHorizonStageMemoryInput,
  type LongHorizonStageMemorySummary,
  type LongHorizonTaskMemorySnapshot,
  type StructuredTaskMemoryStore
} from "../../../../../core/memory/structured-task.ts";

const DATABASE_SCHEMA_VERSION = 1;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const SAFE_AGENT_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const SCHEMA_SQL = `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  applied_at TEXT NOT NULL,
  checksum TEXT NOT NULL
) STRICT;
CREATE TABLE runtime_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
CREATE TABLE long_horizon_task_memory (
  memory_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  peer_teti_id TEXT NOT NULL,
  workspace_id TEXT,
  stage_id TEXT NOT NULL,
  stage_index INTEGER NOT NULL CHECK (stage_index > 0),
  execution_task_id TEXT NOT NULL,
  execution_epoch INTEGER CHECK (execution_epoch IS NULL OR execution_epoch > 0),
  child_agent_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL UNIQUE,
  workspace_revision INTEGER NOT NULL CHECK (workspace_revision >= 0),
  kind TEXT NOT NULL CHECK (kind = 'stage_handoff'),
  trust TEXT NOT NULL CHECK (trust = 'peer_originated_reference'),
  content TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  UNIQUE (task_id, stage_index)
) STRICT;
CREATE INDEX long_horizon_task_memory_task_created
  ON long_horizon_task_memory (task_id, stage_index DESC);
`;

interface MemoryRow {
  memory_id: string;
  task_id: string;
  stage_id: string;
  stage_index: number;
  child_agent_id: string;
  connector_id: string;
  artifact_id: string;
  workspace_revision: number;
  content: string;
  content_digest: string;
  created_at: string;
}

export class StructuredTaskMemoryStoreError extends Error {
  readonly code: "MEMORY_STORE_UNAVAILABLE" | "MEMORY_INPUT_INVALID" | "MEMORY_SOURCE_CONFLICT";

  constructor(
    code: "MEMORY_STORE_UNAVAILABLE" | "MEMORY_INPUT_INVALID" | "MEMORY_SOURCE_CONFLICT",
    message: string
  ) {
    super(message);
    this.code = code;
  }
}

/**
 * Beta 0.5.0's deliberately narrow SQLite boundary: only successful stages of
 * new long-horizon Tasks are captured. Existing Child Memory JSON is neither
 * read nor migrated here.
 */
export class SqliteStructuredTaskMemoryStore implements StructuredTaskMemoryStore {
  private readonly path: string;
  private readonly now: () => Date;
  private database: DatabaseSync | null = null;
  private featureEnabledAt: string | null = null;
  private initialization: Promise<void> | null = null;
  private operation: Promise<void> = Promise.resolve();

  constructor(options: { path: string; now?: () => Date }) {
    this.path = options.path;
    this.now = options.now ?? (() => new Date());
  }

  initialize(): Promise<void> {
    this.initialization ??= this.open().catch((error) => {
      this.database?.close();
      this.database = null;
      this.initialization = null;
      throw asStoreUnavailable(error);
    });
    return this.initialization;
  }

  async saveStage(input: LongHorizonStageMemoryInput): Promise<void> {
    validateStageInput(input);
    await this.initialize();
    await this.serial(() => {
      const database = this.requireDatabase();
      if (Date.parse(input.taskCreatedAt) < Date.parse(this.featureEnabledAt!)) return;
      const existing = database.prepare(`
        SELECT artifact_id, content_digest
        FROM long_horizon_task_memory
        WHERE task_id = ? AND stage_index = ?
      `).get(input.taskId, input.stageIndex) as {
        artifact_id: string;
        content_digest: string;
      } | undefined;
      const contentDigest = digest(input.content);
      if (existing) {
        if (existing.artifact_id === input.artifactId && existing.content_digest === contentDigest) return;
        throw new StructuredTaskMemoryStoreError(
          "MEMORY_SOURCE_CONFLICT",
          "A different Artifact is already stored for this collaboration stage."
        );
      }
      const count = database.prepare(`
        SELECT COUNT(*) AS count
        FROM long_horizon_task_memory
        WHERE task_id = ?
      `).get(input.taskId) as { count: number };
      if (count.count >= STRUCTURED_TASK_MEMORY_LIMITS.maximumStagesPerTask) {
        throw new StructuredTaskMemoryStoreError(
          "MEMORY_INPUT_INVALID",
          "The collaboration reached its bounded memory stage limit."
        );
      }
      const capturedAt = this.now().toISOString();
      database.exec("BEGIN IMMEDIATE");
      try {
        database.prepare(`
          INSERT INTO long_horizon_task_memory (
            memory_id, task_id, peer_teti_id, workspace_id, stage_id, stage_index,
            execution_task_id, execution_epoch, child_agent_id, connector_id,
            artifact_id, workspace_revision, kind, trust, content, content_digest,
            created_at, captured_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stage_handoff',
            'peer_originated_reference', ?, ?, ?, ?)
        `).run(
          memoryId(input),
          input.taskId,
          input.peerTetiId,
          input.workspaceId,
          input.stageId,
          input.stageIndex,
          input.executionTaskId,
          input.executionEpoch,
          input.childAgentId,
          input.connectorId,
          input.artifactId,
          input.workspaceRevision,
          input.content,
          contentDigest,
          input.createdAt,
          capturedAt
        );
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async getTaskSnapshot(taskId: string): Promise<LongHorizonTaskMemorySnapshot> {
    requireSafeId(taskId, "Task ID");
    await this.initialize();
    return this.serial(() => {
      const rows = this.requireDatabase().prepare(`
        SELECT memory_id, task_id, stage_id, stage_index, child_agent_id,
          connector_id, artifact_id, workspace_revision, content,
          content_digest, created_at
        FROM long_horizon_task_memory
        WHERE task_id = ?
        ORDER BY stage_index DESC
      `).all(taskId) as unknown as MemoryRow[];
      const records = rows.map(toSummary);
      return {
        schemaVersion: TETI_STRUCTURED_TASK_MEMORY_SCHEMA_VERSION,
        taskId,
        status: "ready",
        recordCount: records.length,
        latestStageIndex: records[0]?.stageIndex ?? null,
        updatedAt: records[0]?.createdAt ?? null,
        records
      };
    });
  }

  async close(): Promise<void> {
    const initialization = this.initialization;
    if (initialization) await initialization.catch(() => undefined);
    await this.operation.catch(() => undefined);
    this.database?.close();
    this.database = null;
    this.featureEnabledAt = null;
    this.initialization = null;
  }

  private async open(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const database = new DatabaseSync(this.path, {
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true,
      timeout: 250
    });
    this.database = database;
    database.exec("PRAGMA journal_mode = DELETE");
    database.exec("PRAGMA synchronous = FULL");
    database.exec("PRAGMA trusted_schema = OFF");
    database.exec("PRAGMA secure_delete = ON");
    const version = Number((database.prepare("PRAGMA user_version").get() as {
      user_version: number;
    }).user_version);
    if (version === 0) this.createSchema(database);
    else if (version !== DATABASE_SCHEMA_VERSION) {
      throw new Error("Unsupported structured task memory schema.");
    }
    const migration = database.prepare(`
      SELECT version, checksum FROM schema_migrations WHERE version = ?
    `).get(DATABASE_SCHEMA_VERSION) as { version: number; checksum: string } | undefined;
    if (!migration
      || migration.version !== DATABASE_SCHEMA_VERSION
      || migration.checksum !== digest(SCHEMA_SQL)) {
      throw new Error("Structured task memory schema evidence is invalid.");
    }
    const integrity = database.prepare("PRAGMA integrity_check").get() as {
      integrity_check: string;
    };
    if (integrity.integrity_check !== "ok") throw new Error("Structured task memory integrity check failed.");
    const foreignKeyFailures = database.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeyFailures.length > 0) throw new Error("Structured task memory foreign key check failed.");
    const metadata = database.prepare(`
      SELECT value FROM runtime_metadata WHERE key = 'feature_enabled_at'
    `).get() as { value: string } | undefined;
    if (!metadata || !isTimestamp(metadata.value)) throw new Error("Structured task memory metadata is invalid.");
    this.featureEnabledAt = metadata.value;
    await chmod(dirname(this.path), 0o700);
    await chmod(this.path, 0o600);
  }

  private createSchema(database: DatabaseSync): void {
    const appliedAt = this.now().toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(SCHEMA_SQL);
      database.prepare(`
        INSERT INTO schema_migrations (version, applied_at, checksum) VALUES (?, ?, ?)
      `).run(DATABASE_SCHEMA_VERSION, appliedAt, digest(SCHEMA_SQL));
      database.prepare(`
        INSERT INTO runtime_metadata (key, value) VALUES ('feature_enabled_at', ?)
      `).run(appliedAt);
      database.exec(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION}`);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  private requireDatabase(): DatabaseSync {
    if (!this.database) throw new Error("Structured task memory is not initialized.");
    return this.database;
  }

  private serial<T>(operation: () => T): Promise<T> {
    const pending = this.operation.then(operation, operation);
    this.operation = pending.then(() => undefined, () => undefined);
    return pending.catch((error) => {
      if (error instanceof StructuredTaskMemoryStoreError) throw error;
      throw asStoreUnavailable(error);
    });
  }
}

function validateStageInput(input: LongHorizonStageMemoryInput): void {
  if (input.schemaVersion !== TETI_STRUCTURED_TASK_MEMORY_SCHEMA_VERSION) invalid("Schema version");
  requireSafeId(input.taskId, "Task ID");
  requireSafeId(input.stageId, "Stage ID");
  requireSafeId(input.executionTaskId, "Execution Task ID");
  requireSafeId(input.artifactId, "Artifact ID");
  if (!SAFE_ID_PATTERN.test(input.peerTetiId)) invalid("Peer Teti ID");
  if (input.workspaceId !== null && !SAFE_ID_PATTERN.test(input.workspaceId)) invalid("Workspace ID");
  if (!SAFE_AGENT_PATTERN.test(input.childAgentId)) invalid("Child Agent ID");
  if (!SAFE_ID_PATTERN.test(input.connectorId)) invalid("Connector ID");
  if (!Number.isSafeInteger(input.stageIndex) || input.stageIndex < 1
    || input.stageIndex > STRUCTURED_TASK_MEMORY_LIMITS.maximumStagesPerTask) invalid("Stage index");
  if (input.executionEpoch !== null
    && (!Number.isSafeInteger(input.executionEpoch) || input.executionEpoch < 1)) invalid("Execution epoch");
  if (!Number.isSafeInteger(input.workspaceRevision) || input.workspaceRevision < 0) invalid("Workspace revision");
  if (!isTimestamp(input.taskCreatedAt) || !isTimestamp(input.createdAt)) invalid("Timestamp");
  if (!input.content.trim()
    || new TextEncoder().encode(input.content).byteLength
      > STRUCTURED_TASK_MEMORY_LIMITS.maximumContentBytes) invalid("Content");
}

function requireSafeId(value: string, label: string): void {
  if (!SAFE_ID_PATTERN.test(value)) invalid(label);
}

function invalid(label: string): never {
  throw new StructuredTaskMemoryStoreError("MEMORY_INPUT_INVALID", `${label} is invalid.`);
}

function memoryId(input: LongHorizonStageMemoryInput): string {
  return `lhm_${createHash("sha256")
    .update(`${input.taskId}\0${input.stageIndex}\0${input.artifactId}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function toSummary(row: MemoryRow): LongHorizonStageMemorySummary {
  return {
    schemaVersion: TETI_STRUCTURED_TASK_MEMORY_SCHEMA_VERSION,
    memoryId: row.memory_id,
    taskId: row.task_id,
    stageId: row.stage_id,
    stageIndex: row.stage_index,
    childAgentId: row.child_agent_id,
    connectorId: row.connector_id,
    artifactId: row.artifact_id,
    workspaceRevision: row.workspace_revision,
    kind: "stage_handoff",
    trust: "peer_originated_reference",
    contentDigest: row.content_digest,
    contentPreview: [...row.content]
      .slice(0, STRUCTURED_TASK_MEMORY_LIMITS.maximumPreviewCharacters)
      .join(""),
    createdAt: row.created_at
  };
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function isTimestamp(value: string): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function asStoreUnavailable(error: unknown): StructuredTaskMemoryStoreError {
  return error instanceof StructuredTaskMemoryStoreError
    ? error
    : new StructuredTaskMemoryStoreError(
      "MEMORY_STORE_UNAVAILABLE",
      "Structured task memory is unavailable."
    );
}
