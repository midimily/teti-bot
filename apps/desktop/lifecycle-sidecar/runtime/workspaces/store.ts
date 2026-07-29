import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  DEFAULT_DURABLE_WORKSPACE_QUOTA,
  DEFAULT_EPHEMERAL_WORKSPACE_QUOTA,
  TETI_WORKSPACE_SCHEMA_VERSION,
  TETI_WORKSPACE_SNAPSHOT_SCHEMA_VERSION,
  WORKSPACE_LIMITS,
  emptyWorkspaceManifest,
  type CollaborationWorkspace,
  type WorkspaceAccess,
  type WorkspaceManifest,
  type WorkspaceMode,
  type WorkspaceQuota,
  type WorkspaceRetentionPolicy,
  type WorkspaceSnapshot
} from "../../../../../core/workspace/types.ts";
import {
  validateCollaborationWorkspace,
  validateWorkspaceAccess,
  validateWorkspaceManifest,
  validateWorkspaceRelativePath
} from "../../../../../core/workspace/validation.ts";

const WORKSPACE_INDEX_SCHEMA_VERSION = 1;

interface WorkspaceIndex {
  schemaVersion: 1;
  workspaces: CollaborationWorkspace[];
}

export interface CreateWorkspaceInput {
  workspaceId?: string;
  ownerTetiId: string;
  participantTetiIds: string[];
  mode: WorkspaceMode;
  quota?: WorkspaceQuota;
  retentionPolicy?: WorkspaceRetentionPolicy;
}

export interface CreateWorkspaceSnapshotInput {
  workspaceId: string;
  workspaceRevision: number;
  access: WorkspaceAccess[];
}

export interface CollaborationWorkspaceStore {
  initialize(): Promise<void>;
  create(input: CreateWorkspaceInput): Promise<CollaborationWorkspace>;
  get(workspaceId: string): Promise<CollaborationWorkspace | null>;
  createSnapshot(input: CreateWorkspaceSnapshotInput): Promise<WorkspaceSnapshot>;
  commitSnapshot(snapshot: WorkspaceSnapshot): Promise<CollaborationWorkspace>;
  discardSnapshot(snapshot: WorkspaceSnapshot): Promise<void>;
  cleanup(now?: Date): Promise<void>;
}

export class WorkspaceStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkspaceStoreError";
    this.code = code;
  }
}

interface ActiveSnapshot {
  snapshot: WorkspaceSnapshot;
  path: string;
}

export class FileCollaborationWorkspaceStore implements CollaborationWorkspaceStore {
  private readonly root: string;
  private readonly indexPath: string;
  private readonly workspacesRoot: string;
  private readonly snapshotsRoot: string;
  private readonly now: () => Date;
  private readonly activeSnapshots = new Map<string, ActiveSnapshot>();
  private queue: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(root: string, options: { now?: () => Date } = {}) {
    if (!isAbsolute(root) || resolve(root) === "/") {
      throw new WorkspaceStoreError("WORKSPACE_ROOT_INVALID", "Workspace Store root must be a scoped absolute path.");
    }
    this.root = resolve(root);
    this.indexPath = join(this.root, "index.json");
    this.workspacesRoot = join(this.root, "workspaces");
    this.snapshotsRoot = join(this.root, "snapshots");
    this.now = options.now ?? (() => new Date());
  }

  initialize(): Promise<void> {
    return this.exclusive(async () => {
      if (this.initialized) return;
      await mkdir(this.workspacesRoot, { recursive: true, mode: 0o700 });
      // Snapshots are execution scratch state. A surviving directory means the
      // Runtime crashed or was force-terminated and must never be resumed.
      await rm(this.snapshotsRoot, { recursive: true, force: true });
      await mkdir(this.snapshotsRoot, { recursive: true, mode: 0o700 });
      const index = await this.loadIndex();
      let changed = false;
      const retained: CollaborationWorkspace[] = [];
      for (const workspace of index.workspaces) {
        if (workspace.mode === "ephemeral_task") {
          await rm(this.workspaceRoot(workspace.workspaceId), { recursive: true, force: true });
          changed = true;
          continue;
        }
        await this.removeUncommittedRevisions(workspace);
        await this.verifyPersistedWorkspace(workspace);
        retained.push(workspace);
      }
      if (changed) await this.saveIndex({ ...index, workspaces: retained });
      this.initialized = true;
    });
  }

  create(input: CreateWorkspaceInput): Promise<CollaborationWorkspace> {
    return this.exclusive(async () => {
      await this.requireInitialized();
      const now = this.now();
      const workspaceId = input.workspaceId ?? `ws_${randomUUID()}`;
      const retentionPolicy = input.retentionPolicy ?? (input.mode === "ephemeral_task"
        ? { kind: "ttl", expiresAt: new Date(now.getTime() + 60 * 60 * 1_000).toISOString() }
        : { kind: "retain" });
      if (retentionPolicy.kind === "ttl") {
        const expiresAt = Date.parse(retentionPolicy.expiresAt);
        if (!Number.isFinite(expiresAt)
          || expiresAt <= now.getTime()
          || expiresAt - now.getTime() > WORKSPACE_LIMITS.maximumEphemeralTtlMs) {
          throw new WorkspaceStoreError("WORKSPACE_TTL_INVALID", "Ephemeral Workspace TTL is invalid.");
        }
      }
      const workspace: CollaborationWorkspace = {
        schemaVersion: TETI_WORKSPACE_SCHEMA_VERSION,
        workspaceId,
        ownerTetiId: input.ownerTetiId,
        participantTetiIds: [...input.participantTetiIds].sort(),
        revision: 1,
        mode: input.mode,
        quota: structuredClone(input.quota ?? (input.mode === "ephemeral_task"
          ? DEFAULT_EPHEMERAL_WORKSPACE_QUOTA
          : DEFAULT_DURABLE_WORKSPACE_QUOTA)),
        retentionPolicy: structuredClone(retentionPolicy),
        manifest: emptyWorkspaceManifest(),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString()
      };
      validateCollaborationWorkspace(workspace);
      const index = await this.loadIndex();
      if (index.workspaces.some((item) => item.workspaceId === workspace.workspaceId)) {
        throw new WorkspaceStoreError("WORKSPACE_DUPLICATE", "Workspace ID already exists.");
      }
      const revisionPath = this.revisionContentPath(workspace.workspaceId, workspace.revision);
      await mkdir(revisionPath, { recursive: true, mode: 0o700 });
      try {
        index.workspaces.push(workspace);
        await this.saveIndex(index);
      } catch (error) {
        await rm(this.workspaceRoot(workspace.workspaceId), { recursive: true, force: true });
        throw error;
      }
      return clone(workspace);
    });
  }

  get(workspaceId: string): Promise<CollaborationWorkspace | null> {
    return this.exclusive(async () => {
      await this.requireInitialized();
      requireSafeId(workspaceId, "workspaceId");
      const index = await this.loadIndex();
      const workspace = index.workspaces.find((item) => item.workspaceId === workspaceId);
      if (!workspace) return null;
      if (isExpired(workspace, this.now())) {
        await this.removeFromIndex(index, workspace);
        return null;
      }
      return clone(workspace);
    });
  }

  createSnapshot(input: CreateWorkspaceSnapshotInput): Promise<WorkspaceSnapshot> {
    return this.exclusive(async () => {
      await this.requireInitialized();
      requireSafeId(input.workspaceId, "workspaceId");
      validateWorkspaceAccess(input.access);
      const index = await this.loadIndex();
      const workspace = index.workspaces.find((item) => item.workspaceId === input.workspaceId);
      if (!workspace || isExpired(workspace, this.now())) {
        throw new WorkspaceStoreError("WORKSPACE_NOT_FOUND", "Workspace is unavailable.");
      }
      if (workspace.revision !== input.workspaceRevision) {
        throw new WorkspaceStoreError("WORKSPACE_REVISION_CONFLICT", "Workspace revision has changed.");
      }
      const snapshotId = `snapshot:${randomUUID()}`;
      const path = this.snapshotPath(snapshotId);
      await mkdir(path, { recursive: true, mode: 0o700 });
      try {
        await copyTreeNoSymlinks(
          this.revisionContentPath(workspace.workspaceId, workspace.revision),
          path
        );
      } catch (error) {
        await rm(path, { recursive: true, force: true });
        throw error;
      }
      const snapshot: WorkspaceSnapshot = {
        schemaVersion: TETI_WORKSPACE_SNAPSHOT_SCHEMA_VERSION,
        snapshotId,
        workspaceId: workspace.workspaceId,
        workspaceRevision: workspace.revision,
        access: [...input.access],
        snapshotPath: path,
        createdAt: this.now().toISOString()
      };
      this.activeSnapshots.set(snapshotId, { snapshot: clone(snapshot), path });
      return snapshot;
    });
  }

  commitSnapshot(snapshot: WorkspaceSnapshot): Promise<CollaborationWorkspace> {
    return this.exclusive(async () => {
      await this.requireInitialized();
      const active = this.requireActiveSnapshot(snapshot);
      if (!active.snapshot.access.includes("write")
        && !active.snapshot.access.includes("create_artifact")) {
        throw new WorkspaceStoreError("WORKSPACE_ACCESS_DENIED", "Workspace Snapshot is read-only.");
      }
      const index = await this.loadIndex();
      const workspace = index.workspaces.find((item) => item.workspaceId === active.snapshot.workspaceId);
      if (!workspace) throw new WorkspaceStoreError("WORKSPACE_NOT_FOUND", "Workspace is unavailable.");
      if (workspace.revision !== active.snapshot.workspaceRevision) {
        throw new WorkspaceStoreError("WORKSPACE_REVISION_CONFLICT", "Workspace revision has changed.");
      }
      // Bound the source before copying, then derive the authoritative
      // Manifest from the private revision copy to close scan/copy races.
      await scanWorkspaceTree(active.path, workspace.quota, this.now);
      const nextRevision = workspace.revision + 1;
      const revisionsRoot = dirname(dirname(this.revisionContentPath(workspace.workspaceId, nextRevision)));
      const temporaryRevision = join(revisionsRoot, `.revision-${nextRevision}-${randomUUID()}`);
      const temporaryContent = join(temporaryRevision, "content");
      const finalRevision = join(revisionsRoot, String(nextRevision));
      await mkdir(temporaryContent, { recursive: true, mode: 0o700 });
      let revisionPublished = false;
      try {
        await copyTreeNoSymlinks(active.path, temporaryContent);
        const manifest = await scanWorkspaceTree(temporaryContent, workspace.quota, this.now);
        validateWorkspaceManifest(manifest, workspace.quota);
        await rename(temporaryRevision, finalRevision);
        revisionPublished = true;
        workspace.revision = nextRevision;
        workspace.manifest = manifest;
        workspace.updatedAt = this.now().toISOString();
        validateCollaborationWorkspace(workspace);
        await this.saveIndex(index);
      } catch (error) {
        await rm(temporaryRevision, { recursive: true, force: true });
        if (revisionPublished) await rm(finalRevision, { recursive: true, force: true });
        throw error;
      }
      await this.discardActiveSnapshot(active);
      return clone(workspace);
    });
  }

  discardSnapshot(snapshot: WorkspaceSnapshot): Promise<void> {
    return this.exclusive(async () => {
      const active = this.activeSnapshots.get(snapshot.snapshotId);
      if (!active) return;
      if (active.snapshot.workspaceId !== snapshot.workspaceId
        || active.snapshot.workspaceRevision !== snapshot.workspaceRevision
        || resolve(snapshot.snapshotPath) !== active.path) {
        throw new WorkspaceStoreError("WORKSPACE_SNAPSHOT_INVALID", "Workspace Snapshot identity is invalid.");
      }
      await this.discardActiveSnapshot(active);
    });
  }

  cleanup(now = this.now()): Promise<void> {
    return this.exclusive(async () => {
      await this.requireInitialized();
      const index = await this.loadIndex();
      const expired = index.workspaces.filter((workspace) => isExpired(workspace, now));
      if (expired.length === 0) return;
      for (const workspace of expired) {
        await rm(this.workspaceRoot(workspace.workspaceId), { recursive: true, force: true });
      }
      const expiredIds = new Set(expired.map((workspace) => workspace.workspaceId));
      index.workspaces = index.workspaces.filter((workspace) => !expiredIds.has(workspace.workspaceId));
      await this.saveIndex(index);
    });
  }

  private async verifyPersistedWorkspace(workspace: CollaborationWorkspace): Promise<void> {
    validateCollaborationWorkspace(workspace);
    const contentPath = this.revisionContentPath(workspace.workspaceId, workspace.revision);
    const actual = await scanWorkspaceTree(contentPath, workspace.quota, this.now);
    if (!sameManifestContent(actual, workspace.manifest)) {
      throw new WorkspaceStoreError(
        "WORKSPACE_MANIFEST_MISMATCH",
        "Durable Workspace content does not match its committed Manifest."
      );
    }
  }

  private async removeUncommittedRevisions(workspace: CollaborationWorkspace): Promise<void> {
    const revisionsRoot = dirname(dirname(
      this.revisionContentPath(workspace.workspaceId, workspace.revision)
    ));
    for (const entry of await readdir(revisionsRoot, { withFileTypes: true })) {
      const revision = /^\d+$/.test(entry.name) ? Number(entry.name) : null;
      if (entry.name.startsWith(".revision-")
        || (revision !== null && Number.isSafeInteger(revision) && revision > workspace.revision)) {
        await rm(scopedPath(revisionsRoot, entry.name), { recursive: true, force: true });
      }
    }
  }

  private requireActiveSnapshot(snapshot: WorkspaceSnapshot): ActiveSnapshot {
    const active = this.activeSnapshots.get(snapshot.snapshotId);
    if (!active
      || active.snapshot.workspaceId !== snapshot.workspaceId
      || active.snapshot.workspaceRevision !== snapshot.workspaceRevision
      || JSON.stringify(active.snapshot.access) !== JSON.stringify(snapshot.access)
      || resolve(snapshot.snapshotPath) !== active.path) {
      throw new WorkspaceStoreError("WORKSPACE_SNAPSHOT_INVALID", "Workspace Snapshot identity is invalid.");
    }
    return active;
  }

  private async discardActiveSnapshot(active: ActiveSnapshot): Promise<void> {
    this.activeSnapshots.delete(active.snapshot.snapshotId);
    await rm(active.path, { recursive: true, force: true });
  }

  private async removeFromIndex(index: WorkspaceIndex, workspace: CollaborationWorkspace): Promise<void> {
    await rm(this.workspaceRoot(workspace.workspaceId), { recursive: true, force: true });
    index.workspaces = index.workspaces.filter((item) => item.workspaceId !== workspace.workspaceId);
    await this.saveIndex(index);
  }

  private async loadIndex(): Promise<WorkspaceIndex> {
    try {
      const value = JSON.parse(await readFile(this.indexPath, "utf8")) as unknown;
      validateIndex(value);
      return clone(value);
    } catch (error) {
      if (isNotFound(error)) return { schemaVersion: WORKSPACE_INDEX_SCHEMA_VERSION, workspaces: [] };
      throw error;
    }
  }

  private async saveIndex(index: WorkspaceIndex): Promise<void> {
    validateIndex(index);
    await mkdir(dirname(this.indexPath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.indexPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(index, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(temporaryPath, this.indexPath);
    await chmod(this.indexPath, 0o600);
  }

  private workspaceRoot(workspaceId: string): string {
    requireSafeId(workspaceId, "workspaceId");
    return scopedPath(this.workspacesRoot, workspaceId);
  }

  private revisionContentPath(workspaceId: string, revision: number): string {
    if (!Number.isSafeInteger(revision) || revision <= 0) {
      throw new WorkspaceStoreError("WORKSPACE_REVISION_INVALID", "Workspace revision is invalid.");
    }
    return scopedPath(this.workspaceRoot(workspaceId), "revisions", String(revision), "content");
  }

  private snapshotPath(snapshotId: string): string {
    requireSafeId(snapshotId, "snapshotId");
    return scopedPath(this.snapshotsRoot, snapshotId);
  }

  private async requireInitialized(): Promise<void> {
    if (!this.initialized) {
      throw new WorkspaceStoreError("WORKSPACE_STORE_NOT_INITIALIZED", "Workspace Store is not initialized.");
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation);
    this.queue = pending.then(() => undefined, () => undefined);
    return pending;
  }
}

async function scanWorkspaceTree(
  root: string,
  quota: WorkspaceQuota,
  now: () => Date
): Promise<WorkspaceManifest> {
  const entries: WorkspaceManifest["entries"] = [];
  let totalBytes = 0;
  let visitedEntries = 0;
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      visitedEntries += 1;
      if (visitedEntries > WORKSPACE_LIMITS.maximumManifestEntries) {
        throw new WorkspaceStoreError("WORKSPACE_QUOTA_EXCEEDED", "Workspace entry quota is exceeded.");
      }
      const path = join(directory, entry.name);
      const relativePath = relative(root, path).split("\\").join("/");
      validateWorkspaceRelativePath(relativePath);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new WorkspaceStoreError("WORKSPACE_SYMLINK_FORBIDDEN", "Workspace cannot contain symbolic links.");
      }
      if (metadata.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!metadata.isFile()) {
        throw new WorkspaceStoreError("WORKSPACE_FILE_TYPE_FORBIDDEN", "Workspace contains an unsupported file type.");
      }
      if (entries.length + 1 > quota.maxFiles) {
        throw new WorkspaceStoreError("WORKSPACE_QUOTA_EXCEEDED", "Workspace file quota is exceeded.");
      }
      totalBytes += metadata.size;
      if (totalBytes > quota.maxBytes) {
        throw new WorkspaceStoreError("WORKSPACE_QUOTA_EXCEEDED", "Workspace byte quota is exceeded.");
      }
      entries.push({
        relativePath,
        byteLength: metadata.size,
        sha256: `sha256:${await sha256File(path)}`,
        updatedAt: Number.isFinite(metadata.mtimeMs) ? metadata.mtime.toISOString() : now().toISOString()
      });
    }
  }
  await visit(root);
  entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return {
    entries,
    totalBytes,
    totalFiles: entries.length
  };
}

async function copyTreeNoSymlinks(source: string, destination: string): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    const metadata = await lstat(sourcePath);
    if (metadata.isSymbolicLink()) {
      throw new WorkspaceStoreError("WORKSPACE_SYMLINK_FORBIDDEN", "Workspace cannot contain symbolic links.");
    }
    if (metadata.isDirectory()) {
      await mkdir(destinationPath, { mode: 0o700 });
      await copyTreeNoSymlinks(sourcePath, destinationPath);
    } else if (metadata.isFile()) {
      await copyFile(sourcePath, destinationPath);
      await chmod(destinationPath, 0o600);
    } else {
      throw new WorkspaceStoreError("WORKSPACE_FILE_TYPE_FORBIDDEN", "Workspace contains an unsupported file type.");
    }
  }
}

function validateIndex(value: unknown): asserts value is WorkspaceIndex {
  if (!isRecord(value)
    || value.schemaVersion !== WORKSPACE_INDEX_SCHEMA_VERSION
    || !Array.isArray(value.workspaces)
    || Object.keys(value).some((key) => !["schemaVersion", "workspaces"].includes(key))) {
    throw new WorkspaceStoreError("WORKSPACE_INDEX_INVALID", "Workspace index is invalid.");
  }
  const ids = new Set<string>();
  for (const workspace of value.workspaces) {
    validateCollaborationWorkspace(workspace);
    if (ids.has(workspace.workspaceId)) {
      throw new WorkspaceStoreError("WORKSPACE_INDEX_INVALID", "Workspace IDs must be unique.");
    }
    ids.add(workspace.workspaceId);
  }
}

function isExpired(workspace: CollaborationWorkspace, now: Date): boolean {
  return workspace.retentionPolicy.kind === "ttl"
    && Date.parse(workspace.retentionPolicy.expiresAt) <= now.getTime();
}

function sameManifestContent(left: WorkspaceManifest, right: WorkspaceManifest): boolean {
  return left.totalBytes === right.totalBytes
    && left.totalFiles === right.totalFiles
    && left.entries.length === right.entries.length
    && left.entries.every((entry, index) => {
      const candidate = right.entries[index];
      return candidate?.relativePath === entry.relativePath
        && candidate.byteLength === entry.byteLength
        && candidate.sha256 === entry.sha256;
    });
}

function scopedPath(root: string, ...segments: string[]): string {
  const path = resolve(root, ...segments);
  const child = relative(resolve(root), path);
  if (!child || child.startsWith("..") || isAbsolute(child)) {
    throw new WorkspaceStoreError("WORKSPACE_PATH_ESCAPE", "Workspace path escapes its controlled root.");
  }
  return path;
}

function requireSafeId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new WorkspaceStoreError("WORKSPACE_ID_INVALID", `${label} is invalid.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
