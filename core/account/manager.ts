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
import { RegistryDiscoveryClient } from "../../services/discovery/registry-client.ts";
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
  | "registering_discovery"
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
    await this.storage.save(account);
    await this.reportCreationStage("persisted", account);
    await this.reportCreationStage("registering_discovery", account);
    await this.discoveryClient.registerIdentity(toDiscoveryRegistrationPayload(account));
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
        registered: false,
        onlineStatus: "unknown"
      };
    }

    let registered = false;
    try {
      const identity = await this.discoveryClient.getIdentity(getTetiId(account));
      registered =
        identity !== null &&
        identity.address === account.address &&
        identity.displayName === account.displayName;
    } catch {
      registered = false;
    }

    return {
      exists: true,
      address: account.address,
      registered,
      onlineStatus: "unknown"
    };
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
