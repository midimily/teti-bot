export const TETI_WORKSPACE_SCHEMA_VERSION = 1;
export const TETI_WORKSPACE_SNAPSHOT_SCHEMA_VERSION = 1;

export const WORKSPACE_LIMITS = {
  maximumParticipants: 16,
  maximumManifestEntries: 16_384,
  maximumBytes: 2 * 1024 * 1024 * 1024,
  maximumFiles: 16_384,
  maximumRelativePathBytes: 1_024,
  maximumEphemeralTtlMs: 24 * 60 * 60 * 1_000
} as const;

export const DEFAULT_EPHEMERAL_WORKSPACE_QUOTA: WorkspaceQuota = {
  maxBytes: 64 * 1024 * 1024,
  maxFiles: 512
};

export const DEFAULT_DURABLE_WORKSPACE_QUOTA: WorkspaceQuota = {
  maxBytes: 512 * 1024 * 1024,
  maxFiles: 4_096
};

export type WorkspaceMode = "ephemeral_task" | "durable_collaboration";
export type WorkspaceAccess = "read" | "write" | "create_artifact";

export interface WorkspaceQuota {
  maxBytes: number;
  maxFiles: number;
}

export type WorkspaceRetentionPolicy =
  | { kind: "ttl"; expiresAt: string }
  | { kind: "retain" };

export interface WorkspaceManifestEntry {
  relativePath: string;
  byteLength: number;
  sha256: string;
  updatedAt: string;
}

export interface WorkspaceManifest {
  entries: WorkspaceManifestEntry[];
  totalBytes: number;
  totalFiles: number;
}

export interface CollaborationWorkspace {
  schemaVersion: 1;
  workspaceId: string;
  ownerTetiId: string;
  participantTetiIds: string[];
  revision: number;
  mode: WorkspaceMode;
  quota: WorkspaceQuota;
  retentionPolicy: WorkspaceRetentionPolicy;
  manifest: WorkspaceManifest;
  createdAt: string;
  updatedAt: string;
}

/** Network-safe Task request. A path is intentionally not representable. */
export type TaskWorkspaceRequest =
  | {
      kind: "temporary";
      access: WorkspaceAccess[];
    }
  | {
      kind: "reference";
      workspaceId: string;
      workspaceRevision: number;
      access: WorkspaceAccess[];
    };

/** Local-only binding persisted with the receiving Task record. */
export interface TaskWorkspaceBinding {
  workspaceId: string;
  workspaceRevision: number;
  mode: WorkspaceMode;
  access: WorkspaceAccess[];
}

/** Local-only execution copy. snapshotPath never enters Task, Passport, or Grant. */
export interface WorkspaceSnapshot {
  schemaVersion: 1;
  snapshotId: string;
  workspaceId: string;
  workspaceRevision: number;
  access: WorkspaceAccess[];
  snapshotPath: string;
  createdAt: string;
}

export function emptyWorkspaceManifest(): WorkspaceManifest {
  return { entries: [], totalBytes: 0, totalFiles: 0 };
}
