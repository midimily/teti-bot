import { createHash } from "node:crypto";
import type { TetiAccount } from "../../../../../core/account/model.ts";
import type { TetiPublicProfile } from "../../../../../core/account/model.ts";
import {
  TETI_CONNECTION_VERSION,
  isTetiConnectionArchived,
  TetiConnectionState,
  type TetiConnectionRecord
} from "../../../../../core/connection/types.ts";
import type { TetiIdentity } from "../../../../../services/discovery/types.ts";
import type { TetiNetworkRelationshipDocument } from "../../../../../services/network/types.ts";

export interface RuntimeRelationshipProjection {
  archived: boolean;
  state?: TetiConnectionRecord["state"];
  direction: TetiConnectionRecord["direction"];
}

export function projectNetworkRelationship(
  document: TetiNetworkRelationshipDocument
): RuntimeRelationshipProjection {
  const direction = document.direction;
  switch (document.state) {
    case "requested":
      return {
        archived: false,
        state: direction === "outgoing"
          ? TetiConnectionState.Requested
          : TetiConnectionState.PendingApproval,
        direction
      };
    case "confirmed":
      return { archived: false, state: TetiConnectionState.Confirmed, direction };
    case "rejected":
      return { archived: false, state: TetiConnectionState.Rejected, direction };
    case "blocked":
      return { archived: false, state: TetiConnectionState.Blocked, direction };
    case "revoked":
      return { archived: true, direction };
  }
}

export function projectNetworkRelationshipRecovery(input: {
  document: TetiNetworkRelationshipDocument;
  localAccount: TetiAccount;
  remoteIdentity: TetiIdentity;
  existing?: TetiConnectionRecord;
}): TetiConnectionRecord | null {
  const { document, localAccount, remoteIdentity, existing } = input;
  const projection = projectNetworkRelationship(document);
  const networkRelationship = {
    schemaVersion: 1 as const,
    id: document.id,
    revision: document.revision,
    state: document.state,
    etag: `"relationship-r${document.revision}"` as const,
    blockedBy: document.blockedBy,
    stateChangedAt: document.stateChangedAt,
    documentFingerprint: networkRelationshipDocumentFingerprint(document)
  };
  if (projection.archived) {
    return existing ? {
      ...existing,
      requestId: document.id,
      direction: projection.direction,
      remoteTetiId: remoteIdentity.id,
      remoteAddress: remoteIdentity.address,
      ...(remoteIdentity.publicKey ? { remotePublicKey: remoteIdentity.publicKey } : {}),
      updatedAt: document.updatedAt,
      networkRelationship
    } : null;
  }

  const requestSender = document.direction === "outgoing"
    ? {
        id: localAccount.id,
        address: localAccount.address,
        publicKey: localAccount.publicKey,
        profile: localAccount.publicProfile
      }
    : {
        id: remoteIdentity.id,
        address: remoteIdentity.address,
        publicKey: remoteIdentity.publicKey,
        profile: remoteIdentity.publicProfile
      };
  return {
    version: TETI_CONNECTION_VERSION,
    requestId: document.id,
    state: projection.state!,
    direction: projection.direction,
    remoteTetiId: remoteIdentity.id,
    remoteAddress: remoteIdentity.address,
    ...(remoteIdentity.publicKey ? { remotePublicKey: remoteIdentity.publicKey } : {}),
    request: {
      version: TETI_CONNECTION_VERSION,
      requestId: document.id,
      fromTetiId: requestSender.id,
      fromAddress: requestSender.address,
      ...(requestSender.publicKey ? { publicKey: requestSender.publicKey } : {}),
      profile: normalizeRecoveryProfile(requestSender.profile),
      createdAt: document.createdAt,
      nonce: `network:${document.id}`
    },
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    ...(document.state === "confirmed" ? { confirmedAt: document.stateChangedAt } : {}),
    ...(document.state === "rejected" ? { rejectedAt: document.stateChangedAt } : {}),
    networkRelationship
  };
}

function normalizeRecoveryProfile(profile: {
  platform?: string;
  category?: string[];
  aiEnvironment?: string[];
}): TetiPublicProfile {
  return {
    platform: profile.platform ?? "unknown",
    category: [...(profile.category ?? [])],
    aiEnvironment: [...(profile.aiEnvironment ?? [])]
  };
}

export function isArchivedNetworkRelationship(connection: TetiConnectionRecord): boolean {
  return isTetiConnectionArchived(connection);
}

export function networkRelationshipDocumentFingerprint(
  document: TetiNetworkRelationshipDocument
): string {
  const canonical = JSON.stringify({
    schemaVersion: document.schemaVersion,
    id: document.id,
    revision: document.revision,
    state: document.state,
    peerTetiId: document.peerTetiId,
    requesterTetiId: document.requesterTetiId,
    addresseeTetiId: document.addresseeTetiId,
    direction: document.direction,
    blockedBy: document.blockedBy,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    stateChangedAt: document.stateChangedAt
  });
  return createHash("sha256").update(canonical, "utf8").digest("base64url");
}
