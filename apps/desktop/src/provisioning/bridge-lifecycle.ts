import type { TetiAccount, TetiStatus } from "../../../../core/account/model.ts";
import type { FirstLaunchAccountLifecycle } from "../first-launch/coordinator.ts";
import {
  LIFECYCLE_PROTOCOL_VERSION,
  type LifecycleErrorDto,
  type LifecycleMethod,
  type LifecycleRequest,
  type LifecycleResponse,
  type LifecycleStatusResult,
  type PublicTetiAccount
} from "../lifecycle-bridge/protocol.ts";
import type { TauriInvoker } from "../platform/tauri-api.ts";

export class BridgeDesktopAccountLifecycle implements FirstLaunchAccountLifecycle {
  private readonly bridge: LifecycleBridgeClient;

  constructor(bridge: LifecycleBridgeClient) {
    this.bridge = bridge;
  }

  async health(): Promise<void> {
    await this.bridge.request("lifecycle.health");
  }

  async loadTetiAccount(): Promise<TetiAccount | null> {
    const result = await this.bridge.request("account.load");
    return result ? accountFromDto(result as PublicTetiAccount) : null;
  }

  async createTetiAccount(input: { name: string }): Promise<TetiAccount> {
    return accountFromDto((await this.bridge.request("account.create", { name: input.name })) as PublicTetiAccount);
  }

  async getTetiStatus(): Promise<TetiStatus> {
    const result = (await this.bridge.request("account.status")) as LifecycleStatusResult;
    return {
      exists: result.exists,
      networkIdentity: { ...result.networkIdentity },
      onlineStatus: result.onlineStatus,
      address: result.account?.address
    };
  }
  async synchronizeNetworkIdentity(): Promise<TetiAccount> {
    const result = (await this.bridge.request("network.identity.retry")) as LifecycleStatusResult;
    const account = result.account;
    if (!account) {
      throw new Error("Teti could not finish connecting yet.");
    }
    return accountFromDto(account);
  }
}

export class LifecycleBridgeClient {
  private readonly tauri: TauriInvoker;

  constructor(tauri: TauriInvoker) {
    this.tauri = tauri;
  }

  async request(method: LifecycleMethod, params: Record<string, unknown> = {}): Promise<unknown> {
    const request: LifecycleRequest = {
      version: LIFECYCLE_PROTOCOL_VERSION,
      id: createRequestId(),
      method,
      params
    };
    const response = await this.tauri.invoke<LifecycleResponse>("lifecycle_request", { request });

    if (!response.ok) {
      throw lifecycleError(response.error);
    }

    return response.result;
  }

  async logoutLocalProfile(): Promise<never> {
    await this.tauri.invoke("logout_local_profile");
    return this.tauri.invoke<never>("restart_application");
  }
}

export async function createBridgeDesktopAccountLifecycle(tauri: TauriInvoker): Promise<{
  lifecycle: BridgeDesktopAccountLifecycle;
}> {
  const bridge = new LifecycleBridgeClient(tauri);
  const lifecycle = new BridgeDesktopAccountLifecycle(bridge);
  await lifecycle.health();

  return {
    lifecycle
  };
}

function accountFromDto(dto: PublicTetiAccount): TetiAccount {
  return {
    version: 1,
    id: dto.id,
    address: dto.address,
    displayName: dto.displayName,
    chatmailAccountId: dto.chatmailAccountId,
    publicKey: dto.publicKey,
    fingerprint: dto.fingerprint,
    publicProfile: dto.publicProfile as unknown as TetiAccount["publicProfile"],
    createdAt: dto.createdAt
  };
}

function lifecycleError(error: LifecycleErrorDto): Error {
  const instance = new Error(error.message);
  instance.name = error.code;
  if (error.diagnosticCode) {
    Object.assign(instance, { diagnosticCode: error.diagnosticCode });
  }
  return instance;
}

function createRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `lifecycle_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
