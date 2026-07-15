import { TetiConnectionManager, type TetiConnectionManagerOptions } from "./manager.ts";
import type { TetiIdentity } from "../../services/discovery/types.ts";
import type {
  TetiConnectionAccept,
  TetiConnectionRecord,
  TetiConnectionReject
} from "./types.ts";

export async function createRequest(
  remoteIdentity: TetiIdentity,
  options: TetiConnectionManagerOptions = {}
): Promise<TetiConnectionRecord> {
  return new TetiConnectionManager(options).createRequest(remoteIdentity);
}

export async function receiveRequests(
  options: TetiConnectionManagerOptions = {}
): Promise<TetiConnectionRecord[]> {
  return new TetiConnectionManager(options).receiveRequests();
}

export async function receiveEvents(
  options: TetiConnectionManagerOptions = {}
): Promise<TetiConnectionRecord[]> {
  return new TetiConnectionManager(options).receiveEvents();
}

export async function acceptRequest(
  requestId: string,
  options: TetiConnectionManagerOptions = {}
): Promise<TetiConnectionRecord> {
  return new TetiConnectionManager(options).acceptRequest(requestId);
}

export async function rejectRequest(
  requestId: string,
  options: TetiConnectionManagerOptions = {}
): Promise<TetiConnectionRecord> {
  return new TetiConnectionManager(options).rejectRequest(requestId);
}

export async function handleAccept(
  accept: TetiConnectionAccept,
  options: TetiConnectionManagerOptions = {}
): Promise<TetiConnectionRecord> {
  return new TetiConnectionManager(options).handleAccept(accept);
}

export async function handleReject(
  reject: TetiConnectionReject,
  options: TetiConnectionManagerOptions = {}
): Promise<TetiConnectionRecord> {
  return new TetiConnectionManager(options).handleReject(reject);
}

export async function listConnections(
  options: TetiConnectionManagerOptions = {}
): Promise<TetiConnectionRecord[]> {
  return new TetiConnectionManager(options).listConnections();
}

export { TetiConnectionManager };
export type { TetiConnectionManagerOptions };
