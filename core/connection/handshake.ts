import type { TetiIdentity } from "../../services/discovery/types.ts";
import type { ConnectionMessagingAdapter } from "../../integrations/chatmail/connection-messaging.ts";
import type { TetiAccountStorage } from "../account/storage.ts";
import {
  createConnectionAccept,
  createConnectionReject,
  createConnectionRequest,
  validateConnectionRequest
} from "./protocol.ts";
import type { TetiConnectionStorage } from "./storage.ts";
import {
  TETI_CONNECTION_VERSION,
  TetiConnectionState,
  type TetiConnectionAccept,
  type TetiConnectionRecord,
  type TetiConnectionReject,
  type TetiConnectionRequest
} from "./types.ts";

export interface TetiConnectionHandshakeOptions {
  accountStorage: TetiAccountStorage;
  connectionStorage: TetiConnectionStorage;
  messagingAdapter: ConnectionMessagingAdapter;
  requestIdFactory?: () => string;
  nonceFactory?: () => string;
  now?: () => string;
}

export async function createHandshakeRequest(
  remoteIdentity: TetiIdentity,
  options: TetiConnectionHandshakeOptions
): Promise<TetiConnectionRecord> {
  const account = await requireLocalAccount(options);
  const timestamp = now(options);
  const request = createConnectionRequest({
    localAccount: account,
    requestId: options.requestIdFactory?.(),
    nonce: options.nonceFactory?.(),
    createdAt: timestamp
  });

  await options.messagingAdapter.sendConnectionRequest({
    accountId: account.chatmailAccountId,
    toAddress: remoteIdentity.address,
    toPublicKey: remoteIdentity.publicKey,
    request
  });

  const record: TetiConnectionRecord = {
    version: TETI_CONNECTION_VERSION,
    requestId: request.requestId,
    state: TetiConnectionState.Requested,
    direction: "outgoing",
    remoteTetiId: remoteIdentity.id,
    remoteAddress: remoteIdentity.address,
    request,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  await options.connectionStorage.upsert(record);
  return record;
}

export async function handleIncomingRequest(
  request: TetiConnectionRequest,
  options: TetiConnectionHandshakeOptions
): Promise<TetiConnectionRecord> {
  validateConnectionRequest(request);

  const connections = await options.connectionStorage.loadAll();
  const existing = connections.find((connection) => connection.requestId === request.requestId);
  if (existing) {
    return existing;
  }

  const confirmedPeer = connections.find(
    (connection) =>
      connection.state === TetiConnectionState.Confirmed &&
      connection.remoteTetiId === request.fromTetiId
  );
  if (confirmedPeer) {
    return confirmedPeer;
  }

  const timestamp = now(options);
  const record: TetiConnectionRecord = {
    version: TETI_CONNECTION_VERSION,
    requestId: request.requestId,
    state: TetiConnectionState.PendingApproval,
    direction: "incoming",
    remoteTetiId: request.fromTetiId,
    remoteAddress: request.fromAddress,
    request,
    createdAt: request.createdAt,
    updatedAt: timestamp
  };
  await options.connectionStorage.upsert(record);
  return record;
}

export async function acceptConnection(
  requestId: string,
  options: TetiConnectionHandshakeOptions
): Promise<TetiConnectionRecord> {
  requireRequestId(requestId);
  const account = await requireLocalAccount(options);
  const existing = await requireConnection(options.connectionStorage, requestId);
  if (existing.state !== TetiConnectionState.PendingApproval) {
    throw new Error(`Teti connection request ${requestId} is not pending approval.`);
  }

  const acceptedAt = now(options);
  await options.connectionStorage.update(requestId, {
    state: TetiConnectionState.Accepted,
    updatedAt: acceptedAt,
    acceptedAt
  });

  const accept = createConnectionAccept({
    localAccount: account,
    requestId,
    nonce: options.nonceFactory?.(),
    createdAt: acceptedAt
  });
  await options.messagingAdapter.sendConnectionAccept({
    accountId: account.chatmailAccountId,
    toAddress: existing.remoteAddress,
    toPublicKey: existing.request.publicKey,
    accept
  });

  const confirmedAt = now(options);
  return confirmPeerConnection(options.connectionStorage, requestId, {
    state: TetiConnectionState.Confirmed,
    updatedAt: confirmedAt,
    confirmedAt
  });
}

export async function rejectConnection(
  requestId: string,
  options: TetiConnectionHandshakeOptions,
  reason?: string
): Promise<TetiConnectionRecord> {
  requireRequestId(requestId);
  const account = await requireLocalAccount(options);
  const existing = await requireConnection(options.connectionStorage, requestId);
  const reject = createConnectionReject({ requestId, reason });

  await options.messagingAdapter.sendConnectionReject({
    accountId: account.chatmailAccountId,
    toAddress: existing.remoteAddress,
    toPublicKey: existing.request.publicKey,
    reject
  });

  const rejectedAt = now(options);
  return options.connectionStorage.update(requestId, {
    state: TetiConnectionState.Rejected,
    updatedAt: rejectedAt,
    rejectedAt
  });
}

export async function handleAccept(
  accept: TetiConnectionAccept,
  options: TetiConnectionHandshakeOptions
): Promise<TetiConnectionRecord> {
  requireRequestId(accept.requestId);
  const existing = await requireConnection(options.connectionStorage, accept.requestId);
  if (existing.state !== TetiConnectionState.Requested && existing.state !== TetiConnectionState.Accepted) {
    throw new Error(`Teti connection request ${accept.requestId} cannot be confirmed.`);
  }

  const confirmedAt = accept.createdAt || now(options);
  return confirmPeerConnection(options.connectionStorage, accept.requestId, {
    state: TetiConnectionState.Confirmed,
    remoteTetiId: accept.fromTetiId || existing.remoteTetiId,
    remoteAddress: accept.fromAddress || existing.remoteAddress,
    updatedAt: confirmedAt,
    confirmedAt
  });
}

export async function handleReject(
  reject: TetiConnectionReject,
  options: TetiConnectionHandshakeOptions
): Promise<TetiConnectionRecord> {
  requireRequestId(reject.requestId);
  await requireConnection(options.connectionStorage, reject.requestId);
  const rejectedAt = now(options);
  return options.connectionStorage.update(reject.requestId, {
    state: TetiConnectionState.Rejected,
    updatedAt: rejectedAt,
    rejectedAt
  });
}

export async function reconcileConfirmedPeerConnections(
  storage: TetiConnectionStorage
): Promise<TetiConnectionRecord[]> {
  const connections = await storage.loadAll();
  const canonicalByPeer = new Map<string, TetiConnectionRecord>();

  for (const connection of connections) {
    if (connection.state !== TetiConnectionState.Confirmed) continue;
    const canonical = canonicalByPeer.get(connection.remoteTetiId);
    if (!canonical || connection.requestId.localeCompare(canonical.requestId) < 0) {
      canonicalByPeer.set(connection.remoteTetiId, connection);
    }
  }

  const reconciled = connections.filter((connection) => {
    const canonical = canonicalByPeer.get(connection.remoteTetiId);
    return !canonical || connection.requestId === canonical.requestId;
  });
  if (reconciled.length !== connections.length) {
    await storage.saveAll(reconciled);
  }
  return reconciled;
}

async function requireLocalAccount(options: TetiConnectionHandshakeOptions) {
  const account = await options.accountStorage.load();
  if (!account) {
    throw new Error("A local Teti account is required before creating connections.");
  }

  return account;
}

async function findConnection(
  storage: TetiConnectionStorage,
  requestId: string
): Promise<TetiConnectionRecord | null> {
  return (await storage.loadAll()).find((connection) => connection.requestId === requestId) ?? null;
}

async function requireConnection(
  storage: TetiConnectionStorage,
  requestId: string
): Promise<TetiConnectionRecord> {
  const connection = await findConnection(storage, requestId);
  if (!connection) {
    throw new Error(`Teti connection request ${requestId} does not exist.`);
  }

  return connection;
}

async function confirmPeerConnection(
  storage: TetiConnectionStorage,
  requestId: string,
  patch: Partial<TetiConnectionRecord>
): Promise<TetiConnectionRecord> {
  const connections = await storage.loadAll();
  const existingIndex = connections.findIndex((connection) => connection.requestId === requestId);
  if (existingIndex === -1) {
    throw new Error(`Teti connection request ${requestId} does not exist.`);
  }

  const existing = connections[existingIndex];
  const confirmed: TetiConnectionRecord = {
    ...existing,
    ...patch,
    requestId
  };
  const peerIds = new Set([existing.remoteTetiId, confirmed.remoteTetiId]);
  const canonicalConnections = connections
    .map((connection, index) => (index === existingIndex ? confirmed : connection))
    .filter((connection) => connection.requestId === requestId || !peerIds.has(connection.remoteTetiId));

  await storage.saveAll(canonicalConnections);
  return confirmed;
}

function requireRequestId(requestId: string): void {
  if (typeof requestId !== "string" || !requestId.trim()) {
    throw new Error("Teti connection requestId is required.");
  }
}

function now(options: TetiConnectionHandshakeOptions): string {
  return options.now?.() ?? new Date().toISOString();
}
