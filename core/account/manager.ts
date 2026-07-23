import type { ChatmailAdapter } from "../../integrations/chatmail/types.ts";
import { validateTetiDisplayName } from "./display-name.ts";
import { assertAddressMatchesRelay } from "../../integrations/chatmail/relay-config.ts";
import { RealChatmailAdapter } from "../../integrations/chatmail/real-adapter.ts";
import {
  RuntimeChatmailProvisioner,
  type ChatmailProvisioner
} from "../../integrations/chatmail/provisioner.ts";
import { UnconfiguredChatmailRpcClient } from "../../integrations/chatmail/rpc-client.ts";
import type { DiscoveryClient } from "../../services/discovery/registry-client.ts";
import {
  RegistryClientError,
  RegistryDiscoveryClient
} from "../../services/discovery/registry-client.ts";
import {
  environmentScanToPublicProfile,
  scanEnvironment
} from "../environment/scanner.ts";
import type { EnvironmentScan } from "../environment/types.ts";
import { normalizeTetiChatmailAddress } from "../identity/public-id.ts";
import {
  TETI_ACCOUNT_VERSION,
  createDefaultPublicProfile,
  getTetiId,
  getTetiIdFromAddress,
  type CreateTetiAccountInput,
  type DiscoveryRegistrationPayload,
  type RegistryStatus,
  type TetiAccount,
  type TetiStatus
} from "./model.ts";
import {
  FileTetiAccountStorage,
  type TetiAccountStorage
} from "./storage.ts";

export interface TetiAccountManagerOptions {
  storage?: TetiAccountStorage;
  chatmailAdapter?: ChatmailAdapter;
  chatmailProvisioner?: ChatmailProvisioner;
  discoveryClient?: DiscoveryClient;
  environmentScanner?: () => Promise<EnvironmentScan>;
  expectedAddressSuffix?: string;
  onCreationStage?: (stage: TetiAccountCreationStage, account?: TetiAccount) => Promise<void> | void;
}

export type TetiAccountCreationStage =
  | "identity_created"
  | "persisting"
  | "persisted"
  | "complete";

export class TetiAccountManager {
  private readonly storage: TetiAccountStorage;
  private readonly chatmailAdapter: ChatmailAdapter;
  private readonly chatmailProvisioner?: ChatmailProvisioner;
  private readonly discoveryClient: DiscoveryClient;
  private readonly environmentScanner: () => Promise<EnvironmentScan>;
  private readonly shouldUseProvisioner: boolean;
  private readonly expectedAddressSuffix?: string;
  private readonly onCreationStage?: TetiAccountManagerOptions["onCreationStage"];

  constructor(options: TetiAccountManagerOptions = {}) {
    this.storage = options.storage ?? new FileTetiAccountStorage();
    this.chatmailProvisioner =
      options.chatmailProvisioner ??
      (options.chatmailAdapter ? undefined : new RuntimeChatmailProvisioner());
    this.chatmailAdapter =
      options.chatmailAdapter ?? new RealChatmailAdapter(new UnconfiguredChatmailRpcClient());
    this.shouldUseProvisioner = options.chatmailProvisioner !== undefined || !options.chatmailAdapter;
    this.discoveryClient = options.discoveryClient ?? new RegistryDiscoveryClient();
    this.environmentScanner = options.environmentScanner ?? scanEnvironment;
    this.expectedAddressSuffix = options.expectedAddressSuffix;
    this.onCreationStage = options.onCreationStage;
  }

  async createTetiAccount(input: CreateTetiAccountInput = {}): Promise<TetiAccount> {
    const existing = await this.storage.load();
    if (existing) {
      return existing;
    }

    const displayName = input.displayName ?? input.name;
    const chatmailIdentity =
      this.shouldUseProvisioner && this.chatmailProvisioner
        ? await this.chatmailProvisioner.createIdentity(requireDisplayName(displayName))
        : await this.chatmailAdapter.createAccount({
            address: input.address,
            password: input.chatmailPassword,
            displayName,
            qr: input.chatmailQr
          });

    if (this.expectedAddressSuffix) {
      assertAddressMatchesRelay(chatmailIdentity.address, this.expectedAddressSuffix);
    }

    const canonicalAddress = normalizeTetiChatmailAddress(chatmailIdentity.address);

    const environmentProfile = environmentScanToPublicProfile(await this.environmentScanner());
    const publicProfile = createDefaultPublicProfile({
      platform: environmentProfile.platform,
      aiEnvironment: environmentProfile.aiEnvironment,
      lastSeen: environmentProfile.lastSeen,
      device: environmentProfile.device,
      location: environmentProfile.location,
      ...input.publicProfile
    });
    const account: TetiAccount = {
      version: TETI_ACCOUNT_VERSION,
      id: getTetiIdFromAddress(canonicalAddress),
      address: canonicalAddress,
      chatmailAccountId: chatmailIdentity.accountId,
      publicKey: chatmailIdentity.publicKey,
      fingerprint: chatmailIdentity.fingerprint,
      publicProfile,
      createdAt: new Date().toISOString()
    };
    const accountDisplayName = chatmailIdentity.displayName ?? displayName;
    if (accountDisplayName) {
      account.displayName = accountDisplayName;
    }

    await this.reportCreationStage("identity_created", account);
    await this.reportCreationStage("persisting", account);
    try {
      await this.storage.save(account);
    } catch (error) {
      throw new LocalAccountPersistenceError("Teti could not persist its local identity.", { cause: error });
    }
    await this.reportCreationStage("persisted", account);
    await this.reportCreationStage("complete", account);

    return account;
  }

  async loadTetiAccount(): Promise<TetiAccount | null> {
    return this.storage.load();
  }

  async getTetiStatus(): Promise<TetiStatus> {
    const account = await this.storage.load();
    if (!account) {
      return {
        exists: false,
        registry: { state: "unknown" },
        onlineStatus: "unknown"
      };
    }

    return {
      exists: true,
      address: account.address,
      registry: await this.readRegistryStatus(account),
      onlineStatus: "unknown"
    };
  }

  async ensureTetiRegistration(): Promise<TetiAccount> {
    const account = await this.storage.load();
    if (!account) {
      throw new Error("A local Teti account is required before synchronizing discovery.");
    }

    const status = await this.readRegistryStatus(account);
    if (status.state === "registered") {
      return this.refreshTetiEnvironment();
    }
    if (status.state === "not_registered") {
      try {
        await this.discoveryClient.registerIdentity(toDiscoveryRegistrationPayload(account));
      } catch (error) {
        throw new RegistryStatusError(registryStatusForError(error));
      }
      return account;
    }
    throw new RegistryStatusError(status);
  }

  async deleteTetiAccount(): Promise<void> {
    const account = await this.storage.load();
    if (!account) {
      return;
    }

    await this.discoveryClient.deleteIdentity(getTetiId(account));
    await this.chatmailAdapter.deleteAccount({
      accountId: account.chatmailAccountId
    });
    await this.storage.remove();
  }

  async refreshTetiEnvironment(): Promise<TetiAccount> {
    const account = await this.storage.load();
    if (!account) {
      throw new Error("A local Teti account is required before refreshing environment discovery.");
    }

    const environmentProfile = environmentScanToPublicProfile(await this.environmentScanner());
    const updatedAccount: TetiAccount = {
      ...account,
      publicProfile: createDefaultPublicProfile({
        ...account.publicProfile,
        platform: environmentProfile.platform,
        aiEnvironment: environmentProfile.aiEnvironment,
        lastSeen: environmentProfile.lastSeen,
        device: environmentProfile.device,
        location: environmentProfile.location
      })
    };

    await this.storage.save(updatedAccount);
    await this.discoveryClient.heartbeatIdentity({
      id: getTetiId(updatedAccount),
      publicProfile: updatedAccount.publicProfile
    });

    return updatedAccount;
  }

  private async reportCreationStage(stage: TetiAccountCreationStage, account: TetiAccount): Promise<void> {
    await this.onCreationStage?.(stage, account);
  }

  private async readRegistryStatus(account: TetiAccount): Promise<RegistryStatus> {
    const checkedAt = new Date().toISOString();
    try {
      const identity = await this.discoveryClient.getIdentity(getTetiId(account));
      if (!identity) return { state: "not_registered", checkedAt };
      if (
        identity.address !== account.address
        || identity.publicKey !== account.publicKey
        || identity.displayName !== account.displayName
      ) {
        return {
          state: "conflict",
          checkedAt,
          errorCode: "REG_IDENTITY_MISMATCH",
          retryable: false
        };
      }
      return { state: "registered", checkedAt };
    } catch (error) {
      return registryStatusForError(error, checkedAt);
    }
  }
}

function registryStatusForError(
  error: unknown,
  checkedAt = new Date().toISOString()
): RegistryStatus {
  if (error instanceof RegistryClientError) {
    return {
      state: error.kind === "conflict"
        ? "conflict"
        : error.kind === "rejected"
          ? "rejected"
          : "unreachable",
      checkedAt,
      errorCode: error.code,
      retryable: error.retryable
    };
  }
  return {
    state: "unreachable",
    checkedAt,
    errorCode: "REG_UNKNOWN",
    retryable: true
  };
}

export class RegistryStatusError extends Error {
  readonly registry: RegistryStatus;

  constructor(registry: RegistryStatus) {
    super(`Registry synchronization failed with state ${registry.state} (${registry.errorCode ?? "unknown"}).`);
    this.registry = { ...registry };
  }
}

export class LocalAccountPersistenceError extends Error {
  readonly code = "LOC_SAVE";

  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
  }
}

function requireDisplayName(displayName: string | undefined): string {
  const validation = validateTetiDisplayName(displayName ?? "");
  if (!validation.ok) throw new Error(validation.message);
  return validation.value;
}

export function toDiscoveryRegistrationPayload(account: TetiAccount): DiscoveryRegistrationPayload {
  const payload: DiscoveryRegistrationPayload = {
    version: TETI_ACCOUNT_VERSION,
    id: getTetiId(account),
    address: account.address,
    publicProfile: account.publicProfile
  };

  if (account.publicKey) {
    payload.publicKey = account.publicKey;
  }

  if (account.displayName) {
    payload.displayName = account.displayName;
  }

  return payload;
}
