import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  MEMORY_SHADOW_RETRIEVAL_LIMITS,
  TETI_MEMORY_SHADOW_RETRIEVAL_SCHEMA_VERSION,
  type MemoryShadowCandidate,
  type MemoryShadowCandidateReason,
  type MemoryShadowRetrievalInput,
  type MemoryShadowScope,
  type MemoryShadowSelectionManifest
} from "../../../../../core/memory/shadow-retrieval.ts";
import {
  STRUCTURED_TASK_MEMORY_LIMITS,
  TETI_STRUCTURED_TASK_MEMORY_SCHEMA_VERSION,
  type LongHorizonStageMemoryInput,
  type LongHorizonStageMemorySummary,
  type LongHorizonTaskMemorySnapshot,
  type StructuredTaskMemoryStore
} from "../../../../../core/memory/structured-task.ts";

const DATABASE_SCHEMA_VERSION = 2;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const SAFE_AGENT_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const DATABASE_SCHEMA_V1_SQL = `
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

const DATABASE_MIGRATION_V2_SQL = `
CREATE VIRTUAL TABLE long_horizon_task_memory_fts USING fts5(
  memory_id UNINDEXED,
  content,
  tokenize = 'unicode61 remove_diacritics 2'
);
INSERT INTO long_horizon_task_memory_fts (memory_id, content)
  SELECT memory_id, content FROM long_horizon_task_memory;
CREATE INDEX long_horizon_task_memory_child_task_created
  ON long_horizon_task_memory (child_agent_id, task_id, created_at DESC, memory_id);
CREATE INDEX long_horizon_task_memory_child_workspace_created
  ON long_horizon_task_memory (child_agent_id, workspace_id, created_at DESC, memory_id);
CREATE INDEX long_horizon_task_memory_child_peer_created
  ON long_horizon_task_memory (child_agent_id, peer_teti_id, created_at DESC, memory_id);
CREATE TABLE memory_shadow_manifests (
  manifest_id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL UNIQUE,
  current_task_id TEXT NOT NULL,
  peer_teti_id TEXT NOT NULL,
  workspace_id TEXT,
  child_agent_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode = 'shadow'),
  query_digest TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  cli_injection_enabled INTEGER NOT NULL CHECK (cli_injection_enabled = 0),
  maximum_candidates INTEGER NOT NULL CHECK (maximum_candidates > 0),
  maximum_context_bytes INTEGER NOT NULL CHECK (maximum_context_bytes > 0),
  candidate_count INTEGER NOT NULL CHECK (candidate_count >= 0),
  candidate_bytes INTEGER NOT NULL CHECK (candidate_bytes >= 0),
  scope_counts_json TEXT NOT NULL,
  manifest_digest TEXT NOT NULL
) STRICT;
CREATE TABLE memory_shadow_candidates (
  manifest_id TEXT NOT NULL REFERENCES memory_shadow_manifests(manifest_id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL REFERENCES long_horizon_task_memory(memory_id) ON DELETE RESTRICT,
  source_task_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('task', 'workspace', 'peer')),
  kind TEXT NOT NULL CHECK (kind = 'stage_handoff'),
  trust TEXT NOT NULL CHECK (trust = 'peer_originated_reference'),
  version INTEGER NOT NULL CHECK (version = 1),
  rank INTEGER NOT NULL CHECK (rank > 0),
  score INTEGER NOT NULL,
  reasons_json TEXT NOT NULL,
  item_digest TEXT NOT NULL,
  content_bytes INTEGER NOT NULL CHECK (content_bytes > 0),
  created_at TEXT NOT NULL,
  eligible_for_cli_injection INTEGER NOT NULL CHECK (eligible_for_cli_injection = 0),
  PRIMARY KEY (manifest_id, memory_id),
  UNIQUE (manifest_id, rank)
) STRICT;
CREATE INDEX memory_shadow_manifests_task_generated
  ON memory_shadow_manifests (current_task_id, generated_at DESC, manifest_id DESC);
CREATE INDEX memory_shadow_candidates_manifest_rank
  ON memory_shadow_candidates (manifest_id, rank);
CREATE TRIGGER memory_shadow_manifests_no_update
  BEFORE UPDATE ON memory_shadow_manifests
  BEGIN SELECT RAISE(ABORT, 'shadow manifests are immutable'); END;
CREATE TRIGGER memory_shadow_candidates_no_update
  BEFORE UPDATE ON memory_shadow_candidates
  BEGIN SELECT RAISE(ABORT, 'shadow candidates are immutable'); END;
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

interface ShadowMemoryRow {
  memory_id: string;
  task_id: string;
  peer_teti_id: string;
  workspace_id: string | null;
  child_agent_id: string;
  content: string;
  content_digest: string;
  created_at: string;
}

interface ShadowManifestRow {
  manifest_id: string;
  execution_id: string;
  current_task_id: string;
  peer_teti_id: string;
  workspace_id: string | null;
  child_agent_id: string;
  query_digest: string;
  generated_at: string;
  maximum_candidates: number;
  maximum_context_bytes: number;
  candidate_count: number;
  candidate_bytes: number;
  scope_counts_json: string;
  manifest_digest: string;
}

interface ShadowCandidateRow {
  memory_id: string;
  source_task_id: string;
  scope: MemoryShadowScope;
  rank: number;
  score: number;
  reasons_json: string;
  item_digest: string;
  content_bytes: number;
  created_at: string;
}

export class StructuredTaskMemoryStoreError extends Error {
  readonly code:
    | "MEMORY_STORE_UNAVAILABLE"
    | "MEMORY_INPUT_INVALID"
    | "MEMORY_SOURCE_CONFLICT"
    | "MEMORY_STORE_FULL";

  constructor(
    code:
      | "MEMORY_STORE_UNAVAILABLE"
      | "MEMORY_INPUT_INVALID"
      | "MEMORY_SOURCE_CONFLICT"
      | "MEMORY_STORE_FULL",
    message: string
  ) {
    super(message);
    this.code = code;
  }
}

/**
 * Beta 0.5's deliberately narrow SQLite boundary: 0.5.0 captures only
 * successful stages of new long-horizon Tasks, and 0.5.1 evaluates those
 * records through non-injecting Shadow Retrieval. Existing Child Memory JSON
 * is neither read nor migrated here.
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
        database.prepare(`
          INSERT INTO long_horizon_task_memory_fts (memory_id, content) VALUES (?, ?)
        `).run(memoryId(input), input.content);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async createShadowManifest(
    input: MemoryShadowRetrievalInput
  ): Promise<MemoryShadowSelectionManifest> {
    validateShadowInput(input);
    await this.initialize();
    return this.serial(() => {
      const database = this.requireDatabase();
      const queryDigest = digest(input.queryText);
      const existing = selectShadowManifestByExecution(database, input.executionId, {
        taskId: input.taskId,
        peerTetiId: input.peerTetiId,
        workspaceId: input.workspaceId,
        childAgentId: input.childAgentId,
        queryDigest
      });
      if (existing) return existing;
      const count = database.prepare(`
        SELECT COUNT(*) AS count
        FROM memory_shadow_manifests
        WHERE current_task_id = ?
      `).get(input.taskId) as { count: number };
      if (count.count >= MEMORY_SHADOW_RETRIEVAL_LIMITS.maximumManifestsPerTask) {
        throw new StructuredTaskMemoryStoreError(
          "MEMORY_STORE_FULL",
          "The collaboration reached its bounded Shadow Retrieval manifest limit."
        );
      }

      const rows = database.prepare(`
        SELECT memory_id, task_id, peer_teti_id, workspace_id, child_agent_id,
          content, content_digest, created_at
        FROM long_horizon_task_memory
        WHERE child_agent_id = ?
          AND (task_id = ? OR workspace_id = ? OR peer_teti_id = ?)
      `).all(
        input.childAgentId,
        input.taskId,
        input.workspaceId,
        input.peerTetiId
      ) as unknown as ShadowMemoryRow[];
      const queryTokens = tokenizeShadowQuery(input.queryText);
      const keywordMatches = queryShadowKeywordMatches(database, queryTokens);
      const ranked = rows
        .filter((row) => Date.parse(row.created_at) <= Date.parse(input.generatedAt))
        .map((row) => rankShadowMemory(row, input, queryTokens, keywordMatches))
        .filter((candidate): candidate is RankedShadowMemory => candidate !== null)
        .sort(compareRankedShadowMemory);
      const scopeCandidateCounts = countShadowScopes(ranked);
      const candidates: MemoryShadowCandidate[] = [];
      let candidateBytes = 0;
      for (const candidate of ranked) {
        if (candidates.length >= MEMORY_SHADOW_RETRIEVAL_LIMITS.maximumCandidates
          || candidateBytes + candidate.contentBytes
            > MEMORY_SHADOW_RETRIEVAL_LIMITS.maximumContextBytes) continue;
        candidates.push({
          schemaVersion: TETI_MEMORY_SHADOW_RETRIEVAL_SCHEMA_VERSION,
          memoryId: candidate.memoryId,
          sourceTaskId: candidate.sourceTaskId,
          scope: candidate.scope,
          kind: "stage_handoff",
          trust: "peer_originated_reference",
          version: 1,
          rank: candidates.length + 1,
          score: candidate.score,
          reasons: candidate.reasons,
          itemDigest: candidate.itemDigest,
          contentBytes: candidate.contentBytes,
          createdAt: candidate.createdAt,
          eligibleForCliInjection: false
        });
        candidateBytes += candidate.contentBytes;
      }
      const unsignedManifest = {
        schemaVersion: 1 as const,
        manifestId: shadowManifestId(input, queryDigest),
        mode: "shadow" as const,
        executionId: input.executionId,
        currentTaskId: input.taskId,
        generatedAt: input.generatedAt,
        queryDigest,
        cliInjectionEnabled: false as const,
        maximumCandidates: MEMORY_SHADOW_RETRIEVAL_LIMITS.maximumCandidates,
        maximumContextBytes: MEMORY_SHADOW_RETRIEVAL_LIMITS.maximumContextBytes,
        candidateCount: candidates.length,
        candidateBytes,
        scopeCandidateCounts,
        candidates
      };
      const manifest: MemoryShadowSelectionManifest = {
        ...unsignedManifest,
        manifestDigest: digest(JSON.stringify(unsignedManifest))
      };

      database.exec("BEGIN IMMEDIATE");
      try {
        database.prepare(`
          INSERT INTO memory_shadow_manifests (
            manifest_id, execution_id, current_task_id, peer_teti_id,
            workspace_id, child_agent_id, mode, query_digest, generated_at,
            cli_injection_enabled, maximum_candidates, maximum_context_bytes,
            candidate_count, candidate_bytes, scope_counts_json, manifest_digest
          ) VALUES (?, ?, ?, ?, ?, ?, 'shadow', ?, ?, 0, ?, ?, ?, ?, ?, ?)
        `).run(
          manifest.manifestId,
          manifest.executionId,
          manifest.currentTaskId,
          input.peerTetiId,
          input.workspaceId,
          input.childAgentId,
          manifest.queryDigest,
          manifest.generatedAt,
          manifest.maximumCandidates,
          manifest.maximumContextBytes,
          manifest.candidateCount,
          manifest.candidateBytes,
          JSON.stringify(manifest.scopeCandidateCounts),
          manifest.manifestDigest
        );
        const insertCandidate = database.prepare(`
          INSERT INTO memory_shadow_candidates (
            manifest_id, memory_id, source_task_id, scope, kind, trust,
            version, rank, score, reasons_json, item_digest, content_bytes,
            created_at, eligible_for_cli_injection
          ) VALUES (?, ?, ?, ?, 'stage_handoff', 'peer_originated_reference',
            1, ?, ?, ?, ?, ?, ?, 0)
        `);
        for (const candidate of manifest.candidates) {
          insertCandidate.run(
            manifest.manifestId,
            candidate.memoryId,
            candidate.sourceTaskId,
            candidate.scope,
            candidate.rank,
            candidate.score,
            JSON.stringify(candidate.reasons),
            candidate.itemDigest,
            candidate.contentBytes,
            candidate.createdAt
          );
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return manifest;
    });
  }

  async getLatestShadowManifest(taskId: string): Promise<MemoryShadowSelectionManifest | null> {
    requireSafeId(taskId, "Task ID");
    await this.initialize();
    return this.serial(() => selectLatestShadowManifest(this.requireDatabase(), taskId));
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
        records,
        latestShadowManifest: selectLatestShadowManifest(this.requireDatabase(), taskId)
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
    if (version === 0) this.createSchemaV1(database);
    else if (version < 1 || version > DATABASE_SCHEMA_VERSION) {
      throw new Error("Unsupported structured task memory schema.");
    }
    this.requireMigrationEvidence(database, 1, DATABASE_SCHEMA_V1_SQL);
    const currentVersion = Number((database.prepare("PRAGMA user_version").get() as {
      user_version: number;
    }).user_version);
    if (currentVersion === 1) this.migrateToV2(database);
    this.requireMigrationEvidence(database, 2, DATABASE_MIGRATION_V2_SQL);
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

  private createSchemaV1(database: DatabaseSync): void {
    const appliedAt = this.now().toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(DATABASE_SCHEMA_V1_SQL);
      database.prepare(`
        INSERT INTO schema_migrations (version, applied_at, checksum) VALUES (?, ?, ?)
      `).run(1, appliedAt, digest(DATABASE_SCHEMA_V1_SQL));
      database.prepare(`
        INSERT INTO runtime_metadata (key, value) VALUES ('feature_enabled_at', ?)
      `).run(appliedAt);
      database.exec("PRAGMA user_version = 1");
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  private migrateToV2(database: DatabaseSync): void {
    const appliedAt = this.now().toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(DATABASE_MIGRATION_V2_SQL);
      database.prepare(`
        INSERT INTO schema_migrations (version, applied_at, checksum) VALUES (?, ?, ?)
      `).run(2, appliedAt, digest(DATABASE_MIGRATION_V2_SQL));
      database.exec("PRAGMA user_version = 2");
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  private requireMigrationEvidence(database: DatabaseSync, version: number, sql: string): void {
    const migration = database.prepare(`
      SELECT version, checksum FROM schema_migrations WHERE version = ?
    `).get(version) as { version: number; checksum: string } | undefined;
    if (!migration || migration.version !== version || migration.checksum !== digest(sql)) {
      throw new Error("Structured task memory schema evidence is invalid.");
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

interface RankedShadowMemory {
  memoryId: string;
  sourceTaskId: string;
  scope: MemoryShadowScope;
  score: number;
  reasons: MemoryShadowCandidateReason[];
  itemDigest: string;
  contentBytes: number;
  createdAt: string;
}

function validateShadowInput(input: MemoryShadowRetrievalInput): void {
  if (input.schemaVersion !== TETI_MEMORY_SHADOW_RETRIEVAL_SCHEMA_VERSION) {
    invalid("Shadow Retrieval schema version");
  }
  requireSafeId(input.executionId, "Execution ID");
  requireSafeId(input.taskId, "Task ID");
  if (!SAFE_ID_PATTERN.test(input.peerTetiId)) invalid("Peer Teti ID");
  if (input.workspaceId !== null && !SAFE_ID_PATTERN.test(input.workspaceId)) invalid("Workspace ID");
  if (!SAFE_AGENT_PATTERN.test(input.childAgentId)) invalid("Child Agent ID");
  if (!isTimestamp(input.generatedAt)) invalid("Shadow Retrieval timestamp");
  if (utf8Size(input.queryText) > MEMORY_SHADOW_RETRIEVAL_LIMITS.maximumQueryBytes) {
    invalid("Shadow Retrieval query");
  }
}

function tokenizeShadowQuery(value: string): string[] {
  const tokens = value.normalize("NFKC").toLocaleLowerCase("en-US")
    .match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return [...new Set(tokens.filter((token) => token.length >= 2))]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, MEMORY_SHADOW_RETRIEVAL_LIMITS.maximumQueryTokens);
}

function queryShadowKeywordMatches(database: DatabaseSync, tokens: string[]): Set<string> {
  if (tokens.length === 0) return new Set();
  const query = tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
  const rows = database.prepare(`
    SELECT memory_id FROM long_horizon_task_memory_fts
    WHERE long_horizon_task_memory_fts MATCH ?
  `).all(query) as unknown as { memory_id: string }[];
  return new Set(rows.map((row) => row.memory_id));
}

function rankShadowMemory(
  row: ShadowMemoryRow,
  input: MemoryShadowRetrievalInput,
  queryTokens: string[],
  keywordMatches: ReadonlySet<string>
): RankedShadowMemory | null {
  let scope: MemoryShadowScope;
  let scopeReason: MemoryShadowCandidateReason;
  let scopeScore: number;
  if (row.task_id === input.taskId) {
    scope = "task";
    scopeReason = "exact_task";
    scopeScore = 300;
  } else if (input.workspaceId !== null && row.workspace_id === input.workspaceId) {
    scope = "workspace";
    scopeReason = "exact_workspace";
    scopeScore = 200;
  } else if (row.peer_teti_id === input.peerTetiId) {
    scope = "peer";
    scopeReason = "exact_peer";
    scopeScore = 100;
  } else {
    return null;
  }
  const reasons: MemoryShadowCandidateReason[] = [scopeReason, "stage_handoff"];
  const normalizedContent = row.content.normalize("NFKC").toLocaleLowerCase("en-US");
  const keywordCount = keywordMatches.has(row.memory_id)
    ? queryTokens.filter((token) => normalizedContent.includes(token)).length
    : 0;
  if (keywordCount > 0) reasons.push("keyword_match");
  const ageDays = Math.max(
    0,
    Math.floor((Date.parse(input.generatedAt) - Date.parse(row.created_at)) / 86_400_000)
  );
  const recencyScore = Math.max(0, 30 - ageDays);
  if (recencyScore > 0) reasons.push("recent");
  return {
    memoryId: row.memory_id,
    sourceTaskId: row.task_id,
    scope,
    score: scopeScore + 40 + keywordCount * 25 + recencyScore,
    reasons,
    itemDigest: row.content_digest,
    contentBytes: utf8Size(row.content),
    createdAt: row.created_at
  };
}

function compareRankedShadowMemory(left: RankedShadowMemory, right: RankedShadowMemory): number {
  return right.score - left.score
    || Date.parse(right.createdAt) - Date.parse(left.createdAt)
    || left.memoryId.localeCompare(right.memoryId);
}

function countShadowScopes(
  candidates: readonly RankedShadowMemory[]
): Record<MemoryShadowScope, number> {
  const counts: Record<MemoryShadowScope, number> = { task: 0, workspace: 0, peer: 0 };
  for (const candidate of candidates) counts[candidate.scope] += 1;
  return counts;
}

function shadowManifestId(input: MemoryShadowRetrievalInput, queryDigest: string): string {
  return `msm_${createHash("sha256")
    .update(`${input.executionId}\0${input.taskId}\0${queryDigest}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function selectShadowManifestByExecution(
  database: DatabaseSync,
  executionId: string,
  expected?: {
    taskId: string;
    peerTetiId: string;
    workspaceId: string | null;
    childAgentId: string;
    queryDigest: string;
  }
): MemoryShadowSelectionManifest | null {
  const row = database.prepare(`
    SELECT manifest_id, execution_id, current_task_id, peer_teti_id,
      workspace_id, child_agent_id, query_digest, generated_at,
      maximum_candidates, maximum_context_bytes,
      candidate_count, candidate_bytes, scope_counts_json, manifest_digest
    FROM memory_shadow_manifests
    WHERE execution_id = ?
  `).get(executionId) as ShadowManifestRow | undefined;
  if (row && expected && (row.current_task_id !== expected.taskId
    || row.peer_teti_id !== expected.peerTetiId
    || row.workspace_id !== expected.workspaceId
    || row.child_agent_id !== expected.childAgentId
    || row.query_digest !== expected.queryDigest)) {
    throw new StructuredTaskMemoryStoreError(
      "MEMORY_SOURCE_CONFLICT",
      "A different Shadow Retrieval request is already stored for this execution."
    );
  }
  return row ? loadShadowManifest(database, row) : null;
}

function selectLatestShadowManifest(
  database: DatabaseSync,
  taskId: string
): MemoryShadowSelectionManifest | null {
  const row = database.prepare(`
    SELECT manifest_id, execution_id, current_task_id, peer_teti_id,
      workspace_id, child_agent_id, query_digest, generated_at,
      maximum_candidates, maximum_context_bytes,
      candidate_count, candidate_bytes, scope_counts_json, manifest_digest
    FROM memory_shadow_manifests
    WHERE current_task_id = ?
    ORDER BY generated_at DESC, manifest_id DESC
    LIMIT 1
  `).get(taskId) as ShadowManifestRow | undefined;
  return row ? loadShadowManifest(database, row) : null;
}

function loadShadowManifest(
  database: DatabaseSync,
  row: ShadowManifestRow
): MemoryShadowSelectionManifest {
  const candidateRows = database.prepare(`
    SELECT memory_id, source_task_id, scope, rank, score, reasons_json,
      item_digest, content_bytes, created_at
    FROM memory_shadow_candidates
    WHERE manifest_id = ?
    ORDER BY rank
  `).all(row.manifest_id) as unknown as ShadowCandidateRow[];
  const candidates: MemoryShadowCandidate[] = candidateRows.map((candidate) => ({
    schemaVersion: 1 as const,
    memoryId: candidate.memory_id,
    sourceTaskId: candidate.source_task_id,
    scope: candidate.scope,
    kind: "stage_handoff",
    trust: "peer_originated_reference",
    version: 1,
    rank: candidate.rank,
    score: candidate.score,
    reasons: parseShadowReasons(candidate.reasons_json),
    itemDigest: candidate.item_digest,
    contentBytes: candidate.content_bytes,
    createdAt: candidate.created_at,
    eligibleForCliInjection: false
  }));
  const scopeCandidateCounts = parseShadowScopeCounts(row.scope_counts_json);
  const unsignedManifest = {
    schemaVersion: 1 as const,
    manifestId: row.manifest_id,
    mode: "shadow" as const,
    executionId: row.execution_id,
    currentTaskId: row.current_task_id,
    generatedAt: row.generated_at,
    queryDigest: row.query_digest,
    cliInjectionEnabled: false as const,
    maximumCandidates: row.maximum_candidates,
    maximumContextBytes: row.maximum_context_bytes,
    candidateCount: row.candidate_count,
    candidateBytes: row.candidate_bytes,
    scopeCandidateCounts,
    candidates
  };
  if (candidates.length !== row.candidate_count
    || candidates.reduce((sum, candidate) => sum + candidate.contentBytes, 0) !== row.candidate_bytes
    || digest(JSON.stringify(unsignedManifest)) !== row.manifest_digest) {
    throw new Error("Structured task memory Shadow Retrieval manifest is invalid.");
  }
  return { ...unsignedManifest, manifestDigest: row.manifest_digest };
}

function parseShadowReasons(value: string): MemoryShadowCandidateReason[] {
  const parsed = JSON.parse(value) as unknown;
  const allowed = new Set<MemoryShadowCandidateReason>([
    "exact_task",
    "exact_workspace",
    "exact_peer",
    "stage_handoff",
    "keyword_match",
    "recent"
  ]);
  if (!Array.isArray(parsed) || parsed.some((reason) => !allowed.has(reason))) {
    throw new Error("Structured task memory Shadow Retrieval reasons are invalid.");
  }
  return parsed as MemoryShadowCandidateReason[];
}

function parseShadowScopeCounts(value: string): Record<MemoryShadowScope, number> {
  const parsed = JSON.parse(value) as Partial<Record<MemoryShadowScope, unknown>>;
  const result = { task: parsed.task, workspace: parsed.workspace, peer: parsed.peer };
  if (Object.values(result).some((count) => !Number.isSafeInteger(count) || Number(count) < 0)) {
    throw new Error("Structured task memory Shadow Retrieval scope counts are invalid.");
  }
  return result as Record<MemoryShadowScope, number>;
}

function utf8Size(value: string): number {
  return new TextEncoder().encode(value).byteLength;
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
