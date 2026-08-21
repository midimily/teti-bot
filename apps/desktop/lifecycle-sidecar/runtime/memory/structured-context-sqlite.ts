import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { MAX_TASK_INPUT_TEXT_BYTES } from "../../../../../core/task/types.ts";
import {
  STRUCTURED_MEMORY_CONTEXT_LIMITS,
  TETI_STRUCTURED_MEMORY_CONTEXT_SCHEMA_VERSION,
  structuredMemoryContextInputBytes,
  type CreateStructuredMemoryItemInput,
  type StructuredMemoryAuthorizationInput,
  type StructuredMemoryContextPreview,
  type StructuredMemoryContextRecord,
  type StructuredMemoryExecutionInput,
  type StructuredMemoryExecutionSelection,
  type StructuredMemoryInjectionCandidate,
  type StructuredMemoryInjectionManifest,
  type StructuredMemoryItemDetail,
  type StructuredMemoryItemSummary,
  type StructuredMemorySourceDraft,
  type StructuredMemoryKind,
  type StructuredMemoryPreviewApproval,
  type StructuredMemoryPreviewCandidate,
  type StructuredMemoryPreviewInput,
  type StructuredMemoryScope,
  type StructuredMemoryScopeAuthorization,
  type StructuredMemorySelectionReason,
  type UpdateStructuredMemoryItemInput
} from "../../../../../core/memory/context-injection.ts";

export const DATABASE_MIGRATION_V3_SQL = `
CREATE TABLE structured_memory_items (
  memory_id TEXT PRIMARY KEY,
  source_memory_id TEXT NOT NULL UNIQUE
    REFERENCES long_horizon_task_memory(memory_id) ON DELETE RESTRICT,
  source_task_id TEXT NOT NULL,
  peer_teti_id TEXT NOT NULL,
  workspace_id TEXT,
  child_agent_id TEXT NOT NULL,
  current_version INTEGER NOT NULL CHECK (current_version > 0),
  trust TEXT NOT NULL CHECK (trust = 'local_user_confirmed'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE structured_memory_versions (
  memory_id TEXT NOT NULL
    REFERENCES structured_memory_items(memory_id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  scope TEXT NOT NULL CHECK (scope IN ('task', 'workspace', 'peer')),
  kind TEXT NOT NULL CHECK (kind IN (
    'decision', 'constraint', 'fact', 'open_question',
    'handoff', 'summary', 'local_note'
  )),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)),
  editor TEXT NOT NULL CHECK (editor = 'local_user'),
  created_at TEXT NOT NULL,
  PRIMARY KEY (memory_id, version)
) STRICT;
CREATE VIRTUAL TABLE structured_memory_items_fts USING fts5(
  memory_id UNINDEXED,
  title,
  content,
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TABLE structured_memory_authorizations (
  scope TEXT NOT NULL CHECK (scope IN ('workspace', 'peer')),
  scope_key TEXT NOT NULL,
  workspace_id TEXT,
  peer_teti_id TEXT,
  child_agent_id TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  authorized_at TEXT,
  revoked_at TEXT,
  CHECK (
    (scope = 'workspace' AND workspace_id = scope_key AND peer_teti_id IS NULL)
    OR (scope = 'peer' AND peer_teti_id = scope_key AND workspace_id IS NULL)
  ),
  CHECK (
    (enabled = 1 AND authorized_at IS NOT NULL AND revoked_at IS NULL)
    OR (enabled = 0 AND revoked_at IS NOT NULL)
  ),
  PRIMARY KEY (scope, scope_key, child_agent_id)
) STRICT;
CREATE TABLE structured_memory_deletions (
  memory_id TEXT PRIMARY KEY,
  source_memory_id TEXT NOT NULL,
  prior_content_digest TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor = 'local_user'),
  reason_code TEXT NOT NULL CHECK (reason_code = 'user_deleted')
) STRICT;
CREATE TABLE structured_memory_previews (
  preview_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  peer_teti_id TEXT NOT NULL,
  workspace_id TEXT,
  child_agent_id TEXT NOT NULL,
  query_digest TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  candidate_count INTEGER NOT NULL CHECK (candidate_count >= 0),
  candidate_bytes INTEGER NOT NULL CHECK (candidate_bytes >= 0),
  scope_authorizations_json TEXT NOT NULL,
  preview_digest TEXT NOT NULL,
  approved_at TEXT,
  consumed_at TEXT,
  invalidated_at TEXT
) STRICT;
CREATE TABLE structured_memory_preview_candidates (
  preview_id TEXT NOT NULL
    REFERENCES structured_memory_previews(preview_id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  source_task_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('task', 'workspace', 'peer')),
  kind TEXT NOT NULL,
  selection_order INTEGER NOT NULL CHECK (selection_order > 0),
  rank INTEGER CHECK (rank IS NULL OR rank > 0),
  score INTEGER NOT NULL,
  reasons_json TEXT NOT NULL,
  item_digest TEXT NOT NULL,
  content_bytes INTEGER NOT NULL CHECK (content_bytes > 0),
  included INTEGER NOT NULL CHECK (included IN (0, 1)),
  CHECK ((included = 1 AND rank IS NOT NULL) OR (included = 0 AND rank IS NULL)),
  PRIMARY KEY (preview_id, memory_id),
  UNIQUE (preview_id, selection_order),
  UNIQUE (preview_id, rank)
) STRICT;
CREATE TABLE structured_memory_injection_manifests (
  manifest_id TEXT PRIMARY KEY,
  preview_id TEXT NOT NULL UNIQUE,
  execution_id TEXT NOT NULL UNIQUE,
  current_task_id TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode = 'injected'),
  cli_injection_enabled INTEGER NOT NULL CHECK (cli_injection_enabled = 1),
  candidate_count INTEGER NOT NULL CHECK (candidate_count > 0),
  candidate_bytes INTEGER NOT NULL CHECK (candidate_bytes > 0),
  manifest_digest TEXT NOT NULL
) STRICT;
CREATE TABLE structured_memory_injection_candidates (
  manifest_id TEXT NOT NULL
    REFERENCES structured_memory_injection_manifests(manifest_id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  source_task_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('task', 'workspace', 'peer')),
  kind TEXT NOT NULL,
  trust TEXT NOT NULL CHECK (trust = 'local_user_confirmed'),
  rank INTEGER NOT NULL CHECK (rank > 0),
  score INTEGER NOT NULL,
  reasons_json TEXT NOT NULL,
  item_digest TEXT NOT NULL,
  content_bytes INTEGER NOT NULL CHECK (content_bytes > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (manifest_id, memory_id),
  UNIQUE (manifest_id, rank)
) STRICT;
CREATE INDEX structured_memory_items_source_task
  ON structured_memory_items (source_task_id, updated_at DESC, memory_id);
CREATE INDEX structured_memory_items_scope_child
  ON structured_memory_items (child_agent_id, peer_teti_id, workspace_id, source_task_id);
CREATE INDEX structured_memory_previews_task_generated
  ON structured_memory_previews (task_id, child_agent_id, generated_at DESC);
CREATE INDEX structured_memory_injection_task_generated
  ON structured_memory_injection_manifests (current_task_id, generated_at DESC, manifest_id DESC);
CREATE TRIGGER structured_memory_versions_no_update
  BEFORE UPDATE ON structured_memory_versions
  BEGIN SELECT RAISE(ABORT, 'structured memory versions are immutable'); END;
CREATE TRIGGER structured_memory_deletions_no_update
  BEFORE UPDATE ON structured_memory_deletions
  BEGIN SELECT RAISE(ABORT, 'structured memory deletions are immutable'); END;
CREATE TRIGGER structured_memory_injection_manifests_no_update
  BEFORE UPDATE ON structured_memory_injection_manifests
  BEGIN SELECT RAISE(ABORT, 'structured memory injection manifests are immutable'); END;
CREATE TRIGGER structured_memory_injection_candidates_no_update
  BEFORE UPDATE ON structured_memory_injection_candidates
  BEGIN SELECT RAISE(ABORT, 'structured memory injection candidates are immutable'); END;
`;

export const DATABASE_MIGRATION_V4_SQL = `
ALTER TABLE structured_memory_items ADD COLUMN expires_at TEXT;
CREATE INDEX structured_memory_items_expiry
  ON structured_memory_items (expires_at, memory_id);
DROP TRIGGER structured_memory_deletions_no_update;
ALTER TABLE structured_memory_deletions RENAME TO structured_memory_deletions_v3;
CREATE TABLE structured_memory_deletions (
  memory_id TEXT PRIMARY KEY,
  source_memory_id TEXT NOT NULL,
  prior_content_digest TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('local_user', 'local_maintenance')),
  reason_code TEXT NOT NULL CHECK (reason_code IN ('user_deleted', 'expired'))
) STRICT;
INSERT INTO structured_memory_deletions (
  memory_id, source_memory_id, prior_content_digest, deleted_at, actor, reason_code
)
SELECT memory_id, source_memory_id, prior_content_digest, deleted_at, actor, reason_code
FROM structured_memory_deletions_v3;
DROP TABLE structured_memory_deletions_v3;
CREATE TRIGGER structured_memory_deletions_no_update
  BEFORE UPDATE ON structured_memory_deletions
  BEGIN SELECT RAISE(ABORT, 'structured memory deletions are immutable'); END;
CREATE TABLE structured_memory_metrics (
  key TEXT PRIMARY KEY CHECK (key IN (
    'candidate_count', 'selected_count', 'budget_rejected_count',
    'scope_rejected_count', 'deletion_success_count',
    'expiration_success_count'
  )),
  value INTEGER NOT NULL CHECK (value >= 0)
) STRICT;
INSERT INTO structured_memory_metrics (key, value) VALUES
  ('candidate_count', 0),
  ('selected_count', 0),
  ('budget_rejected_count', 0),
  ('scope_rejected_count', 0),
  ('deletion_success_count', 0),
  ('expiration_success_count', 0);
CREATE TABLE structured_memory_maintenance_events (
  event_id TEXT PRIMARY KEY,
  executed_at TEXT NOT NULL,
  expired_item_count INTEGER NOT NULL CHECK (expired_item_count >= 0),
  expired_preview_count INTEGER NOT NULL CHECK (expired_preview_count >= 0),
  invalid_preview_count INTEGER NOT NULL CHECK (invalid_preview_count >= 0)
) STRICT;
CREATE TRIGGER structured_memory_maintenance_events_no_update
  BEFORE UPDATE ON structured_memory_maintenance_events
  BEGIN SELECT RAISE(ABORT, 'structured memory maintenance events are immutable'); END;
`;

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const SAFE_AGENT_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const MEMORY_KINDS = new Set<StructuredMemoryKind>([
  "decision",
  "constraint",
  "fact",
  "open_question",
  "handoff",
  "summary",
  "local_note"
]);
const MEMORY_SCOPES = new Set<StructuredMemoryScope>(["task", "workspace", "peer"]);
const PREVIEW_REASON_SET = new Set<StructuredMemorySelectionReason>([
  "exact_task",
  "exact_workspace",
  "exact_peer",
  "pinned",
  "kind_priority",
  "keyword_match",
  "recent"
]);

export class StructuredContextSqliteError extends Error {
  readonly code:
    | "MEMORY_INPUT_INVALID"
    | "MEMORY_SOURCE_CONFLICT"
    | "MEMORY_STORE_FULL";

  constructor(
    code: "MEMORY_INPUT_INVALID" | "MEMORY_SOURCE_CONFLICT" | "MEMORY_STORE_FULL",
    message: string
  ) {
    super(message);
    this.code = code;
  }
}

interface SourceRow {
  memory_id: string;
  task_id: string;
  peer_teti_id: string;
  workspace_id: string | null;
  child_agent_id: string;
  content: string;
  created_at: string;
}

interface ItemRow {
  memory_id: string;
  source_memory_id: string;
  source_task_id: string;
  peer_teti_id: string;
  workspace_id: string | null;
  child_agent_id: string;
  current_version: number;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  scope: StructuredMemoryScope;
  kind: StructuredMemoryKind;
  title: string;
  content: string;
  content_digest: string;
  pinned: number;
}

interface RankedItem {
  row: ItemRow;
  score: number;
  reasons: StructuredMemorySelectionReason[];
  contentBytes: number;
}

interface PreviewRow {
  preview_id: string;
  task_id: string;
  peer_teti_id: string;
  workspace_id: string | null;
  child_agent_id: string;
  query_digest: string;
  generated_at: string;
  expires_at: string;
  candidate_count: number;
  candidate_bytes: number;
  scope_authorizations_json: string;
  preview_digest: string;
  approved_at: string | null;
  consumed_at: string | null;
  invalidated_at: string | null;
}

interface PreviewCandidateRow {
  memory_id: string;
  version: number;
  source_task_id: string;
  scope: StructuredMemoryScope;
  kind: StructuredMemoryKind;
  selection_order: number;
  rank: number | null;
  score: number;
  reasons_json: string;
  item_digest: string;
  content_bytes: number;
  included: number;
}

interface InjectionManifestRow {
  manifest_id: string;
  preview_id: string;
  execution_id: string;
  current_task_id: string;
  generated_at: string;
  candidate_count: number;
  candidate_bytes: number;
  manifest_digest: string;
}

export function getStructuredMemoryItem(
  database: DatabaseSync,
  input: { memoryId?: string; sourceMemoryId?: string }
): StructuredMemoryItemDetail | null {
  const hasMemoryId = typeof input.memoryId === "string";
  const hasSourceMemoryId = typeof input.sourceMemoryId === "string";
  if (hasMemoryId === hasSourceMemoryId) invalid("Memory lookup");
  const value = hasMemoryId ? input.memoryId! : input.sourceMemoryId!;
  requireSafeId(value, "Memory ID");
  const row = selectItem(database, hasMemoryId ? "item.memory_id" : "item.source_memory_id", value);
  return row ? toItemDetail(row) : null;
}

export function getStructuredMemorySourceDraft(
  database: DatabaseSync,
  sourceMemoryId: string
): StructuredMemorySourceDraft | null {
  requireSafeId(sourceMemoryId, "Source Memory ID");
  const deletion = database.prepare(`
    SELECT 1 AS found FROM structured_memory_deletions WHERE source_memory_id = ?
  `).get(sourceMemoryId) as { found: number } | undefined;
  if (deletion) return null;
  const source = database.prepare(`
    SELECT memory_id, task_id, peer_teti_id, workspace_id, child_agent_id,
      content, created_at
    FROM long_horizon_task_memory WHERE memory_id = ?
  `).get(sourceMemoryId) as SourceRow | undefined;
  if (!source) return null;
  const existingItem = selectItem(database, "item.source_memory_id", sourceMemoryId);
  const firstLine = source.content.split(/\r?\n/u, 1)[0]?.trim() ?? "";
  const suggestedTitle = [...(firstLine || "持续协作阶段记忆")]
    .slice(0, STRUCTURED_MEMORY_CONTEXT_LIMITS.maximumTitleCharacters)
    .join("");
  return {
    schemaVersion: TETI_STRUCTURED_MEMORY_CONTEXT_SCHEMA_VERSION,
    sourceMemoryId: source.memory_id,
    sourceTaskId: source.task_id,
    childAgentId: source.child_agent_id,
    workspaceScopeAvailable: source.workspace_id !== null,
    suggestedTitle,
    content: source.content,
    existingItem: existingItem ? toItemDetail(existingItem) : null
  };
}

export function listStructuredMemoryItemsForTask(
  database: DatabaseSync,
  taskId: string
): StructuredMemoryItemSummary[] {
  requireSafeId(taskId, "Task ID");
  return (database.prepare(`${ITEM_SELECT_SQL}
    WHERE item.source_task_id = ?
    ORDER BY item.updated_at DESC, item.memory_id
  `).all(taskId) as unknown as ItemRow[]).map(toItemSummary);
}

export function createStructuredMemoryItem(
  database: DatabaseSync,
  input: CreateStructuredMemoryItemInput
): StructuredMemoryItemDetail {
  validateCreateInput(input);
  const source = database.prepare(`
    SELECT memory_id, task_id, peer_teti_id, workspace_id, child_agent_id,
      content, created_at
    FROM long_horizon_task_memory WHERE memory_id = ?
  `).get(input.sourceMemoryId) as SourceRow | undefined;
  if (!source) invalid("Structured Memory source");
  const deletedSource = database.prepare(`
    SELECT 1 AS found FROM structured_memory_deletions WHERE source_memory_id = ?
  `).get(input.sourceMemoryId) as { found: number } | undefined;
  if (deletedSource) {
    throw new StructuredContextSqliteError(
      "MEMORY_SOURCE_CONFLICT",
      "A deleted Structured Memory source cannot be restored implicitly."
    );
  }
  if (input.scope === "workspace" && source.workspace_id === null) {
    invalid("Workspace Memory scope");
  }
  const existing = selectItem(database, "item.source_memory_id", input.sourceMemoryId);
  if (existing) {
    if (sameEditableFields(existing, input)) return toItemDetail(existing);
    throw new StructuredContextSqliteError(
      "MEMORY_SOURCE_CONFLICT",
      "The source stage is already confirmed as a different Structured Memory item."
    );
  }
  const activeCount = database.prepare(`
    SELECT COUNT(*) AS count FROM structured_memory_items
  `).get() as { count: number };
  if (activeCount.count >= 5_000) {
    throw new StructuredContextSqliteError(
      "MEMORY_STORE_FULL",
      "Structured Memory reached its bounded active-item limit."
    );
  }
  const title = input.title.trim();
  const content = input.content.trim();
  const memoryId = `smi_${createHash("sha256")
    .update(input.sourceMemoryId)
    .digest("hex")
    .slice(0, 32)}`;
  const contentDigest = digest(content);
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare(`
      INSERT INTO structured_memory_items (
        memory_id, source_memory_id, source_task_id, peer_teti_id,
        workspace_id, child_agent_id, current_version, trust, created_at,
        updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 'local_user_confirmed', ?, ?, ?)
    `).run(
      memoryId,
      source.memory_id,
      source.task_id,
      source.peer_teti_id,
      source.workspace_id,
      source.child_agent_id,
      input.changedAt,
      input.changedAt,
      input.expiresAt ?? null
    );
    insertVersion(database, {
      memoryId,
      version: 1,
      scope: input.scope,
      kind: input.kind,
      title,
      content,
      contentDigest,
      pinned: input.pinned,
      changedAt: input.changedAt
    });
    replaceFts(database, memoryId, title, content);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return toItemDetail(selectItem(database, "item.memory_id", memoryId)!);
}

export function updateStructuredMemoryItem(
  database: DatabaseSync,
  input: UpdateStructuredMemoryItemInput
): StructuredMemoryItemDetail {
  validateUpdateInput(input);
  const existing = selectItem(database, "item.memory_id", input.memoryId);
  if (!existing) invalid("Structured Memory item");
  if (input.scope === "workspace" && existing.workspace_id === null) {
    invalid("Workspace Memory scope");
  }
  if (existing.current_version !== input.expectedVersion) {
    throw new StructuredContextSqliteError(
      "MEMORY_SOURCE_CONFLICT",
      "Structured Memory was changed after the editor opened."
    );
  }
  if (sameEditableFields(existing, input)) return toItemDetail(existing);
  const title = input.title.trim();
  const content = input.content.trim();
  const nextVersion = existing.current_version + 1;
  database.exec("BEGIN IMMEDIATE");
  try {
    insertVersion(database, {
      memoryId: input.memoryId,
      version: nextVersion,
      scope: input.scope,
      kind: input.kind,
      title,
      content,
      contentDigest: digest(content),
      pinned: input.pinned,
      changedAt: input.changedAt
    });
    database.prepare(`
      UPDATE structured_memory_items
      SET current_version = ?, updated_at = ?, expires_at = ?
      WHERE memory_id = ? AND current_version = ?
    `).run(
      nextVersion,
      input.changedAt,
      input.expiresAt ?? null,
      input.memoryId,
      input.expectedVersion
    );
    replaceFts(database, input.memoryId, title, content);
    invalidatePendingPreviews(database, input.memoryId, input.changedAt);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return toItemDetail(selectItem(database, "item.memory_id", input.memoryId)!);
}

export function deleteStructuredMemoryItem(
  database: DatabaseSync,
  input: { memoryId: string; confirmed: true; deletedAt: string }
): boolean {
  requireSafeId(input.memoryId, "Memory ID");
  if (input.confirmed !== true || !isTimestamp(input.deletedAt)) invalid("Memory deletion");
  return deleteStructuredMemoryItemWithReason(database, {
    memoryId: input.memoryId,
    deletedAt: input.deletedAt,
    actor: "local_user",
    reasonCode: "user_deleted"
  });
}

function deleteStructuredMemoryItemWithReason(
  database: DatabaseSync,
  input: {
    memoryId: string;
    deletedAt: string;
    actor: "local_user" | "local_maintenance";
    reasonCode: "user_deleted" | "expired";
  }
): boolean {
  const existing = selectItem(database, "item.memory_id", input.memoryId);
  if (!existing) return false;
  database.exec("BEGIN IMMEDIATE");
  try {
    invalidatePendingPreviews(database, input.memoryId, input.deletedAt);
    database.prepare("DELETE FROM structured_memory_items_fts WHERE memory_id = ?")
      .run(input.memoryId);
    database.prepare(`
      INSERT INTO structured_memory_deletions (
        memory_id, source_memory_id, prior_content_digest,
        deleted_at, actor, reason_code
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      existing.memory_id,
      existing.source_memory_id,
      existing.content_digest,
      input.deletedAt,
      input.actor,
      input.reasonCode
    );
    database.prepare("DELETE FROM structured_memory_items WHERE memory_id = ?")
      .run(input.memoryId);
    database.prepare("DELETE FROM long_horizon_task_memory_fts WHERE memory_id = ?")
      .run(existing.source_memory_id);
    database.prepare(`
      UPDATE long_horizon_task_memory SET content = '', content_digest = ?
      WHERE memory_id = ?
    `).run(digest(""), existing.source_memory_id);
    incrementMetric(
      database,
      input.reasonCode === "expired" ? "expiration_success_count" : "deletion_success_count",
      1
    );
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return true;
}

export function cleanupExpiredStructuredMemory(
  database: DatabaseSync,
  input: { executedAt: string; previewRetentionCutoff: string }
): { expiredItemCount: number; expiredPreviewCount: number; invalidPreviewCount: number } {
  if (!isTimestamp(input.executedAt) || !isTimestamp(input.previewRetentionCutoff)) {
    invalid("Structured Memory maintenance timestamp");
  }
  const expired = database.prepare(`
    SELECT memory_id FROM structured_memory_items
    WHERE expires_at IS NOT NULL AND expires_at <= ?
    ORDER BY memory_id
  `).all(input.executedAt) as unknown as Array<{ memory_id: string }>;
  let expiredItemCount = 0;
  for (const row of expired) {
    if (deleteStructuredMemoryItemWithReason(database, {
      memoryId: row.memory_id,
      deletedAt: input.executedAt,
      actor: "local_maintenance",
      reasonCode: "expired"
    })) expiredItemCount += 1;
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    const expiredPreviewCount = (database.prepare(`
      SELECT COUNT(*) AS count FROM structured_memory_previews
      WHERE consumed_at IS NULL AND expires_at < ?
    `).get(input.previewRetentionCutoff) as { count: number }).count;
    const invalidPreviewCount = (database.prepare(`
      SELECT COUNT(*) AS count FROM structured_memory_previews
      WHERE consumed_at IS NULL AND invalidated_at IS NOT NULL AND invalidated_at < ?
    `).get(input.previewRetentionCutoff) as { count: number }).count;
    database.prepare(`
      DELETE FROM structured_memory_previews
      WHERE consumed_at IS NULL AND (
        expires_at < ? OR (invalidated_at IS NOT NULL AND invalidated_at < ?)
      )
    `).run(input.previewRetentionCutoff, input.previewRetentionCutoff);
    database.prepare(`
      INSERT INTO structured_memory_maintenance_events (
        event_id, executed_at, expired_item_count,
        expired_preview_count, invalid_preview_count
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      `sme_${randomUUID().replaceAll("-", "")}`,
      input.executedAt,
      expiredItemCount,
      expiredPreviewCount,
      invalidPreviewCount
    );
    database.exec("COMMIT");
    return { expiredItemCount, expiredPreviewCount, invalidPreviewCount };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function setStructuredMemoryAuthorization(
  database: DatabaseSync,
  input: StructuredMemoryAuthorizationInput
): void {
  validateAuthorizationInput(input);
  const scopeKey = input.scope === "workspace" ? input.workspaceId! : input.peerTetiId;
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare(`
      INSERT INTO structured_memory_authorizations (
        scope, scope_key, workspace_id, peer_teti_id, child_agent_id,
        enabled, authorized_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope, scope_key, child_agent_id) DO UPDATE SET
        enabled = excluded.enabled,
        authorized_at = excluded.authorized_at,
        revoked_at = excluded.revoked_at
    `).run(
      input.scope,
      scopeKey,
      input.scope === "workspace" ? scopeKey : null,
      input.scope === "peer" ? scopeKey : null,
      input.childAgentId,
      input.enabled ? 1 : 0,
      input.enabled ? input.changedAt : null,
      input.enabled ? null : input.changedAt
    );
    database.prepare(`
      UPDATE structured_memory_previews
      SET invalidated_at = ?
      WHERE child_agent_id = ?
        AND consumed_at IS NULL
        AND invalidated_at IS NULL
        AND ${input.scope === "workspace" ? "workspace_id" : "peer_teti_id"} = ?
    `).run(input.changedAt, input.childAgentId, scopeKey);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function createStructuredMemoryContextPreview(
  database: DatabaseSync,
  input: StructuredMemoryPreviewInput
): StructuredMemoryContextPreview {
  validatePreviewInput(input);
  const queryDigest = digest(input.queryText);
  const scopeAuthorizations = scopeAuthorizationSnapshot(database, input);
  const authorizationByScope = new Map(
    scopeAuthorizations.map((authorization) => [authorization.scope, authorization.enabled])
  );
  const rows = (database.prepare(`${ITEM_SELECT_SQL}
    WHERE item.child_agent_id = ?
      AND (item.expires_at IS NULL OR item.expires_at > ?)
      AND (item.source_task_id = ? OR item.workspace_id = ? OR item.peer_teti_id = ?)
  `).all(
    input.childAgentId,
    input.generatedAt,
    input.taskId,
    input.workspaceId,
    input.peerTetiId
  ) as unknown as ItemRow[]).filter((row) =>
    row.scope === "task"
      ? row.source_task_id === input.taskId
      : row.scope === "workspace"
        ? row.workspace_id === input.workspaceId && authorizationByScope.get("workspace") === true
        : row.peer_teti_id === input.peerTetiId && authorizationByScope.get("peer") === true
  );
  const queryTokens = tokenize(input.queryText);
  const keywordMatches = queryKeywordMatches(database, queryTokens);
  const ranked = rows.map((row) => rankItem(row, input, queryTokens, keywordMatches))
    .sort(compareRankedItems);
  const excluded = new Set(input.excludedMemoryIds);
  const candidates: StructuredMemoryPreviewCandidate[] = [];
  const selectedRecords: StructuredMemoryContextRecord[] = [];
  let candidateCount = 0;
  let candidateBytes = 0;
  let budgetRejectedCount = 0;
  for (const candidate of ranked) {
    if (candidates.length >= STRUCTURED_MEMORY_CONTEXT_LIMITS.maximumPreviewCandidates) break;
    const candidateRecord = toContextRecord(candidate.row);
    const withinBudget = candidateCount < STRUCTURED_MEMORY_CONTEXT_LIMITS.maximumInjectedCandidates
      && candidateBytes + candidate.contentBytes
        <= STRUCTURED_MEMORY_CONTEXT_LIMITS.maximumInjectedBytes
      && structuredMemoryContextInputBytes(
        [...selectedRecords, candidateRecord],
        input.queryText
      ) <= MAX_TASK_INPUT_TEXT_BYTES;
    const included = !excluded.has(candidate.row.memory_id) && withinBudget;
    if (!excluded.has(candidate.row.memory_id) && !withinBudget) budgetRejectedCount += 1;
    if (included) {
      candidateCount += 1;
      candidateBytes += candidate.contentBytes;
      selectedRecords.push(candidateRecord);
    }
    candidates.push({
      ...toItemSummary(candidate.row),
      included,
      rank: included ? candidateCount : null,
      score: candidate.score,
      reasons: candidate.reasons,
      contentBytes: candidate.contentBytes
    });
  }
  const expiresAt = new Date(
    Date.parse(input.generatedAt) + STRUCTURED_MEMORY_CONTEXT_LIMITS.previewTtlMs
  ).toISOString();
  const previewCore = previewDigestCore({
    taskId: input.taskId,
    childAgentId: input.childAgentId,
    queryDigest,
    generatedAt: input.generatedAt,
    expiresAt,
    scopeAuthorizations,
    candidateCount,
    candidateBytes,
    candidates
  });
  const previewDigest = digest(JSON.stringify(previewCore));
  const previewId = `smp_${randomUUID().replaceAll("-", "")}`;
  const preview: StructuredMemoryContextPreview = {
    schemaVersion: TETI_STRUCTURED_MEMORY_CONTEXT_SCHEMA_VERSION,
    previewId,
    taskId: input.taskId,
    childAgentId: input.childAgentId,
    queryDigest,
    generatedAt: input.generatedAt,
    expiresAt,
    cliInjectionEnabled: false,
    scopeAuthorizations,
    candidateCount,
    candidateBytes,
    candidates,
    previewDigest
  };
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare(`
      DELETE FROM structured_memory_previews
      WHERE task_id = ? AND approved_at IS NULL AND expires_at < ?
    `).run(input.taskId, input.generatedAt);
    database.prepare(`
      UPDATE structured_memory_previews SET invalidated_at = ?
      WHERE task_id = ? AND child_agent_id = ?
        AND approved_at IS NULL AND consumed_at IS NULL AND invalidated_at IS NULL
    `).run(input.generatedAt, input.taskId, input.childAgentId);
    const previewCount = database.prepare(`
      SELECT COUNT(*) AS count FROM structured_memory_previews
      WHERE task_id = ? AND consumed_at IS NULL AND invalidated_at IS NULL
    `).get(input.taskId) as { count: number };
    if (previewCount.count >= 256) {
      throw new StructuredContextSqliteError(
        "MEMORY_STORE_FULL",
        "The Task reached its bounded Structured Memory preview limit."
      );
    }
    database.prepare(`
      INSERT INTO structured_memory_previews (
        preview_id, task_id, peer_teti_id, workspace_id, child_agent_id,
        query_digest, generated_at, expires_at, candidate_count,
        candidate_bytes, scope_authorizations_json, preview_digest
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      preview.previewId,
      input.taskId,
      input.peerTetiId,
      input.workspaceId,
      input.childAgentId,
      queryDigest,
      input.generatedAt,
      expiresAt,
      candidateCount,
      candidateBytes,
      JSON.stringify(scopeAuthorizations),
      previewDigest
    );
    const insertCandidate = database.prepare(`
      INSERT INTO structured_memory_preview_candidates (
        preview_id, memory_id, version, source_task_id, scope, kind,
        selection_order, rank, score, reasons_json, item_digest,
        content_bytes, included
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [index, candidate] of candidates.entries()) {
      insertCandidate.run(
        preview.previewId,
        candidate.memoryId,
        candidate.version,
        candidate.sourceTaskId,
        candidate.scope,
        candidate.kind,
        index + 1,
        candidate.rank,
        candidate.score,
        JSON.stringify(candidate.reasons),
        candidate.contentDigest,
        candidate.contentBytes,
        candidate.included ? 1 : 0
      );
    }
    const scopeRejectedCount = scopeAuthorizations
      .filter((authorization) => authorization.requiresExplicitAuthorization && !authorization.enabled)
      .reduce((sum, authorization) => sum + authorization.eligibleItemCount, 0);
    incrementMetric(database, "candidate_count", candidates.length);
    incrementMetric(database, "budget_rejected_count", budgetRejectedCount);
    incrementMetric(database, "scope_rejected_count", scopeRejectedCount);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return preview;
}

export function approveStructuredMemoryContextPreview(
  database: DatabaseSync,
  input: { taskId: string; previewId: string; approvedAt: string }
): StructuredMemoryPreviewApproval {
  requireSafeId(input.taskId, "Task ID");
  requireSafeId(input.previewId, "Preview ID");
  if (!isTimestamp(input.approvedAt)) invalid("Preview approval timestamp");
  const preview = selectPreview(database, input.previewId);
  if (!preview || preview.task_id !== input.taskId) invalid("Structured Memory preview");
  if (preview.invalidated_at || preview.consumed_at
    || Date.parse(preview.expires_at) < Date.parse(input.approvedAt)) {
    throw new StructuredContextSqliteError(
      "MEMORY_SOURCE_CONFLICT",
      "Structured Memory preview is stale and must be regenerated."
    );
  }
  requirePreviewCurrent(database, preview, input.approvedAt);
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare(`
      UPDATE structured_memory_previews
      SET approved_at = NULL
      WHERE task_id = ? AND child_agent_id = ?
        AND preview_id <> ? AND consumed_at IS NULL
    `).run(preview.task_id, preview.child_agent_id, preview.preview_id);
    database.prepare(`
      UPDATE structured_memory_previews SET approved_at = ?
      WHERE preview_id = ? AND invalidated_at IS NULL AND consumed_at IS NULL
    `).run(input.approvedAt, preview.preview_id);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return {
    schemaVersion: TETI_STRUCTURED_MEMORY_CONTEXT_SCHEMA_VERSION,
    previewId: preview.preview_id,
    taskId: preview.task_id,
    approvedAt: input.approvedAt,
    expiresAt: preview.expires_at
  };
}

export function createStructuredMemoryExecutionContext(
  database: DatabaseSync,
  input: StructuredMemoryExecutionInput
): StructuredMemoryExecutionSelection {
  validateExecutionInput(input);
  const queryDigest = digest(input.queryText);
  const existing = selectInjectionByExecution(database, input.executionId);
  if (existing) {
    const originalPreview = selectPreview(database, existing.preview_id);
    if (!originalPreview
      || existing.current_task_id !== input.taskId
      || originalPreview.task_id !== input.taskId
      || originalPreview.peer_teti_id !== input.peerTetiId
      || originalPreview.workspace_id !== input.workspaceId
      || originalPreview.child_agent_id !== input.childAgentId
      || originalPreview.query_digest !== queryDigest) {
      throw new StructuredContextSqliteError(
        "MEMORY_SOURCE_CONFLICT",
        "Structured Memory execution identity conflicts with its immutable manifest."
      );
    }
    if (originalPreview.invalidated_at
      || Date.parse(originalPreview.expires_at) < Date.parse(input.generatedAt)) {
      return emptyExecutionSelection();
    }
    try {
      requirePreviewCurrent(database, originalPreview, input.generatedAt);
    } catch {
      return emptyExecutionSelection();
    }
    return loadExecutionSelection(database, existing);
  }
  const preview = database.prepare(`
    SELECT preview_id, task_id, peer_teti_id, workspace_id, child_agent_id,
      query_digest, generated_at, expires_at, candidate_count, candidate_bytes,
      scope_authorizations_json, preview_digest, approved_at, consumed_at, invalidated_at
    FROM structured_memory_previews
    WHERE task_id = ? AND peer_teti_id = ?
      AND (workspace_id IS NULL OR workspace_id IS ?)
      AND child_agent_id = ? AND query_digest = ?
      AND approved_at IS NOT NULL AND consumed_at IS NULL AND invalidated_at IS NULL
      AND expires_at >= ?
    ORDER BY approved_at DESC, preview_id DESC
    LIMIT 1
  `).get(
    input.taskId,
    input.peerTetiId,
    input.workspaceId,
    input.childAgentId,
    queryDigest,
    input.generatedAt
  ) as PreviewRow | undefined;
  if (!preview || preview.candidate_count === 0) return emptyExecutionSelection();
  try {
    requirePreviewCurrent(database, preview, input.generatedAt);
  } catch {
    database.prepare(`
      UPDATE structured_memory_previews SET invalidated_at = ?
      WHERE preview_id = ? AND invalidated_at IS NULL
    `).run(input.generatedAt, preview.preview_id);
    return emptyExecutionSelection();
  }
  const selected = selectPreviewCandidates(database, preview.preview_id)
    .filter((candidate) => candidate.included === 1)
    .sort((left, right) => left.rank! - right.rank!);
  const itemRows = new Map(selected.map((candidate) => {
    const item = selectItem(database, "item.memory_id", candidate.memory_id);
    if (!item) throw new Error("Approved Structured Memory item is unavailable.");
    return [candidate.memory_id, item] as const;
  }));
  const candidates: StructuredMemoryInjectionCandidate[] = selected.map((candidate) => {
    const item = itemRows.get(candidate.memory_id)!;
    return {
      schemaVersion: TETI_STRUCTURED_MEMORY_CONTEXT_SCHEMA_VERSION,
      memoryId: candidate.memory_id,
      version: candidate.version,
      sourceTaskId: candidate.source_task_id,
      scope: candidate.scope,
      kind: candidate.kind,
      trust: "local_user_confirmed",
      rank: candidate.rank!,
      score: candidate.score,
      reasons: parseReasons(candidate.reasons_json),
      itemDigest: candidate.item_digest,
      contentBytes: candidate.content_bytes,
      createdAt: item.created_at
    };
  });
  const unsignedManifest = {
    schemaVersion: TETI_STRUCTURED_MEMORY_CONTEXT_SCHEMA_VERSION as 1,
    manifestId: injectionManifestId(input, preview.preview_id),
    mode: "injected" as const,
    previewId: preview.preview_id,
    executionId: input.executionId,
    currentTaskId: input.taskId,
    generatedAt: input.generatedAt,
    cliInjectionEnabled: true as const,
    candidateCount: candidates.length,
    candidateBytes: candidates.reduce((sum, candidate) => sum + candidate.contentBytes, 0),
    candidates
  };
  const manifest: StructuredMemoryInjectionManifest = {
    ...unsignedManifest,
    manifestDigest: digest(JSON.stringify(unsignedManifest))
  };
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare(`
      INSERT INTO structured_memory_injection_manifests (
        manifest_id, preview_id, execution_id, current_task_id, generated_at,
        mode, cli_injection_enabled, candidate_count, candidate_bytes, manifest_digest
      ) VALUES (?, ?, ?, ?, ?, 'injected', 1, ?, ?, ?)
    `).run(
      manifest.manifestId,
      manifest.previewId,
      manifest.executionId,
      manifest.currentTaskId,
      manifest.generatedAt,
      manifest.candidateCount,
      manifest.candidateBytes,
      manifest.manifestDigest
    );
    const insertCandidate = database.prepare(`
      INSERT INTO structured_memory_injection_candidates (
        manifest_id, memory_id, version, source_task_id, scope, kind,
        trust, rank, score, reasons_json, item_digest, content_bytes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'local_user_confirmed', ?, ?, ?, ?, ?, ?)
    `);
    for (const candidate of candidates) {
      insertCandidate.run(
        manifest.manifestId,
        candidate.memoryId,
        candidate.version,
        candidate.sourceTaskId,
        candidate.scope,
        candidate.kind,
        candidate.rank,
        candidate.score,
        JSON.stringify(candidate.reasons),
        candidate.itemDigest,
        candidate.contentBytes,
        candidate.createdAt
      );
    }
    incrementMetric(database, "selected_count", candidates.length);
    database.prepare(`
      UPDATE structured_memory_previews SET consumed_at = ? WHERE preview_id = ?
    `).run(input.generatedAt, preview.preview_id);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return {
    schemaVersion: TETI_STRUCTURED_MEMORY_CONTEXT_SCHEMA_VERSION,
    manifest,
    records: selected.map((candidate) => {
      const item = itemRows.get(candidate.memory_id)!;
      return {
        memoryId: item.memory_id,
        version: item.current_version,
        scope: item.scope,
        kind: item.kind,
        trust: "local_user_confirmed" as const,
        title: item.title,
        contentDigest: item.content_digest,
        content: item.content
      };
    }),
    byteLength: manifest.candidateBytes
  };
}

export function getLatestStructuredMemoryInjectionManifest(
  database: DatabaseSync,
  taskId: string
): StructuredMemoryInjectionManifest | null {
  requireSafeId(taskId, "Task ID");
  const row = database.prepare(`
    SELECT manifest_id, preview_id, execution_id, current_task_id, generated_at,
      candidate_count, candidate_bytes, manifest_digest
    FROM structured_memory_injection_manifests
    WHERE current_task_id = ?
    ORDER BY generated_at DESC, manifest_id DESC
    LIMIT 1
  `).get(taskId) as InjectionManifestRow | undefined;
  return row ? loadInjectionManifest(database, row) : null;
}

const ITEM_SELECT_SQL = `
  SELECT item.memory_id, item.source_memory_id, item.source_task_id,
    item.peer_teti_id, item.workspace_id, item.child_agent_id,
    item.current_version, item.created_at, item.updated_at, item.expires_at,
    version.scope, version.kind, version.title, version.content,
    version.content_digest, version.pinned
  FROM structured_memory_items AS item
  JOIN structured_memory_versions AS version
    ON version.memory_id = item.memory_id
    AND version.version = item.current_version
`;

function selectItem(database: DatabaseSync, column: string, value: string): ItemRow | undefined {
  if (column !== "item.memory_id" && column !== "item.source_memory_id") {
    throw new Error("Structured Memory lookup column is invalid.");
  }
  return database.prepare(`${ITEM_SELECT_SQL} WHERE ${column} = ?`).get(value) as ItemRow | undefined;
}

function toItemSummary(row: ItemRow): StructuredMemoryItemSummary {
  return {
    schemaVersion: TETI_STRUCTURED_MEMORY_CONTEXT_SCHEMA_VERSION,
    memoryId: row.memory_id,
    sourceMemoryId: row.source_memory_id,
    sourceTaskId: row.source_task_id,
    scope: row.scope,
    kind: row.kind,
    title: row.title,
    contentPreview: [...row.content].slice(0, 240).join(""),
    contentDigest: row.content_digest,
    version: row.current_version,
    pinned: row.pinned === 1,
    trust: "local_user_confirmed",
    childAgentId: row.child_agent_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toItemDetail(row: ItemRow): StructuredMemoryItemDetail {
  return { ...toItemSummary(row), content: row.content };
}

function toContextRecord(row: ItemRow) {
  return {
    memoryId: row.memory_id,
    version: row.current_version,
    scope: row.scope,
    kind: row.kind,
    trust: "local_user_confirmed" as const,
    title: row.title,
    contentDigest: row.content_digest,
    content: row.content
  };
}

function insertVersion(database: DatabaseSync, input: {
  memoryId: string;
  version: number;
  scope: StructuredMemoryScope;
  kind: StructuredMemoryKind;
  title: string;
  content: string;
  contentDigest: string;
  pinned: boolean;
  changedAt: string;
}): void {
  database.prepare(`
    INSERT INTO structured_memory_versions (
      memory_id, version, scope, kind, title, content, content_digest,
      pinned, editor, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'local_user', ?)
  `).run(
    input.memoryId,
    input.version,
    input.scope,
    input.kind,
    input.title,
    input.content,
    input.contentDigest,
    input.pinned ? 1 : 0,
    input.changedAt
  );
}

function replaceFts(database: DatabaseSync, memoryId: string, title: string, content: string): void {
  database.prepare("DELETE FROM structured_memory_items_fts WHERE memory_id = ?").run(memoryId);
  database.prepare(`
    INSERT INTO structured_memory_items_fts (memory_id, title, content) VALUES (?, ?, ?)
  `).run(memoryId, title, content);
}

function invalidatePendingPreviews(database: DatabaseSync, memoryId: string, at: string): void {
  database.prepare(`
    UPDATE structured_memory_previews SET invalidated_at = ?
    WHERE preview_id IN (
      SELECT preview_id FROM structured_memory_preview_candidates WHERE memory_id = ?
    ) AND consumed_at IS NULL AND invalidated_at IS NULL
  `).run(at, memoryId);
}

function scopeAuthorizationSnapshot(
  database: DatabaseSync,
  input: StructuredMemoryPreviewInput
): StructuredMemoryScopeAuthorization[] {
  const counts = { task: 0, workspace: 0, peer: 0 };
  const rows = database.prepare(`
    SELECT item.source_task_id, item.peer_teti_id, item.workspace_id, version.scope
    FROM structured_memory_items AS item
    JOIN structured_memory_versions AS version
      ON version.memory_id = item.memory_id AND version.version = item.current_version
    WHERE item.child_agent_id = ?
      AND (item.expires_at IS NULL OR item.expires_at > ?)
  `).all(input.childAgentId, input.generatedAt) as unknown as Array<{
    source_task_id: string;
    peer_teti_id: string;
    workspace_id: string | null;
    scope: StructuredMemoryScope;
  }>;
  counts.task = rows.filter((row) => row.scope === "task" && row.source_task_id === input.taskId).length;
  counts.workspace = input.workspaceId === null
    ? 0
    : rows.filter((row) => row.scope === "workspace" && row.workspace_id === input.workspaceId).length;
  counts.peer = rows.filter((row) => row.scope === "peer" && row.peer_teti_id === input.peerTetiId).length;
  const workspace = input.workspaceId === null
    ? undefined
    : selectAuthorization(database, "workspace", input.workspaceId, input.childAgentId);
  const peer = selectAuthorization(database, "peer", input.peerTetiId, input.childAgentId);
  return [
    {
      schemaVersion: 1,
      scope: "task",
      available: true,
      enabled: true,
      requiresExplicitAuthorization: false,
      authorizedAt: null,
      revokedAt: null,
      eligibleItemCount: counts.task
    },
    {
      schemaVersion: 1,
      scope: "workspace",
      available: input.workspaceId !== null,
      enabled: workspace?.enabled === 1,
      requiresExplicitAuthorization: true,
      authorizedAt: workspace?.authorized_at ?? null,
      revokedAt: workspace?.revoked_at ?? null,
      eligibleItemCount: counts.workspace
    },
    {
      schemaVersion: 1,
      scope: "peer",
      available: true,
      enabled: peer?.enabled === 1,
      requiresExplicitAuthorization: true,
      authorizedAt: peer?.authorized_at ?? null,
      revokedAt: peer?.revoked_at ?? null,
      eligibleItemCount: counts.peer
    }
  ];
}

function selectAuthorization(
  database: DatabaseSync,
  scope: "workspace" | "peer",
  scopeKey: string,
  childAgentId: string
): { enabled: number; authorized_at: string | null; revoked_at: string | null } | undefined {
  return database.prepare(`
    SELECT enabled, authorized_at, revoked_at
    FROM structured_memory_authorizations
    WHERE scope = ? AND scope_key = ? AND child_agent_id = ?
  `).get(scope, scopeKey, childAgentId) as {
    enabled: number;
    authorized_at: string | null;
    revoked_at: string | null;
  } | undefined;
}

function tokenize(value: string): string[] {
  const tokens = value.normalize("NFKC").toLocaleLowerCase("en-US")
    .match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return [...new Set(tokens.filter((token) => token.length >= 2))]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 16);
}

function queryKeywordMatches(database: DatabaseSync, tokens: string[]): Set<string> {
  if (tokens.length === 0) return new Set();
  const query = tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
  const rows = database.prepare(`
    SELECT memory_id FROM structured_memory_items_fts
    WHERE structured_memory_items_fts MATCH ?
  `).all(query) as unknown as Array<{ memory_id: string }>;
  return new Set(rows.map((row) => row.memory_id));
}

function rankItem(
  row: ItemRow,
  input: StructuredMemoryPreviewInput,
  queryTokens: string[],
  keywordMatches: ReadonlySet<string>
): RankedItem {
  const reasons: StructuredMemorySelectionReason[] = [
    row.scope === "task" ? "exact_task" : row.scope === "workspace" ? "exact_workspace" : "exact_peer",
    "kind_priority"
  ];
  const scopeScore = row.scope === "task" ? 300 : row.scope === "workspace" ? 200 : 100;
  const kindScore = kindScoreFor(row.kind);
  const normalized = `${row.title}\n${row.content}`.normalize("NFKC").toLocaleLowerCase("en-US");
  const keywordCount = keywordMatches.has(row.memory_id)
    ? queryTokens.filter((token) => normalized.includes(token)).length
    : 0;
  if (keywordCount > 0) reasons.push("keyword_match");
  if (row.pinned === 1) reasons.push("pinned");
  const ageDays = Math.max(
    0,
    Math.floor((Date.parse(input.generatedAt) - Date.parse(row.updated_at)) / 86_400_000)
  );
  const recencyScore = Math.max(0, 30 - ageDays);
  if (recencyScore > 0) reasons.push("recent");
  return {
    row,
    score: scopeScore + kindScore + (row.pinned === 1 ? 80 : 0)
      + keywordCount * 25 + recencyScore,
    reasons,
    contentBytes: utf8Size(row.content)
  };
}

function kindScoreFor(kind: StructuredMemoryKind): number {
  switch (kind) {
    case "decision": return 70;
    case "constraint": return 65;
    case "handoff": return 60;
    case "open_question": return 50;
    case "summary": return 40;
    case "fact": return 30;
    case "local_note": return 20;
  }
}

function compareRankedItems(left: RankedItem, right: RankedItem): number {
  return right.score - left.score
    || Date.parse(right.row.updated_at) - Date.parse(left.row.updated_at)
    || left.row.memory_id.localeCompare(right.row.memory_id);
}

function previewDigestCore(input: {
  taskId: string;
  childAgentId: string;
  queryDigest: string;
  generatedAt: string;
  expiresAt: string;
  scopeAuthorizations: StructuredMemoryScopeAuthorization[];
  candidateCount: number;
  candidateBytes: number;
  candidates: Array<Pick<
    StructuredMemoryPreviewCandidate,
    "memoryId" | "version" | "sourceTaskId" | "scope" | "kind" | "included"
      | "rank" | "score" | "reasons" | "contentDigest" | "contentBytes"
  >>;
}): object {
  return {
    schemaVersion: 1,
    taskId: input.taskId,
    childAgentId: input.childAgentId,
    queryDigest: input.queryDigest,
    generatedAt: input.generatedAt,
    expiresAt: input.expiresAt,
    scopeAuthorizations: input.scopeAuthorizations,
    candidateCount: input.candidateCount,
    candidateBytes: input.candidateBytes,
    candidates: input.candidates.map((candidate) => ({
      memoryId: candidate.memoryId,
      version: candidate.version,
      sourceTaskId: candidate.sourceTaskId,
      scope: candidate.scope,
      kind: candidate.kind,
      included: candidate.included,
      rank: candidate.rank,
      score: candidate.score,
      reasons: candidate.reasons,
      itemDigest: candidate.contentDigest,
      contentBytes: candidate.contentBytes
    }))
  };
}

function selectPreview(database: DatabaseSync, previewId: string): PreviewRow | undefined {
  return database.prepare(`
    SELECT preview_id, task_id, peer_teti_id, workspace_id, child_agent_id,
      query_digest, generated_at, expires_at, candidate_count, candidate_bytes,
      scope_authorizations_json, preview_digest, approved_at, consumed_at, invalidated_at
    FROM structured_memory_previews WHERE preview_id = ?
  `).get(previewId) as PreviewRow | undefined;
}

function selectPreviewCandidates(database: DatabaseSync, previewId: string): PreviewCandidateRow[] {
  return database.prepare(`
    SELECT memory_id, version, source_task_id, scope, kind, selection_order,
      rank, score, reasons_json, item_digest, content_bytes, included
    FROM structured_memory_preview_candidates
    WHERE preview_id = ? ORDER BY selection_order
  `).all(previewId) as unknown as PreviewCandidateRow[];
}

function requirePreviewCurrent(database: DatabaseSync, preview: PreviewRow, at: string): void {
  if (Date.parse(preview.expires_at) < Date.parse(at)) {
    throw new StructuredContextSqliteError("MEMORY_SOURCE_CONFLICT", "Structured Memory preview expired.");
  }
  const authorizations = parseScopeAuthorizations(preview.scope_authorizations_json);
  const candidates = selectPreviewCandidates(database, preview.preview_id);
  const included = candidates.filter((candidate) => candidate.included === 1);
  const includedBytes = included.reduce((sum, candidate) => sum + candidate.content_bytes, 0);
  const reconstructedDigest = digest(JSON.stringify(previewDigestCore({
    taskId: preview.task_id,
    childAgentId: preview.child_agent_id,
    queryDigest: preview.query_digest,
    generatedAt: preview.generated_at,
    expiresAt: preview.expires_at,
    scopeAuthorizations: authorizations,
    candidateCount: included.length,
    candidateBytes: includedBytes,
    candidates: candidates.map((candidate) => ({
      memoryId: candidate.memory_id,
      version: candidate.version,
      sourceTaskId: candidate.source_task_id,
      scope: candidate.scope,
      kind: candidate.kind,
      included: candidate.included === 1,
      rank: candidate.rank,
      score: candidate.score,
      reasons: parseReasons(candidate.reasons_json),
      contentDigest: candidate.item_digest,
      contentBytes: candidate.content_bytes
    }))
  })));
  if (preview.candidate_count !== included.length
    || preview.candidate_bytes !== includedBytes
    || preview.preview_digest !== reconstructedDigest) {
    throw new StructuredContextSqliteError(
      "MEMORY_SOURCE_CONFLICT",
      "Structured Memory preview evidence is invalid."
    );
  }
  for (const authorization of authorizations) {
    if (!authorization.requiresExplicitAuthorization || !authorization.enabled) continue;
    const scopeKey = authorization.scope === "workspace" ? preview.workspace_id : preview.peer_teti_id;
    if (!scopeKey || selectAuthorization(
      database,
      authorization.scope as "workspace" | "peer",
      scopeKey,
      preview.child_agent_id
    )?.enabled !== 1) {
      throw new StructuredContextSqliteError(
        "MEMORY_SOURCE_CONFLICT",
        "Structured Memory authorization changed after preview."
      );
    }
  }
  for (const candidate of candidates.filter((value) => value.included === 1)) {
    const item = selectItem(database, "item.memory_id", candidate.memory_id);
    if (!item
      || (item.expires_at !== null && Date.parse(item.expires_at) <= Date.parse(at))
      || item.current_version !== candidate.version
      || item.content_digest !== candidate.item_digest
      || item.scope !== candidate.scope
      || item.kind !== candidate.kind) {
      throw new StructuredContextSqliteError(
        "MEMORY_SOURCE_CONFLICT",
        "Structured Memory item changed after preview."
      );
    }
  }
}

function selectInjectionByExecution(
  database: DatabaseSync,
  executionId: string
): InjectionManifestRow | undefined {
  return database.prepare(`
    SELECT manifest_id, preview_id, execution_id, current_task_id, generated_at,
      candidate_count, candidate_bytes, manifest_digest
    FROM structured_memory_injection_manifests WHERE execution_id = ?
  `).get(executionId) as InjectionManifestRow | undefined;
}

function loadExecutionSelection(
  database: DatabaseSync,
  row: InjectionManifestRow
): StructuredMemoryExecutionSelection {
  const manifest = loadInjectionManifest(database, row);
  const records = manifest.candidates.map((candidate) => {
    const item = selectItem(database, "item.memory_id", candidate.memoryId);
    if (!item || item.current_version !== candidate.version || item.content_digest !== candidate.itemDigest) {
      throw new Error("Injected Structured Memory content is no longer available.");
    }
    return {
      memoryId: item.memory_id,
      version: item.current_version,
      scope: item.scope,
      kind: item.kind,
      trust: "local_user_confirmed" as const,
      title: item.title,
      contentDigest: item.content_digest,
      content: item.content
    };
  });
  return {
    schemaVersion: 1,
    manifest,
    records,
    byteLength: row.candidate_bytes
  };
}

function loadInjectionManifest(
  database: DatabaseSync,
  row: InjectionManifestRow
): StructuredMemoryInjectionManifest {
  const candidateRows = database.prepare(`
    SELECT memory_id, version, source_task_id, scope, kind, rank, score,
      reasons_json, item_digest, content_bytes, created_at
    FROM structured_memory_injection_candidates
    WHERE manifest_id = ? ORDER BY rank
  `).all(row.manifest_id) as unknown as Array<{
    memory_id: string;
    version: number;
    source_task_id: string;
    scope: StructuredMemoryScope;
    kind: StructuredMemoryKind;
    rank: number;
    score: number;
    reasons_json: string;
    item_digest: string;
    content_bytes: number;
    created_at: string;
  }>;
  const candidates: StructuredMemoryInjectionCandidate[] = candidateRows.map((candidate) => ({
    schemaVersion: 1,
    memoryId: candidate.memory_id,
    version: candidate.version,
    sourceTaskId: candidate.source_task_id,
    scope: candidate.scope,
    kind: candidate.kind,
    trust: "local_user_confirmed",
    rank: candidate.rank,
    score: candidate.score,
    reasons: parseReasons(candidate.reasons_json),
    itemDigest: candidate.item_digest,
    contentBytes: candidate.content_bytes,
    createdAt: candidate.created_at
  }));
  const unsignedManifest = {
    schemaVersion: 1 as const,
    manifestId: row.manifest_id,
    mode: "injected" as const,
    previewId: row.preview_id,
    executionId: row.execution_id,
    currentTaskId: row.current_task_id,
    generatedAt: row.generated_at,
    cliInjectionEnabled: true as const,
    candidateCount: row.candidate_count,
    candidateBytes: row.candidate_bytes,
    candidates
  };
  if (candidates.length !== row.candidate_count
    || candidates.reduce((sum, candidate) => sum + candidate.contentBytes, 0) !== row.candidate_bytes
    || digest(JSON.stringify(unsignedManifest)) !== row.manifest_digest) {
    throw new Error("Structured Memory injection manifest is invalid.");
  }
  return { ...unsignedManifest, manifestDigest: row.manifest_digest };
}

function emptyExecutionSelection(): StructuredMemoryExecutionSelection {
  return { schemaVersion: 1, manifest: null, records: [], byteLength: 0 };
}

function injectionManifestId(input: StructuredMemoryExecutionInput, previewId: string): string {
  return `smm_${createHash("sha256")
    .update(`${input.executionId}\0${previewId}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function parseReasons(value: string): StructuredMemorySelectionReason[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((reason) => !PREVIEW_REASON_SET.has(reason))) {
    throw new Error("Structured Memory selection reasons are invalid.");
  }
  return parsed as StructuredMemorySelectionReason[];
}

function parseScopeAuthorizations(value: string): StructuredMemoryScopeAuthorization[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 3) {
    throw new Error("Structured Memory scope authorizations are invalid.");
  }
  const scopes = new Set<StructuredMemoryScope>();
  for (const authorization of parsed as StructuredMemoryScopeAuthorization[]) {
    if (authorization?.schemaVersion !== 1
      || !MEMORY_SCOPES.has(authorization.scope)
      || typeof authorization.available !== "boolean"
      || typeof authorization.enabled !== "boolean"
      || typeof authorization.requiresExplicitAuthorization !== "boolean"
      || !Number.isSafeInteger(authorization.eligibleItemCount)
      || authorization.eligibleItemCount < 0
      || (authorization.authorizedAt !== null && !isTimestamp(authorization.authorizedAt))
      || (authorization.revokedAt !== null && !isTimestamp(authorization.revokedAt))) {
      throw new Error("Structured Memory scope authorizations are invalid.");
    }
    scopes.add(authorization.scope);
  }
  if (scopes.size !== 3) throw new Error("Structured Memory scope authorizations are invalid.");
  return parsed as StructuredMemoryScopeAuthorization[];
}

function validateCreateInput(input: CreateStructuredMemoryItemInput): void {
  if (input.schemaVersion !== 1 || input.confirmed !== true) invalid("Structured Memory confirmation");
  requireSafeId(input.sourceMemoryId, "Source Memory ID");
  validateEditableFields(input);
  if (!isTimestamp(input.changedAt)) invalid("Structured Memory timestamp");
  validateExpiry(input.expiresAt, input.changedAt);
}

function validateUpdateInput(input: UpdateStructuredMemoryItemInput): void {
  if (input.schemaVersion !== 1 || input.confirmed !== true) invalid("Structured Memory update");
  requireSafeId(input.memoryId, "Memory ID");
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    invalid("Structured Memory version");
  }
  validateEditableFields(input);
  if (!isTimestamp(input.changedAt)) invalid("Structured Memory timestamp");
  validateExpiry(input.expiresAt, input.changedAt);
}

function validateEditableFields(input: {
  scope: StructuredMemoryScope;
  kind: StructuredMemoryKind;
  title: string;
  content: string;
  pinned: boolean;
}): void {
  if (!MEMORY_SCOPES.has(input.scope)
    || !MEMORY_KINDS.has(input.kind)
    || typeof input.pinned !== "boolean"
    || !input.title.trim()
    || [...input.title.trim()].length > STRUCTURED_MEMORY_CONTEXT_LIMITS.maximumTitleCharacters
    || !input.content.trim()
    || utf8Size(input.content.trim()) > STRUCTURED_MEMORY_CONTEXT_LIMITS.maximumContentBytes) {
    invalid("Structured Memory content");
  }
}

function validateAuthorizationInput(input: StructuredMemoryAuthorizationInput): void {
  if (input.schemaVersion !== 1
    || (input.scope !== "workspace" && input.scope !== "peer")
    || typeof input.enabled !== "boolean") invalid("Structured Memory authorization");
  requireSafeId(input.taskId, "Task ID");
  requireSafeId(input.peerTetiId, "Peer Teti ID");
  if (input.workspaceId !== null) requireSafeId(input.workspaceId, "Workspace ID");
  requireAgentId(input.childAgentId);
  if (input.scope === "workspace" && input.workspaceId === null) invalid("Workspace authorization");
  if (!isTimestamp(input.changedAt)) invalid("Authorization timestamp");
}

function validatePreviewInput(input: StructuredMemoryPreviewInput): void {
  if (input.schemaVersion !== 1 || !Array.isArray(input.excludedMemoryIds)) {
    invalid("Structured Memory preview");
  }
  requireContextIdentity(input);
  if (!isTimestamp(input.generatedAt) || utf8Size(input.queryText) > 8 * 1_024) {
    invalid("Structured Memory preview query");
  }
  if (input.excludedMemoryIds.length > STRUCTURED_MEMORY_CONTEXT_LIMITS.maximumPreviewCandidates
    || new Set(input.excludedMemoryIds).size !== input.excludedMemoryIds.length) {
    invalid("Structured Memory exclusions");
  }
  for (const memoryId of input.excludedMemoryIds) requireSafeId(memoryId, "Excluded Memory ID");
}

function validateExecutionInput(input: StructuredMemoryExecutionInput): void {
  if (input.schemaVersion !== 1) invalid("Structured Memory execution");
  requireSafeId(input.executionId, "Execution ID");
  requireContextIdentity(input);
  if (!isTimestamp(input.generatedAt) || utf8Size(input.queryText) > 8 * 1_024) {
    invalid("Structured Memory execution query");
  }
}

function requireContextIdentity(input: {
  taskId: string;
  peerTetiId: string;
  workspaceId: string | null;
  childAgentId: string;
}): void {
  requireSafeId(input.taskId, "Task ID");
  requireSafeId(input.peerTetiId, "Peer Teti ID");
  if (input.workspaceId !== null) requireSafeId(input.workspaceId, "Workspace ID");
  requireAgentId(input.childAgentId);
}

function sameEditableFields(
  row: ItemRow,
  input: Pick<
    CreateStructuredMemoryItemInput,
    "scope" | "kind" | "title" | "content" | "pinned" | "expiresAt"
  >
): boolean {
  return row.scope === input.scope
    && row.kind === input.kind
    && row.title === input.title.trim()
    && row.content === input.content.trim()
    && (row.pinned === 1) === input.pinned
    && row.expires_at === (input.expiresAt ?? null);
}

function validateExpiry(value: string | null | undefined, changedAt: string): void {
  if (value === undefined || value === null) return;
  if (!isTimestamp(value) || Date.parse(value) <= Date.parse(changedAt)) {
    invalid("Structured Memory expiry");
  }
}

function incrementMetric(
  database: DatabaseSync,
  key:
    | "candidate_count"
    | "selected_count"
    | "budget_rejected_count"
    | "scope_rejected_count"
    | "deletion_success_count"
    | "expiration_success_count",
  amount: number
): void {
  if (amount <= 0) return;
  database.prepare(`
    UPDATE structured_memory_metrics SET value = value + ? WHERE key = ?
  `).run(amount, key);
}

function requireSafeId(value: string, label: string): void {
  if (!SAFE_ID_PATTERN.test(value)) invalid(label);
}

function requireAgentId(value: string): void {
  if (!SAFE_AGENT_PATTERN.test(value)) invalid("Child Agent ID");
}

function invalid(label: string): never {
  throw new StructuredContextSqliteError("MEMORY_INPUT_INVALID", `${label} is invalid.`);
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function utf8Size(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isTimestamp(value: string): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
