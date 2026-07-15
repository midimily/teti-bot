import type { TetiAccount, TetiStatus } from "../../../core/account/model.ts";
import { TetiAccountManager, toDiscoveryRegistrationPayload } from "../../../core/account/manager.ts";
import { RegistryDiscoveryClient } from "../../../services/discovery/registry-client.ts";
import {
  LIFECYCLE_MAX_LINE_BYTES,
  LIFECYCLE_METHODS,
  LIFECYCLE_PROTOCOL_VERSION,
  isLifecycleMethod,
  type LifecycleRequest,
  type LifecycleResponse,
  type LifecycleResult,
  type LifecycleStatusResult,
  type PublicTetiAccount
} from "../src/lifecycle-bridge/protocol.ts";
import { isUnsafeIncompleteMarker, readCreationMarker, writeCreationMarker } from "./marker.ts";
import { manifestFromAccount, writeManifest } from "./manifest.ts";
import {
  createProfiledAccountManager,
  ensureProfileDirectories,
  resolveTetiProfile,
  validateRealProvisioningProfile
} from "./profile.ts";
import { createLifecycleError, sanitizeUnknownError } from "./security.ts";

export interface LifecycleSidecarDependencies {
  loadTetiAccount(): Promise<TetiAccount | null>;
  createTetiAccount(input: { name: string }): Promise<TetiAccount>;
  getTetiStatus(): Promise<TetiStatus>;
  registerDiscovery(account: TetiAccount): Promise<unknown>;
}

export const defaultLifecycleSidecarDependencies: LifecycleSidecarDependencies = {
  loadTetiAccount: async () => (await getDefaultAccountManager()).loadTetiAccount(),
  createTetiAccount: async (input) => createGuardedRealTetiAccount(input),
  getTetiStatus: async () => (await getDefaultAccountManager()).getTetiStatus(),
  registerDiscovery: async (account) => {
    await new RegistryDiscoveryClient().registerIdentity(toDiscoveryRegistrationPayload(account));
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
  switch (request.method) {
    case "lifecycle.health":
      return {
        status: "ok",
        protocolVersion: LIFECYCLE_PROTOCOL_VERSION,
        methods: LIFECYCLE_METHODS
      };

    case "account.status":
      return statusToDto(await dependencies.getTetiStatus(), await dependencies.loadTetiAccount());

    case "account.load":
      return publicAccountOrNull(await dependencies.loadTetiAccount());

    case "account.create": {
      const name = validateName(request.params?.name);
      return publicAccount(await dependencies.createTetiAccount({ name }));
    }

    case "discovery.register":
    case "discovery.retry": {
      const account = await dependencies.loadTetiAccount();
      if (!account) {
        throw new Error("Cannot register discovery without a local Teti account.");
      }
      await dependencies.registerDiscovery(account);
      return statusToDto(await dependencies.getTetiStatus(), account);
    }
  }
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
    throw new Error("Teti display name is required.");
  }

  const name = value.trim();
  if (name.length === 0 || name.length > 80) {
    throw new Error("Teti display name is invalid.");
  }

  return name;
}

function statusToDto(status: TetiStatus, account: TetiAccount | null): LifecycleStatusResult {
  const result: LifecycleStatusResult = {
    exists: status.exists,
    registered: status.registered,
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
    case "discovery.register":
    case "discovery.retry":
      return "DISCOVERY_REGISTRATION_FAILED";
    case "account.load":
    case "account.status":
      return "ACCOUNT_LOAD_FAILED";
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

async function createGuardedRealTetiAccount(input: { name: string }): Promise<TetiAccount> {
  const report = await validateRealProvisioningProfile();
  if (!report.ok || !report.profile) {
    throw new Error(report.errors.map((error) => error.message).join(" "));
  }

  const profile = report.profile;
  await ensureProfileDirectories(profile);
  const manager = createProfiledAccountManager(profile);
  const existing = await manager.loadTetiAccount();
  if (existing) {
    throw new Error("A Teti account already exists in this validation profile. Refusing duplicate creation.");
  }

  const marker = await readCreationMarker(profile);
  if (isUnsafeIncompleteMarker(marker)) {
    throw new Error(`Unsafe incomplete creation marker found at stage ${marker?.stage}.`);
  }

  const startedAt = new Date().toISOString();
  await writeCreationMarker(profile, {
    stage: "provisioning",
    startedAt
  });

  try {
    const account = await manager.createTetiAccount(input);
    await writeCreationMarker(profile, {
      stage: "complete",
      startedAt,
      completedAt: new Date().toISOString(),
      publicTetiId: account.id,
      publicAddress: account.address
    });
    await writeManifest(profile, manifestFromAccount(profile, publicAccount(account)));
    return account;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeCreationMarker(profile, {
      stage: /storage|persist|write|rename|EACCES|EPERM|ENOSPC/i.test(message)
        ? "failed_fatal"
        : "failed_recoverable",
      startedAt,
      errorCode: "ACCOUNT_CREATE_FAILED",
      errorMessage: message.slice(0, 180)
    });
    throw error;
  }
}

async function getDefaultAccountManager(): Promise<TetiAccountManager> {
  const profileDir = process.env.TETI_PROFILE_DIR;
  if (!profileDir) {
    return new TetiAccountManager();
  }

  const profile = await resolveTetiProfile();
  await ensureProfileDirectories(profile);
  return createProfiledAccountManager(profile);
}
