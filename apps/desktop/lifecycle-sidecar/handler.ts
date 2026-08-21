import type { TetiAccount, TetiStatus } from "../../../core/account/model.ts";
import {
  InvalidDisplayNameError,
  validateTetiDisplayName
} from "../../../core/account/display-name.ts";
import { TetiAccountManager } from "../../../core/account/manager.ts";
import {
  LIFECYCLE_MAX_LINE_BYTES,
  LIFECYCLE_METHODS,
  LIFECYCLE_PROTOCOL_VERSION,
  isLifecycleMethod,
  type LifecycleRequest,
  type LifecycleResponse,
  type LifecycleResult,
  type LifecycleStatusResult,
  type OsaurusNativeChildSettingsDto,
  type TetiNetworkEnvironmentSettingsDto,
  type RuntimeNetworkContractStatusDto,
  type RuntimePresenceStatusDto,
  type PublicTetiAccount
} from "../src/lifecycle-bridge/protocol.ts";
import { isUnsafeIncompleteMarker, readCreationMarker, writeCreationMarker } from "./marker.ts";
import { manifestFromAccount, writeManifest } from "./manifest.ts";
import {
  createProfiledAccountManager,
  ensureProfileDirectories,
  resolveTetiProfile,
  validateAuthorizedProvisioningProfile
} from "./profile.ts";
import { createLifecycleError, sanitizeUnknownError } from "./security.ts";
import {
  type PeerConnectionService
} from "./connections.ts";
import type { RuntimePassportSnapshot } from "../../../core/passport/snapshot.ts";
import type { PassportSharingPolicy } from "../../../core/passport/types.ts";
import type { AgentManagementSnapshot } from "../../../core/observation/management.ts";
import { validatePolicy } from "./runtime/passport/sharing.ts";
import { writeRuntimeDiagnostic } from "./diagnostics.ts";
import {
  DEFAULT_TASK_REQUEST_TTL_MS,
  type SendCollaborationTaskInput
} from "../../../core/task/transport.ts";
import { MAX_TASK_INPUT_TEXT_BYTES, MAX_TASK_REQUEST_TTL_MS } from "../../../core/task/types.ts";
import { validateTaskImagePart } from "../../../core/task/validation.ts";
import { validateTaskWorkspaceRequest } from "../../../core/workspace/validation.ts";
import type {
  ChildMemorySnapshot,
  DurableMemoryScope,
  MemoryExportResult
} from "../../../core/memory/types.ts";
import {
  STRUCTURED_MEMORY_CONTEXT_LIMITS,
  type StructuredMemoryKind,
  type StructuredMemoryScope
} from "../../../core/memory/context-injection.ts";
import type { LocalReleaseStatus } from "../../../core/release/policy.ts";
import type { DelegationTargetSelection } from "../../../core/delegation/types.ts";
import { isSafeAbsoluteLocalPath } from "../../../core/application/local-path.ts";

export interface LifecycleSidecarDependencies {
  loadTetiAccount(): Promise<TetiAccount | null>;
  createTetiAccount(input: { name: string }): Promise<TetiAccount>;
  getTetiStatus(): Promise<TetiStatus>;
  synchronizeNetworkIdentity(): Promise<TetiAccount>;
  onNetworkIdentitySynchronized?(account: TetiAccount): Promise<void>;
  getPeerConnectionService(): Promise<PeerConnectionService>;
  getLocalReleaseStatus?(): Promise<LocalReleaseStatus> | LocalReleaseStatus;
  getPassportSnapshot?(): Promise<RuntimePassportSnapshot>;
  setPassportSharing?(policy: PassportSharingPolicy): Promise<RuntimePassportSnapshot>;
  getAgentManagementSnapshot?(): Promise<AgentManagementSnapshot>;
  rescanAgents?(): Promise<AgentManagementSnapshot>;
  setAgentPathOverride?(agentId: string, path: string | null): Promise<AgentManagementSnapshot>;
  getChildMemory?(): Promise<ChildMemorySnapshot>;
  setChildMemoryAuthorization?(input: {
    scope: DurableMemoryScope;
    workspaceId: string | null;
    childAgentId: string;
    enabled: boolean;
  }): Promise<ChildMemorySnapshot>;
  saveTaskMemory?(taskId: string, scope: DurableMemoryScope, confirmed: true): Promise<ChildMemorySnapshot>;
  deleteChildMemory?(memoryId: string): Promise<boolean>;
  exportChildMemory?(): Promise<MemoryExportResult>;
  getOsaurusNativeChildSettings?(): Promise<OsaurusNativeChildSettingsDto>;
  setOsaurusNativeChildAgentId?(agentId: string | null): Promise<OsaurusNativeChildSettingsDto>;
  getNetworkEnvironmentSettings?(): Promise<TetiNetworkEnvironmentSettingsDto> | TetiNetworkEnvironmentSettingsDto;
  getNetworkContractStatus?(): RuntimeNetworkContractStatusDto;
  setLocalDevelopmentNetwork?(enabled: boolean): Promise<TetiNetworkEnvironmentSettingsDto>;
  getPresenceStatus?(): RuntimePresenceStatusDto | undefined;
  setPresenceSignal?(input: {
    signal: "sleeping" | "foreground" | "panel_visible";
    active: boolean;
  }): void;
}

export const defaultLifecycleSidecarDependencies: LifecycleSidecarDependencies = {
  loadTetiAccount: async () => {
    const account = await (await getDefaultAccountManager()).loadTetiAccount();
    if (account) await backfillCreationMarkerIdentity(account);
    return account;
  },
  createTetiAccount: async (input) => createGuardedRealTetiAccount(input),
  getTetiStatus: async () => (await getDefaultAccountManager()).getTetiStatus(),
  synchronizeNetworkIdentity: async () => {
    throw new Error("Network identity synchronization is unavailable before Runtime startup.");
  },
  onNetworkIdentitySynchronized: markNetworkIdentitySynchronizationComplete,
  getPeerConnectionService: async () => {
    throw new Error("Peer Network composition is unavailable before Runtime startup.");
  }
};

export async function handleLifecycleRequest(
  request: unknown,
  dependencies: LifecycleSidecarDependencies = defaultLifecycleSidecarDependencies
): Promise<LifecycleResponse> {
  const validation = validateLifecycleRequest(request);
  if (!validation.ok) {
    return failure(validation.id, validation.error);
  }

  const id = validation.request.id;
  try {
    const result = await dispatchLifecycleRequest(validation.request, dependencies);
    return {
      version: LIFECYCLE_PROTOCOL_VERSION,
      id,
      ok: true,
      result
    };
  } catch (error) {
    if (error instanceof LocalAppUpdateRequiredError) {
      const releaseError = createLifecycleError(
        "APP_UPDATE_REQUIRED",
        "This Teti Beta build is no longer supported. Install the current version to continue.",
        { recoverable: false }
      );
      releaseError.diagnosticCode = "RELEASE-UPDATE-REQUIRED";
      return failure(id, releaseError);
    }
    return failure(id, sanitizeUnknownError(error, fallbackCodeForMethod(validation.request.method)));
  }
}

export async function handleLifecycleLine(
  line: string,
  dependencies: LifecycleSidecarDependencies = defaultLifecycleSidecarDependencies
): Promise<LifecycleResponse> {
  if (Buffer.byteLength(line, "utf8") > LIFECYCLE_MAX_LINE_BYTES) {
    return failure(
      null,
      createLifecycleError("OVERSIZED_REQUEST", "Lifecycle request is too large.", { recoverable: false })
    );
  }

  try {
    return await handleLifecycleRequest(JSON.parse(line), dependencies);
  } catch {
    return failure(
      null,
      createLifecycleError("MALFORMED_REQUEST", "Lifecycle request must be valid JSON.", { recoverable: false })
    );
  }
}

async function dispatchLifecycleRequest(
  request: LifecycleRequest,
  dependencies: LifecycleSidecarDependencies
): Promise<LifecycleResult> {
  if (!isReleaseLockExemptMethod(request.method)) {
    const release = await dependencies.getLocalReleaseStatus?.();
    if (release?.state === "update_required") {
      throw new LocalAppUpdateRequiredError(release.currentVersion);
    }
  }
  switch (request.method) {
    case "lifecycle.health":
      return {
        status: "ok",
        protocolVersion: LIFECYCLE_PROTOCOL_VERSION,
        methods: LIFECYCLE_METHODS
      };

    case "release.status":
      return dependencies.getLocalReleaseStatus
        ? await dependencies.getLocalReleaseStatus()
        : {
            schemaVersion: 1,
            state: "temporarily_unavailable",
            currentVersion: "unknown",
            buildTimestamp: "unknown",
            source: "none",
            diagnosticCode: "RELEASE_POLICY_UNAVAILABLE"
          };

    case "network.contract.get":
      return dependencies.getNetworkContractStatus?.() ?? { state: "checking" };

    case "network.environment.get":
      if (!dependencies.getNetworkEnvironmentSettings) {
        throw new Error("Teti Network environment settings are unavailable.");
      }
      return dependencies.getNetworkEnvironmentSettings();

    case "network.environment.set":
      if (!dependencies.setLocalDevelopmentNetwork) {
        throw new Error("Teti Network environment settings are unavailable.");
      }
      return dependencies.setLocalDevelopmentNetwork(
        validateBoolean(request.params?.enabled, "Network development setting")
      );

    case "presence.get":
      return dependencies.getPresenceStatus?.() ?? null;

    case "presence.signal.set": {
      const signal = request.params?.signal;
      if (signal !== "sleeping" && signal !== "foreground" && signal !== "panel_visible") {
        throw new Error("Presence signal is invalid.");
      }
      dependencies.setPresenceSignal?.({
        signal,
        active: validateBoolean(request.params?.active, "Presence signal")
      });
      return dependencies.getPresenceStatus?.() ?? null;
    }

    case "account.status":
      return statusToDto(await dependencies.getTetiStatus(), await dependencies.loadTetiAccount());

    case "account.load":
      return publicAccountOrNull(await dependencies.loadTetiAccount());

    case "account.create": {
      const name = validateName(request.params?.name);
      return publicAccount(await dependencies.createTetiAccount({ name }));
    }

    case "network.identity.retry": {
      const account = await dependencies.synchronizeNetworkIdentity();
      return statusToDto(await dependencies.getTetiStatus(), account);
    }

    case "connection.resolve":
      return (await dependencies.getPeerConnectionService()).resolve(validateConnectionQuery(request.params?.query));

    case "connection.request":
      return (await dependencies.getPeerConnectionService()).request(validateConnectionQuery(request.params?.query));

    case "connection.accept":
      return (await dependencies.getPeerConnectionService()).accept(validateRequestId(request.params?.requestId));

    case "connection.reject":
      return (await dependencies.getPeerConnectionService()).reject(validateRequestId(request.params?.requestId));

    case "task.send": {
      const service = await dependencies.getPeerConnectionService();
      if (!service.sendTask) throw new Error("Task transport is unavailable.");
      return service.sendTask(validateTaskSendInput(request.params));
    }

    case "task.list": {
      const service = await dependencies.getPeerConnectionService();
      if (!service.listTasks) throw new Error("Task transport is unavailable.");
      const snapshot = await service.listTasks();
      const limit = validateTaskListLimit(request.params?.limit);
      return { ...snapshot, records: snapshot.records.slice(0, limit) };
    }

    case "task.summary": {
      const service = await dependencies.getPeerConnectionService();
      if (!service.listTaskSummaries) throw new Error("Task summary service is unavailable.");
      return service.listTaskSummaries();
    }

    case "task.get": {
      const service = await dependencies.getPeerConnectionService();
      if (!service.getTask) throw new Error("Task detail service is unavailable.");
      return service.getTask(validateTaskId(request.params?.taskId));
    }

    case "task.memory.get": {
      const service = await dependencies.getPeerConnectionService();
      if (!service.getLongHorizonTaskMemory) throw new Error("Structured task memory is unavailable.");
      return service.getLongHorizonTaskMemory(validateTaskId(request.params?.taskId));
    }

    case "task.memory.source.get": {
      const params = validateParameterFields(request.params, ["taskId", "sourceMemoryId"]);
      const service = await dependencies.getPeerConnectionService();
      if (!service.getStructuredMemorySourceDraft) throw new Error("Structured Memory source is unavailable.");
      return service.getStructuredMemorySourceDraft(
        validateTaskId(params.taskId),
        validateMemoryId(params.sourceMemoryId)
      );
    }

    case "task.memory.item.get": {
      const params = validateParameterFields(request.params, ["taskId", "memoryId"]);
      const service = await dependencies.getPeerConnectionService();
      if (!service.getStructuredMemoryItem) throw new Error("Structured Memory item is unavailable.");
      return service.getStructuredMemoryItem(
        validateTaskId(params.taskId),
        validateMemoryId(params.memoryId)
      );
    }

    case "task.memory.item.create": {
      const service = await dependencies.getPeerConnectionService();
      if (!service.createStructuredMemoryItem) throw new Error("Structured Memory creation is unavailable.");
      return service.createStructuredMemoryItem(validateStructuredMemoryItemMutation(request.params, false));
    }

    case "task.memory.item.update": {
      const service = await dependencies.getPeerConnectionService();
      if (!service.updateStructuredMemoryItem) throw new Error("Structured Memory update is unavailable.");
      return service.updateStructuredMemoryItem(validateStructuredMemoryItemMutation(request.params, true));
    }

    case "task.memory.item.delete": {
      const params = validateParameterFields(request.params, ["taskId", "memoryId", "confirmed"]);
      const service = await dependencies.getPeerConnectionService();
      if (!service.deleteStructuredMemoryItem) throw new Error("Structured Memory deletion is unavailable.");
      return service.deleteStructuredMemoryItem(
        validateTaskId(params.taskId),
        validateMemoryId(params.memoryId),
        validateExplicitMemoryConfirmation(params.confirmed)
      );
    }

    case "task.memory.authorization.set": {
      const params = validateParameterFields(request.params, ["taskId", "childAgentId", "scope", "enabled"]);
      const service = await dependencies.getPeerConnectionService();
      if (!service.setStructuredMemoryAuthorization) throw new Error("Structured Memory authorization is unavailable.");
      return service.setStructuredMemoryAuthorization({
        taskId: validateTaskId(params.taskId),
        childAgentId: validateChildAgentId(params.childAgentId),
        scope: validateStructuredMemoryAuthorizationScope(params.scope),
        enabled: validateBoolean(params.enabled, "Structured Memory authorization")
      });
    }

    case "task.memory.preview": {
      const params = validateParameterFields(
        request.params,
        ["taskId", "childAgentId", "excludedMemoryIds"]
      );
      const service = await dependencies.getPeerConnectionService();
      if (!service.previewStructuredMemory) throw new Error("Structured Memory preview is unavailable.");
      return service.previewStructuredMemory({
        taskId: validateTaskId(params.taskId),
        ...(params.childAgentId === undefined
          ? {}
          : { childAgentId: validateChildAgentId(params.childAgentId) }),
        excludedMemoryIds: validateStructuredMemoryExclusions(params.excludedMemoryIds)
      });
    }

    case "task.memory.preview.approve": {
      const params = validateParameterFields(request.params, ["taskId", "previewId"]);
      const service = await dependencies.getPeerConnectionService();
      if (!service.approveStructuredMemoryPreview) throw new Error("Structured Memory preview approval is unavailable.");
      return service.approveStructuredMemoryPreview(
        validateTaskId(params.taskId),
        validateMemoryId(params.previewId)
      );
    }

    case "task.attachment.stage": {
      const service = await dependencies.getPeerConnectionService();
      if (!service.stageTaskImage) throw new Error("Task image staging is unavailable.");
      return service.stageTaskImage(validateAbsoluteTaskImagePath(request.params?.path));
    }

    case "task.attachment.resolve": {
      const service = await dependencies.getPeerConnectionService();
      if (!service.resolveTaskImage) throw new Error("Task image resolution is unavailable.");
      return {
        attachmentId: validateTaskId(request.params?.attachmentId),
        path: await service.resolveTaskImage(
          validateTaskId(request.params?.taskId),
          validateTaskId(request.params?.attachmentId)
        )
      };
    }

    case "task.approve": {
      const service = await dependencies.getPeerConnectionService();
      if (!service.approveTask) throw new Error("Task approval is unavailable.");
      return service.approveTask(validateTaskId(request.params?.taskId));
    }

    case "task.delegation.targets": {
      const service = await dependencies.getPeerConnectionService();
      if (!service.listTaskDelegationTargets) throw new Error("Delegation target discovery is unavailable.");
      return service.listTaskDelegationTargets(validateTaskId(request.params?.taskId));
    }

    case "task.delegation.approve": {
      const service = await dependencies.getPeerConnectionService();
      if (!service.approveTaskDelegation) throw new Error("Delegation approval is unavailable.");
      return service.approveTaskDelegation(
        validateTaskId(request.params?.taskId),
        validateDelegationSelections(request.params?.selections)
      );
    }

    case "task.reject": {
      const service = await dependencies.getPeerConnectionService();
      if (!service.rejectTask) throw new Error("Task rejection is unavailable.");
      return service.rejectTask(validateTaskId(request.params?.taskId));
    }

    case "task.cancel": {
      const service = await dependencies.getPeerConnectionService();
      if (!service.cancelTask) throw new Error("Task cancellation is unavailable.");
      return service.cancelTask(validateTaskId(request.params?.taskId));
    }

    case "task.execution.get": {
      const service = await dependencies.getPeerConnectionService();
      if (!service.getTaskExecution) throw new Error("Durable execution is unavailable.");
      return service.getTaskExecution(validateTaskId(request.params?.taskId));
    }

    case "task.execution.resume": {
      const service = await dependencies.getPeerConnectionService();
      if (!service.resumeTask) throw new Error("Durable execution resume is unavailable.");
      return service.resumeTask(validateTaskId(request.params?.taskId));
    }

    case "task.input.submit": {
      const service = await dependencies.getPeerConnectionService();
      if (!service.submitTaskInput) throw new Error("Long-horizon Task input is unavailable.");
      return service.submitTaskInput(
        validateTaskId(request.params?.taskId),
        validateTaskInstruction(request.params?.instruction)
      );
    }

    case "task.pause": {
      const service = await dependencies.getPeerConnectionService();
      if (!service.pauseTask) throw new Error("Long-horizon Task pause is unavailable.");
      return service.pauseTask(validateTaskId(request.params?.taskId));
    }

    case "task.continue": {
      const service = await dependencies.getPeerConnectionService();
      if (!service.continueTask) throw new Error("Long-horizon Task continuation is unavailable.");
      const childAgentId = request.params?.childAgentId === undefined
        ? undefined
        : validateChildAgentId(request.params.childAgentId);
      return service.continueTask(validateTaskId(request.params?.taskId), childAgentId);
    }

    case "task.complete": {
      const service = await dependencies.getPeerConnectionService();
      if (!service.completeTask) throw new Error("Long-horizon Task completion is unavailable.");
      return service.completeTask(validateTaskId(request.params?.taskId));
    }

    case "task.renew": {
      const service = await dependencies.getPeerConnectionService();
      if (!service.renewTask) throw new Error("Long-horizon Task renewal is unavailable.");
      return service.renewTask(
        validateTaskId(request.params?.taskId),
        validateTaskRenewal(request.params?.ttlMs)
      );
    }

    case "memory.get":
      if (!dependencies.getChildMemory) throw new Error("Child Memory service is unavailable.");
      return dependencies.getChildMemory();

    case "memory.authorization.set": {
      if (!dependencies.setChildMemoryAuthorization) throw new Error("Child Memory service is unavailable.");
      const scope = validateDurableMemoryScope(request.params?.scope);
      return dependencies.setChildMemoryAuthorization({
        scope,
        workspaceId: validateMemoryWorkspaceId(scope, request.params?.workspaceId),
        childAgentId: validateChildAgentId(request.params?.childAgentId),
        enabled: validateBoolean(request.params?.enabled, "Memory authorization state")
      });
    }

    case "memory.task.save":
      if (!dependencies.saveTaskMemory) throw new Error("Child Memory service is unavailable.");
      return dependencies.saveTaskMemory(
        validateTaskId(request.params?.taskId),
        validateDurableMemoryScope(request.params?.scope),
        validateExplicitMemoryConfirmation(request.params?.confirmed)
      );

    case "memory.delete":
      if (!dependencies.deleteChildMemory) throw new Error("Child Memory service is unavailable.");
      return dependencies.deleteChildMemory(validateMemoryId(request.params?.memoryId));

    case "memory.export":
      if (!dependencies.exportChildMemory) throw new Error("Child Memory service is unavailable.");
      return dependencies.exportChildMemory();

    case "passport.get":
      if (!dependencies.getPassportSnapshot) throw new Error("Runtime Passport service is unavailable.");
      return await dependencies.getPassportSnapshot();

    case "passport.sharing.set":
      if (!dependencies.setPassportSharing) throw new Error("Runtime Passport service is unavailable.");
      return await dependencies.setPassportSharing(validatePolicy(request.params?.policy));

    case "agent.observation.get":
      if (!dependencies.getAgentManagementSnapshot) throw new Error("Agent management is unavailable.");
      return await dependencies.getAgentManagementSnapshot();

    case "agent.observation.scan":
      if (!dependencies.rescanAgents) throw new Error("Agent management is unavailable.");
      return await dependencies.rescanAgents();

    case "agent.observation.override.set":
      if (!dependencies.setAgentPathOverride) throw new Error("Agent management is unavailable.");
      return await dependencies.setAgentPathOverride(
        validateAgentId(request.params?.agentId),
        validateAgentPathOverride(request.params?.path)
      );

    case "osaurus.native.get":
      if (!dependencies.getOsaurusNativeChildSettings) throw new Error("Osaurus Native Child settings are unavailable.");
      return dependencies.getOsaurusNativeChildSettings();

    case "osaurus.native.set":
      if (!dependencies.setOsaurusNativeChildAgentId) throw new Error("Osaurus Native Child settings are unavailable.");
      return dependencies.setOsaurusNativeChildAgentId(validateOsaurusNativeAgentId(request.params?.agentId));
  }
}

class LocalAppUpdateRequiredError extends Error {
  readonly currentVersion: string;

  constructor(currentVersion: string) {
    super(`Teti ${currentVersion} is below the supported Beta version floor.`);
    this.name = "LocalAppUpdateRequiredError";
    this.currentVersion = currentVersion;
  }
}

function isReleaseLockExemptMethod(method: LifecycleRequest["method"]): boolean {
  return method === "lifecycle.health"
    || method === "release.status"
    || method === "account.load"
    || method === "account.status";
}

function validateLifecycleRequest(
  request: unknown
):
  | { ok: true; request: LifecycleRequest }
  | { ok: false; id: string | null; error: ReturnType<typeof createLifecycleError> } {
  const id = readRequestId(request);
  if (typeof request !== "object" || request === null) {
    return {
      ok: false,
      id,
      error: createLifecycleError("MALFORMED_REQUEST", "Lifecycle request must be an object.", { recoverable: false })
    };
  }

  const record = request as Record<string, unknown>;
  if (record.version !== LIFECYCLE_PROTOCOL_VERSION) {
    return {
      ok: false,
      id,
      error: createLifecycleError("UNSUPPORTED_PROTOCOL_VERSION", "Unsupported lifecycle protocol version.", {
        recoverable: false
      })
    };
  }

  if (typeof record.id !== "string" || record.id.trim().length === 0 || record.id.length > 120) {
    return {
      ok: false,
      id,
      error: createLifecycleError("MALFORMED_REQUEST", "Lifecycle request id is invalid.", { recoverable: false })
    };
  }

  if (!isLifecycleMethod(record.method)) {
    return {
      ok: false,
      id: record.id,
      error: createLifecycleError("UNKNOWN_METHOD", "Lifecycle method is not allowed.", { recoverable: false })
    };
  }

  if (record.params !== undefined && (typeof record.params !== "object" || record.params === null)) {
    return {
      ok: false,
      id: record.id,
      error: createLifecycleError("MALFORMED_REQUEST", "Lifecycle params must be an object.", { recoverable: false })
    };
  }

  return {
    ok: true,
    request: {
      version: LIFECYCLE_PROTOCOL_VERSION,
      id: record.id,
      method: record.method,
      params: (record.params ?? {}) as Record<string, unknown>
    }
  };
}

function validateName(value: unknown): string {
  if (typeof value !== "string") {
    throw new InvalidDisplayNameError("empty");
  }

  const validation = validateTetiDisplayName(value);
  if (!validation.ok) throw new InvalidDisplayNameError(validation.reason);
  return validation.value;
}

function validateConnectionQuery(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 32) {
    throw new Error("Enter the 9-character Teti ID shown on teti.bot.");
  }
  return value.trim();
}

function validateRequestId(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 120) {
    throw new Error("A valid connection request ID is required.");
  }
  return value.trim();
}

function validateTaskSendInput(value: unknown): SendCollaborationTaskInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Task parameters are required.");
  }
  const params = value as Record<string, unknown>;
  const allowed = [
    "connectionRequestId",
    "taskId",
    "offerId",
    "capabilityId",
    "text",
    "attachments",
    "workspace",
    "ttlMs",
    "executionMode"
  ];
  if (Object.keys(params).some((key) => !allowed.includes(key))) {
    throw new Error("Task parameters contain an unsupported field.");
  }
  const connectionRequestId = validateRequestId(params.connectionRequestId);
  if (params.taskId !== undefined
    && (typeof params.taskId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(params.taskId))) {
    throw new Error("Task ID is invalid.");
  }
  if (params.offerId !== undefined
    && (typeof params.offerId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(params.offerId))) {
    throw new Error("Task offer ID is invalid.");
  }
  if (typeof params.capabilityId !== "string"
    || params.capabilityId.length > 128
    || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(params.capabilityId)) {
    throw new Error("Task Capability ID is invalid.");
  }
  if (typeof params.text !== "string" || !params.text.trim()
    || Buffer.byteLength(params.text, "utf8") > MAX_TASK_INPUT_TEXT_BYTES) {
    throw new Error("Task text is invalid or too large.");
  }
  const ttlMs = params.ttlMs ?? DEFAULT_TASK_REQUEST_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || Number(ttlMs) <= 0 || Number(ttlMs) > MAX_TASK_REQUEST_TTL_MS) {
    throw new Error("Task TTL is invalid.");
  }
  const attachments = params.attachments ?? [];
  if (!Array.isArray(attachments) || attachments.length > 4) {
    throw new Error("Task attachments are invalid.");
  }
  for (const attachment of attachments) validateTaskImagePart(attachment);
  if (params.workspace !== undefined) validateTaskWorkspaceRequest(params.workspace);
  const executionMode = params.executionMode ?? "single_stage";
  if (executionMode !== "single_stage" && executionMode !== "long_horizon") {
    throw new Error("Task execution mode is invalid.");
  }
  return {
    connectionRequestId,
    capabilityId: params.capabilityId,
    text: params.text,
    attachments: structuredClone(attachments),
    ...(params.workspace === undefined ? {} : { workspace: structuredClone(params.workspace) }),
    ttlMs: Number(ttlMs),
    executionMode,
    ...(params.taskId === undefined ? {} : { taskId: params.taskId }),
    ...(params.offerId === undefined ? {} : { offerId: params.offerId })
  };
}

function validateTaskInstruction(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > 8 * 1024) {
    throw new Error("Task supplemental instruction is invalid or too large.");
  }
  return value.trim();
}

function validateTaskRenewal(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 60_000 || Number(value) > 24 * 60 * 60 * 1_000) {
    throw new Error("Task renewal is invalid.");
  }
  return Number(value);
}

function validateTaskId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error("Task ID is invalid.");
  }
  return value;
}

function validateParameterFields(
  value: unknown,
  allowed: readonly string[]
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Lifecycle parameters are required.");
  }
  const params = value as Record<string, unknown>;
  if (Object.keys(params).some((key) => !allowed.includes(key))) {
    throw new Error("Lifecycle parameters contain an unsupported field.");
  }
  return params;
}

function validateStructuredMemoryItemMutation(
  value: unknown,
  update: false
): {
  taskId: string;
  sourceMemoryId: string;
  scope: StructuredMemoryScope;
  kind: StructuredMemoryKind;
  title: string;
  content: string;
  pinned: boolean;
  expiresAt: string | null;
  confirmed: true;
};
function validateStructuredMemoryItemMutation(
  value: unknown,
  update: true
): {
  taskId: string;
  memoryId: string;
  expectedVersion: number;
  scope: StructuredMemoryScope;
  kind: StructuredMemoryKind;
  title: string;
  content: string;
  pinned: boolean;
  expiresAt: string | null;
  confirmed: true;
};
function validateStructuredMemoryItemMutation(value: unknown, update: boolean) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Structured Memory parameters are required.");
  }
  const params = value as Record<string, unknown>;
  const allowed = update
    ? ["taskId", "memoryId", "expectedVersion", "scope", "kind", "title", "content", "pinned", "expiresAt", "confirmed"]
    : ["taskId", "sourceMemoryId", "scope", "kind", "title", "content", "pinned", "expiresAt", "confirmed"];
  if (Object.keys(params).some((key) => !allowed.includes(key))) {
    throw new Error("Structured Memory parameters contain an unsupported field.");
  }
  const common = {
    taskId: validateTaskId(params.taskId),
    scope: validateStructuredMemoryScope(params.scope),
    kind: validateStructuredMemoryKind(params.kind),
    title: validateStructuredMemoryTitle(params.title),
    content: validateStructuredMemoryContent(params.content),
    pinned: validateBoolean(params.pinned, "Structured Memory pin state"),
    expiresAt: validateOptionalTimestamp(params.expiresAt, "Structured Memory expiry"),
    confirmed: validateExplicitMemoryConfirmation(params.confirmed)
  };
  if (!update) return { ...common, sourceMemoryId: validateMemoryId(params.sourceMemoryId) };
  if (!Number.isSafeInteger(params.expectedVersion) || Number(params.expectedVersion) < 1) {
    throw new Error("Structured Memory version is invalid.");
  }
  return {
    ...common,
    memoryId: validateMemoryId(params.memoryId),
    expectedVersion: Number(params.expectedVersion)
  };
}

function validateOptionalTimestamp(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} is invalid.`);
  }
  return new Date(value).toISOString();
}

function validateStructuredMemoryScope(value: unknown): StructuredMemoryScope {
  if (value !== "task" && value !== "workspace" && value !== "peer") {
    throw new Error("Structured Memory scope is invalid.");
  }
  return value;
}

function validateStructuredMemoryAuthorizationScope(value: unknown): "workspace" | "peer" {
  if (value !== "workspace" && value !== "peer") {
    throw new Error("Structured Memory authorization scope is invalid.");
  }
  return value;
}

function validateStructuredMemoryKind(value: unknown): StructuredMemoryKind {
  if (value !== "decision" && value !== "constraint" && value !== "fact"
    && value !== "open_question" && value !== "handoff" && value !== "summary"
    && value !== "local_note") {
    throw new Error("Structured Memory kind is invalid.");
  }
  return value;
}

function validateStructuredMemoryTitle(value: unknown): string {
  if (typeof value !== "string" || !value.trim()
    || [...value.trim()].length > STRUCTURED_MEMORY_CONTEXT_LIMITS.maximumTitleCharacters) {
    throw new Error("Structured Memory title is invalid.");
  }
  return value.trim();
}

function validateStructuredMemoryContent(value: unknown): string {
  if (typeof value !== "string" || !value.trim()
    || Buffer.byteLength(value.trim(), "utf8") > STRUCTURED_MEMORY_CONTEXT_LIMITS.maximumContentBytes) {
    throw new Error("Structured Memory content is invalid or too large.");
  }
  return value.trim();
}

function validateStructuredMemoryExclusions(value: unknown): string[] {
  if (!Array.isArray(value)
    || value.length > STRUCTURED_MEMORY_CONTEXT_LIMITS.maximumPreviewCandidates) {
    throw new Error("Structured Memory exclusions are invalid.");
  }
  const exclusions = value.map(validateMemoryId);
  if (new Set(exclusions).size !== exclusions.length) {
    throw new Error("Structured Memory exclusions are invalid.");
  }
  return exclusions;
}

function validateDelegationSelections(value: unknown): DelegationTargetSelection[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) {
    throw new Error("Delegation requires one to four Child Agent selections.");
  }
  return value.map((raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error("Delegation target selection is invalid.");
    }
    const selection = raw as Record<string, unknown>;
    const expected = ["childAgentId", "connectorId", "capabilityId"];
    if (Object.keys(selection).length !== expected.length
      || Object.keys(selection).some((key) => !expected.includes(key))
      || ![selection.childAgentId, selection.connectorId, selection.capabilityId].every((item) =>
        typeof item === "string"
        && item.length <= 128
        && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(item))) {
      throw new Error("Delegation target selection is invalid.");
    }
    return {
      childAgentId: selection.childAgentId as string,
      connectorId: selection.connectorId as string,
      capabilityId: selection.capabilityId as string
    };
  });
}

function validateAbsoluteTaskImagePath(value: unknown): string {
  if (!isSafeAbsoluteLocalPath(value)) {
    throw new Error("Task image path is invalid.");
  }
  return value;
}

function validateTaskListLimit(value: unknown): number {
  if (value === undefined) return 1;
  if (value !== 1) {
    throw new Error("Task list limit must be 1.");
  }
  return 1;
}

function validateAgentId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value) || value.length > 64) {
    throw new Error("A valid built-in Agent ID is required.");
  }
  return value;
}

function validateAgentPathOverride(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 1_024) {
    throw new Error("A valid local Agent path is required.");
  }
  return value;
}

function validateOsaurusNativeAgentId(value: unknown): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("A valid fixed Osaurus Agent UUID is required.");
  }
  return value.toUpperCase();
}

function validateDurableMemoryScope(value: unknown): DurableMemoryScope {
  if (value !== "workspace" && value !== "child_agent") {
    throw new Error("A durable Memory scope is required.");
  }
  return value;
}

function validateMemoryWorkspaceId(scope: DurableMemoryScope, value: unknown): string | null {
  if (scope === "child_agent") {
    if (value !== null) throw new Error("Child Agent Memory must not include a Workspace ID.");
    return null;
  }
  return validateMemoryId(value);
}

function validateChildAgentId(value: unknown): string {
  if (typeof value !== "string"
    || value.length > 64
    || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value)) {
    throw new Error("Child Agent ID is invalid.");
  }
  return value;
}

function validateMemoryId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value)) {
    throw new Error("Memory identifier is invalid.");
  }
  return value;
}

function validateBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} is invalid.`);
  return value;
}

function validateExplicitMemoryConfirmation(value: unknown): true {
  if (value !== true) throw new Error("Saving durable Memory requires explicit local confirmation.");
  return true;
}

function statusToDto(status: TetiStatus, account: TetiAccount | null): LifecycleStatusResult {
  const result: LifecycleStatusResult = {
    exists: status.exists,
    networkIdentity: { ...status.networkIdentity },
    onlineStatus: status.onlineStatus
  };

  if (account) {
    result.account = publicAccount(account);
  }

  return result;
}

function publicAccountOrNull(account: TetiAccount | null): PublicTetiAccount | null {
  return account ? publicAccount(account) : null;
}

function publicAccount(account: TetiAccount): PublicTetiAccount {
  const dto: PublicTetiAccount = {
    version: 1,
    id: account.id,
    address: account.address,
    chatmailAccountId: account.chatmailAccountId,
    publicProfile: account.publicProfile as unknown as Record<string, unknown>,
    createdAt: account.createdAt
  };

  if (account.displayName) {
    dto.displayName = account.displayName;
  }
  if (account.publicKey) {
    dto.publicKey = account.publicKey;
  }
  if (account.fingerprint) {
    dto.fingerprint = account.fingerprint;
  }

  return dto;
}

function fallbackCodeForMethod(method: LifecycleRequest["method"]) {
  switch (method) {
    case "account.create":
      return "ACCOUNT_CREATE_FAILED";
    case "network.environment.get":
    case "network.contract.get":
    case "network.environment.set":
    case "presence.get":
    case "presence.signal.set":
      return "INTERNAL_ERROR";
    case "network.identity.retry":
      return "NETWORK_IDENTITY_FAILED";
    case "connection.resolve":
      return "CONNECTION_RESOLVE_FAILED";
    case "connection.request":
    case "connection.accept":
    case "connection.reject":
      return "CONNECTION_REQUEST_FAILED";
    case "task.send":
    case "task.list":
    case "task.summary":
    case "task.get":
    case "task.memory.get":
    case "task.memory.source.get":
    case "task.memory.item.get":
    case "task.memory.item.create":
    case "task.memory.item.update":
    case "task.memory.item.delete":
    case "task.memory.authorization.set":
    case "task.memory.preview":
    case "task.memory.preview.approve":
    case "task.attachment.stage":
    case "task.attachment.resolve":
    case "task.approve":
    case "task.delegation.targets":
    case "task.delegation.approve":
    case "task.reject":
    case "task.cancel":
    case "task.execution.get":
    case "task.execution.resume":
    case "task.input.submit":
    case "task.pause":
    case "task.continue":
    case "task.complete":
    case "task.renew":
      return "TASK_TRANSPORT_FAILED";
    case "memory.get":
    case "memory.authorization.set":
    case "memory.task.save":
    case "memory.delete":
    case "memory.export":
      return "MEMORY_OPERATION_FAILED";
    case "account.load":
    case "account.status":
      return "ACCOUNT_LOAD_FAILED";
    case "passport.get":
    case "passport.sharing.set":
    case "agent.observation.get":
    case "agent.observation.scan":
    case "agent.observation.override.set":
    case "osaurus.native.get":
    case "osaurus.native.set":
      return "INTERNAL_ERROR";
    default:
      return "INTERNAL_ERROR";
  }
}

function readRequestId(request: unknown): string | null {
  if (typeof request === "object" && request !== null && typeof (request as Record<string, unknown>).id === "string") {
    return (request as Record<string, string>).id;
  }

  return null;
}

function failure(id: string | null, error: ReturnType<typeof createLifecycleError>): LifecycleResponse {
  return {
    version: LIFECYCLE_PROTOCOL_VERSION,
    id,
    ok: false,
    error
  };
}

let accountCreationInFlight: Promise<TetiAccount> | null = null;

export interface GuardedTetiAccountCreationOptions {
  resolveAccountProvisioning?(): Promise<{
    accountQr: string;
    expectedAddressSuffix: string;
  }>;
}

export async function createGuardedRealTetiAccount(
  input: { name: string },
  options: GuardedTetiAccountCreationOptions = {}
): Promise<TetiAccount> {
  if (accountCreationInFlight) return accountCreationInFlight;
  const creation = performGuardedRealTetiAccountCreation(input, options);
  accountCreationInFlight = creation;
  try {
    return await creation;
  } finally {
    if (accountCreationInFlight === creation) accountCreationInFlight = null;
  }
}

async function performGuardedRealTetiAccountCreation(
  input: { name: string },
  options: GuardedTetiAccountCreationOptions
): Promise<TetiAccount> {
  const report = await validateAuthorizedProvisioningProfile();
  if (!report.ok || !report.profile) {
    throw new Error(report.errors.map((error) => error.message).join(" "));
  }

  const profile = report.profile;
  await ensureProfileDirectories(profile);
  const existing = await createProfiledAccountManager(profile).loadTetiAccount();
  if (existing) {
    throw new Error("A Teti account already exists locally. Refusing duplicate creation.");
  }
  if (!options.resolveAccountProvisioning) {
    throw new Error("Teti Network Relay provisioning authority is unavailable.");
  }
  const accountProvisioning = await options.resolveAccountProvisioning();
  const startedAt = new Date().toISOString();
  const transaction: {
    stage: "provisioning" | "identity_created" | "persisting" | "persisted" | "complete";
    account?: TetiAccount;
  } = { stage: "provisioning" };
  const manager = createProfiledAccountManager(profile, {
    accountProvisioning,
    onCreationStage: async (stage, account) => {
      transaction.stage = stage;
      transaction.account = account;
      try {
        await writeCreationMarker(profile, {
          stage,
          startedAt,
          publicTetiId: account?.id,
          publicAddress: account?.address
        });
      } catch (error) {
        if (stage !== "persisted" && stage !== "complete") throw error;
        writeRuntimeDiagnostic("account.local_metadata", {
          result: "failed_after_account_save",
          stage,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  });
  const marker = await readCreationMarker(profile);
  if (isUnsafeIncompleteMarker(marker)) {
    throw new Error(`Unsafe incomplete creation marker found at stage ${marker?.stage}.`);
  }

  await writeCreationMarker(profile, {
    stage: "provisioning",
    startedAt
  });

  try {
    const account = await manager.createTetiAccount({
      ...input,
      chatmailQr: accountProvisioning.accountQr
    });
    try {
      await writeCreationMarker(profile, {
        stage: "complete",
        startedAt,
        completedAt: new Date().toISOString(),
        publicTetiId: account.id,
        publicAddress: account.address
      });
      await writeManifest(profile, manifestFromAccount(profile, publicAccount(account)));
    } catch (error) {
      writeRuntimeDiagnostic("account.local_metadata", {
        result: "failed_after_account_save",
        stage: "complete",
        message: error instanceof Error ? error.message : String(error)
      });
    }
    writeRuntimeDiagnostic("account.create", {
      result: "local_ready"
    });
    return account;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const diagnostic = readProvisioningDiagnostic(error);
    writeRuntimeDiagnostic("account.create", {
      result: "failed",
      code: diagnostic.code,
      stage: diagnostic.stage
    });
    await writeCreationMarker(profile, {
      stage: /storage|persist|write|rename|EACCES|EPERM|ENOSPC/i.test(message) ? "failed_fatal" : "failed_recoverable",
      startedAt,
      publicTetiId: transaction.account?.id,
      publicAddress: transaction.account?.address,
      errorCode: diagnostic.code ?? "ACCOUNT_CREATE_FAILED",
      errorMessage: message.slice(0, 180),
      failureDomain: diagnostic.code?.startsWith("CM_") ? "chatmail" : "local",
      failureStage: diagnostic.stage
    });
    throw error;
  }
}

function readProvisioningDiagnostic(error: unknown): { code?: string; stage?: string } {
  if (typeof error !== "object" || error === null) return {};
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  const stage = "stage" in error && typeof error.stage === "string" ? error.stage : undefined;
  return { code, stage };
}

async function markNetworkIdentitySynchronizationComplete(account: TetiAccount): Promise<void> {
  const profile = await resolveTetiProfile();
  await ensureProfileDirectories(profile);
  const marker = await readCreationMarker(profile);
  await writeCreationMarker(profile, {
    stage: "complete",
    startedAt: marker?.startedAt,
    completedAt: new Date().toISOString(),
    publicTetiId: account.id,
    publicAddress: account.address
  });
  await writeManifest(
    profile,
    manifestFromAccount(profile, publicAccount(account), "succeeded")
  );
}

async function backfillCreationMarkerIdentity(account: TetiAccount): Promise<void> {
  const profile = await resolveTetiProfile();
  const marker = await readCreationMarker(profile);
  if (!marker || (marker.publicTetiId === account.id && marker.publicAddress === account.address)) return;

  await writeCreationMarker(profile, {
    stage: marker.stage,
    startedAt: marker.startedAt,
    completedAt: marker.completedAt,
    publicTetiId: account.id,
    publicAddress: account.address,
    errorCode: marker.errorCode,
    errorMessage: marker.errorMessage
  });
}

async function getDefaultAccountManager(): Promise<TetiAccountManager> {
  const profile = await resolveTetiProfile();
  await ensureProfileDirectories(profile);
  return createProfiledAccountManager(profile);
}
