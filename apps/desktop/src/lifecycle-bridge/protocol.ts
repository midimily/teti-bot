import type { RemoteAiStatusSnapshot } from "../../../../core/ai-status/types.ts";
import type { RuntimePassportSnapshot } from "../../../../core/passport/snapshot.ts";

export const LIFECYCLE_PROTOCOL_VERSION = 1;
export const LIFECYCLE_MAX_LINE_BYTES = 64 * 1024;

export type LifecycleMethod =
  | "lifecycle.health"
  | "account.status"
  | "account.load"
  | "account.create"
  | "discovery.register"
  | "discovery.retry"
  | "discovery.heartbeat"
  | "connection.resolve"
  | "connection.request"
  | "connection.accept"
  | "connection.reject"
  | "passport.get"
  | "passport.sharing.set";

export const LIFECYCLE_METHODS: readonly LifecycleMethod[] = [
  "lifecycle.health",
  "account.status",
  "account.load",
  "account.create",
  "discovery.register",
  "discovery.retry",
  "discovery.heartbeat",
  "connection.resolve",
  "connection.request",
  "connection.accept",
  "connection.reject",
  "passport.get",
  "passport.sharing.set"
];

export interface LifecycleRequest {
  version: 1;
  id: string;
  method: LifecycleMethod;
  params?: Record<string, unknown>;
}

export type LifecycleResponse =
  | {
      version: 1;
      id: string | null;
      ok: true;
      result: LifecycleResult;
    }
  | {
      version: 1;
      id: string | null;
      ok: false;
      error: LifecycleErrorDto;
    };

export type LifecycleResult =
  | LifecycleHealthResult
  | LifecycleStatusResult
  | PublicTetiAccount
  | PublicTetiIdentity
  | PeerConnectionResult
  | RuntimePassportSnapshot
  | null;

export interface LifecycleHealthResult {
  status: "ok";
  protocolVersion: 1;
  methods: readonly LifecycleMethod[];
}

export interface LifecycleStatusResult {
  exists: boolean;
  registered: boolean;
  onlineStatus: "unknown" | "offline" | "online";
  account?: PublicTetiAccount;
}

export interface PublicTetiAccount {
  version: 1;
  id: string;
  address: string;
  displayName?: string;
  chatmailAccountId: number;
  publicKey?: string;
  fingerprint?: string;
  publicProfile: Record<string, unknown>;
  createdAt: string;
}

export interface PublicTetiIdentity {
  id: string;
  address: string;
  displayName?: string;
  publicKey?: string;
  publicProfile: Record<string, unknown>;
}

export interface PeerConnectionDto {
  requestId: string;
  state: "Requested" | "PendingApproval" | "Accepted" | "Confirmed" | "Rejected" | "Blocked";
  direction: "incoming" | "outgoing";
  remoteTetiId: string;
  remoteAddress: string;
  remoteDisplayName?: string;
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string;
  lastHeartbeatSentAt?: string;
  lastHeartbeatReceivedAt?: string;
  remoteAiStatus?: RemoteAiStatusSnapshot;
}

export interface PeerConnectionResult {
  connections: PeerConnectionDto[];
  receivedCount: number;
  heartbeatCount: number;
  aiStatusCount?: number;
  requestOutcome?: PeerConnectionRequestOutcome;
}

export interface PeerConnectionRequestOutcome {
  kind:
    | "created"
    | "alreadyRequested"
    | "approvalRequired"
    | "confirming"
    | "mutualConfirmed"
    | "alreadyConfirmed"
    | "blocked";
  requestId: string;
  remoteTetiId: string;
}

export interface LifecycleErrorDto {
  code: LifecycleErrorCode;
  message: string;
  recoverable: boolean;
  retryTarget?: LifecycleMethod;
}

export type LifecycleErrorCode =
  | "UNSUPPORTED_PROTOCOL_VERSION"
  | "MALFORMED_REQUEST"
  | "UNKNOWN_METHOD"
  | "DUPLICATE_REQUEST"
  | "OVERSIZED_REQUEST"
  | "INVALID_NAME"
  | "ACCOUNT_LOAD_FAILED"
  | "ACCOUNT_ALREADY_EXISTS"
  | "ACCOUNT_CREATE_FAILED"
  | "DISCOVERY_REGISTRATION_FAILED"
  | "DISCOVERY_HEARTBEAT_FAILED"
  | "CONNECTION_RESOLVE_FAILED"
  | "CONNECTION_REQUEST_FAILED"
  | "SIDECAR_UNAVAILABLE"
  | "REQUEST_TIMEOUT"
  | "INTERNAL_ERROR";

export const LIFECYCLE_TIMEOUT_MS: Record<LifecycleMethod, number> = {
  "lifecycle.health": 2_000,
  "account.status": 5_000,
  "account.load": 5_000,
  "account.create": 120_000,
  "discovery.register": 15_000,
  "discovery.retry": 15_000,
  "discovery.heartbeat": 30_000,
  "connection.resolve": 15_000,
  "connection.request": 30_000,
  "connection.accept": 30_000,
  "connection.reject": 30_000,
  "passport.get": 2_000,
  "passport.sharing.set": 5_000
};

export function isLifecycleMethod(value: unknown): value is LifecycleMethod {
  return typeof value === "string" && LIFECYCLE_METHODS.includes(value as LifecycleMethod);
}
