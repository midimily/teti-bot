import type { RemoteAiStatusSnapshot } from "../../../../core/ai-status/types.ts";
import type { RuntimePassportSnapshot } from "../../../../core/passport/snapshot.ts";
import type { NetworkIdentityStatus } from "../../../../core/account/model.ts";
import type { AgentManagementSnapshot } from "../../../../core/observation/management.ts";
import type {
  CollaborationTaskSummarySnapshot,
  CollaborationTaskTransportRecord,
  CollaborationTaskTransportSnapshot
} from "../../../../core/task/transport.ts";
import type { TaskImagePart } from "../../../../core/task/types.ts";
import type { ExecutionHandle } from "../../../../core/callability/execution.ts";
import type {
  ChildMemorySnapshot,
  MemoryExportResult
} from "../../../../core/memory/types.ts";
import type { LongHorizonTaskMemorySnapshot } from "../../../../core/memory/structured-task.ts";
import type { LocalReleaseStatus } from "../../../../core/release/policy.ts";
import type { DelegationTargetOption } from "../../../../core/delegation/types.ts";

export const LIFECYCLE_PROTOCOL_VERSION = 1;
export const LIFECYCLE_MAX_LINE_BYTES = 64 * 1024;

export type LifecycleMethod =
  | "lifecycle.health"
  | "release.status"
  | "network.contract.get"
  | "network.environment.get"
  | "network.environment.set"
  | "presence.get"
  | "presence.signal.set"
  | "account.status"
  | "account.load"
  | "account.create"
  | "network.identity.retry"
  | "connection.resolve"
  | "connection.request"
  | "connection.accept"
  | "connection.reject"
  | "task.send"
  | "task.list"
  | "task.summary"
  | "task.get"
  | "task.memory.get"
  | "task.attachment.stage"
  | "task.attachment.resolve"
  | "task.approve"
  | "task.delegation.targets"
  | "task.delegation.approve"
  | "task.reject"
  | "task.cancel"
  | "task.execution.get"
  | "task.execution.resume"
  | "task.input.submit"
  | "task.pause"
  | "task.continue"
  | "task.complete"
  | "task.renew"
  | "memory.get"
  | "memory.authorization.set"
  | "memory.task.save"
  | "memory.delete"
  | "memory.export"
  | "passport.get"
  | "passport.sharing.set"
  | "agent.observation.get"
  | "agent.observation.scan"
  | "agent.observation.override.set"
  | "osaurus.native.get"
  | "osaurus.native.set";

export const LIFECYCLE_METHODS: readonly LifecycleMethod[] = [
  "lifecycle.health",
  "release.status",
  "network.contract.get",
  "network.environment.get",
  "network.environment.set",
  "presence.get",
  "presence.signal.set",
  "account.status",
  "account.load",
  "account.create",
  "network.identity.retry",
  "connection.resolve",
  "connection.request",
  "connection.accept",
  "connection.reject",
  "task.send",
  "task.list",
  "task.summary",
  "task.get",
  "task.memory.get",
  "task.attachment.stage",
  "task.attachment.resolve",
  "task.approve",
  "task.delegation.targets",
  "task.delegation.approve",
  "task.reject",
  "task.cancel",
  "task.execution.get",
  "task.execution.resume",
  "task.input.submit",
  "task.pause",
  "task.continue",
  "task.complete",
  "task.renew",
  "memory.get",
  "memory.authorization.set",
  "memory.task.save",
  "memory.delete",
  "memory.export",
  "passport.get",
  "passport.sharing.set",
  "agent.observation.get",
  "agent.observation.scan",
  "agent.observation.override.set",
  "osaurus.native.get",
  "osaurus.native.set"
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
  | LocalReleaseStatus
  | LifecycleStatusResult
  | PublicTetiAccount
  | PublicTetiIdentity
  | PeerConnectionResult
  | RuntimePassportSnapshot
  | AgentManagementSnapshot
  | CollaborationTaskTransportRecord
  | CollaborationTaskTransportSnapshot
  | CollaborationTaskSummarySnapshot
  | StagedTaskImageDto
  | ResolvedTaskImageDto
  | ExecutionHandle
  | DelegationTargetOption[]
  | ChildMemorySnapshot
  | LongHorizonTaskMemorySnapshot
  | MemoryExportResult
  | OsaurusNativeChildSettingsDto
  | TetiNetworkEnvironmentSettingsDto
  | RuntimeNetworkContractStatusDto
  | RuntimePresenceStatusDto
  | boolean
  | null;

export interface OsaurusNativeChildSettingsDto {
  schemaVersion: 1;
  agentId: string | null;
  readiness: "unconfigured" | "checking" | "ready" | "blocked";
  reasonCode?: string;
}

export interface TetiNetworkEnvironmentSettingsDto {
  schemaVersion: 1;
  useLocalDevelopmentNetwork: boolean;
  activeEnvironment: "production" | "local_development";
  activeBaseUrl: string;
  configuredEnvironment: "production" | "local_development";
  configuredBaseUrl: string;
  restartRequired: boolean;
}

export type RuntimeNetworkContractStatusDto =
  | { state: "disabled" | "checking" }
  | {
      state: "compatible";
      checkedAt: string;
      protocolVersion: number;
      contractRevision: number;
      serviceVersion: string;
    }
  | {
      state: "unavailable" | "incompatible";
      checkedAt: string;
      errorCode: string;
      retryable: boolean;
      requestId?: string;
    };

export interface RuntimePresenceStatusDto {
  schemaVersion: 1;
  state: "stopped" | "sleeping" | "checking" | "online" | "unavailable";
  mode: "collaborating" | "viewing_connect" | "online" | "background";
  sessionId: string;
  sequence: number;
  foreground: boolean;
  panelVisible: boolean;
  collaborationActive: boolean;
  lastReportedAt?: string;
  nextReportAt?: string;
  errorCode?: string;
}

export interface StagedTaskImageDto {
  part: TaskImagePart;
  path: string;
  safeFileName: string;
}

export interface ResolvedTaskImageDto {
  attachmentId: string;
  path: string;
}

export interface LifecycleHealthResult {
  status: "ok";
  protocolVersion: 1;
  methods: readonly LifecycleMethod[];
}

export interface LifecycleStatusResult {
  exists: boolean;
  networkIdentity: NetworkIdentityStatus;
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
  remoteProtocolCapabilities?: {
    collaborationProtocolEpoch: number;
    taskProtocolVersions?: number[];
    passportSchemaVersions?: number[];
    observedAt: string;
  };
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
  diagnosticCode?: string;
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
  | "NETWORK_IDENTITY_FAILED"
  | "CONNECTION_RESOLVE_FAILED"
  | "CONNECTION_REQUEST_FAILED"
  | "TASK_TRANSPORT_FAILED"
  | "MEMORY_OPERATION_FAILED"
  | "APP_UPDATE_REQUIRED"
  | "SIDECAR_UNAVAILABLE"
  | "REQUEST_TIMEOUT"
  | "INTERNAL_ERROR";

export const LIFECYCLE_TIMEOUT_MS: Record<LifecycleMethod, number> = {
  "lifecycle.health": 2_000,
  "release.status": 2_000,
  "network.contract.get": 2_000,
  "network.environment.get": 2_000,
  "network.environment.set": 5_000,
  "presence.get": 2_000,
  "presence.signal.set": 2_000,
  "account.status": 5_000,
  "account.load": 5_000,
  "account.create": 120_000,
  "network.identity.retry": 30_000,
  "connection.resolve": 15_000,
  "connection.request": 30_000,
  "connection.accept": 30_000,
  "connection.reject": 30_000,
  "task.send": 30_000,
  "task.list": 2_000,
  "task.summary": 2_000,
  "task.get": 2_000,
  "task.memory.get": 2_000,
  "task.attachment.stage": 10_000,
  "task.attachment.resolve": 2_000,
  "task.approve": 10_000,
  "task.delegation.targets": 2_000,
  "task.delegation.approve": 10_000,
  "task.reject": 10_000,
  "task.cancel": 10_000,
  "task.execution.get": 2_000,
  "task.execution.resume": 10_000,
  "task.input.submit": 10_000,
  "task.pause": 10_000,
  "task.continue": 10_000,
  "task.complete": 10_000,
  "task.renew": 10_000,
  "memory.get": 2_000,
  "memory.authorization.set": 5_000,
  "memory.task.save": 5_000,
  "memory.delete": 5_000,
  "memory.export": 10_000,
  "passport.get": 2_000,
  "passport.sharing.set": 5_000,
  "agent.observation.get": 2_000,
  "agent.observation.scan": 10_000,
  "agent.observation.override.set": 10_000,
  "osaurus.native.get": 2_000,
  "osaurus.native.set": 5_000
};

export function isLifecycleMethod(value: unknown): value is LifecycleMethod {
  return typeof value === "string" && LIFECYCLE_METHODS.includes(value as LifecycleMethod);
}
