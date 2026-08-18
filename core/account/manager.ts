import { randomBytes } from "node:crypto";
import type { ChatmailAdapter } from "../../integrations/chatmail/types.ts";
import { InvalidDisplayNameError, validateTetiDisplayName } from "./display-name.ts";
import { RealChatmailAdapter } from "../../integrations/chatmail/real-adapter.ts";
import {
  RuntimeChatmailProvisioner,
  type ChatmailProvisioner
} from "../../integrations/chatmail/provisioner.ts";
import { UnconfiguredChatmailRpcClient } from "../../integrations/chatmail/rpc-client.ts";
import {
  environmentScanToPublicProfile,
  scanEnvironment
} from "../environment/scanner.ts";
import type { EnvironmentScan } from "../environment/types.ts";
import {
  normalizeTetiPublicId,
  normalizeTetiRelayChatmailAddress
} from "../identity/public-id.ts";
import {
  TETI_ACCOUNT_VERSION,
  createDefaultPublicProfile,
  type CreateTetiAccountInput,
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
  environmentScanner?: () => Promise<EnvironmentScan>;
  expectedAddressSuffix?: string;
  provisionalTetiIdFactory?: () => string;
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
  private readonly environmentScanner: () => Promise<EnvironmentScan>;
  private readonly shouldUseProvisioner: boolean;
  private readonly expectedAddressSuffix?: string;
  private readonly provisionalTetiIdFactory: () => string;
  private readonly onCreationStage?: TetiAccountManagerOptions["onCreationStage"];

  constructor(options: TetiAccountManagerOptions = {}) {
    this.storage = options.storage ?? new FileTetiAccountStorage();
    this.chatmailProvisioner =
      options.chatmailProvisioner ??
      (options.chatmailAdapter ? undefined : new RuntimeChatmailProvisioner());
    this.chatmailAdapter =
      options.chatmailAdapter ?? new RealChatmailAdapter(new UnconfiguredChatmailRpcClient());
    this.shouldUseProvisioner = options.chatmailProvisioner !== undefined || !options.chatmailAdapter;
    this.environmentScanner = options.environmentScanner ?? scanEnvironment;
    this.expectedAddressSuffix = options.expectedAddressSuffix;
    this.provisionalTetiIdFactory = options.provisionalTetiIdFactory ?? createProvisionalTetiId;
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
        ? await this.chatmailProvisioner.createIdentity(requireDisplayName(displayName), {
            accountQr: input.chatmailQr
          })
        : await this.chatmailAdapter.createAccount({
            address: input.address,
            password: input.chatmailPassword,
            displayName,
            qr: input.chatmailQr
          });

    if (this.expectedAddressSuffix) {
      assertAddressMatchesRelay(chatmailIdentity.address, this.expectedAddressSuffix);
    }

    const canonicalAddress = normalizeTetiRelayChatmailAddress(chatmailIdentity.address);

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
      // Network replaces this recovery-only placeholder with the authoritative
      // Teti ID during the immediately following register transaction.
      id: normalizeTetiPublicId(this.provisionalTetiIdFactory()),
      address: canonicalAddress,
      chatmailAccountId: chatmailIdentity.accountId,
      publicKey: chatmailIdentity.publicKey,
      fingerprint: chatmailIdentity.fingerprint,
      publicProfile,
      networkIdentity: {
        schemaVersion: 1,
        mode: "register",
        state: "pending"
      },
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
        networkIdentity: { state: "unknown" },
        onlineStatus: "unknown"
      };
    }

    return {
      exists: true,
      address: account.address,
      networkIdentity: localNetworkIdentityStatus(account),
      onlineStatus: "unknown"
    };
  }

  async deleteTetiAccount(): Promise<void> {
    const account = await this.storage.load();
    if (!account) {
      return;
    }

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

    return updatedAccount;
  }

  private async reportCreationStage(stage: TetiAccountCreationStage, account: TetiAccount): Promise<void> {
    await this.onCreationStage?.(stage, account);
  }

}

function localNetworkIdentityStatus(account: TetiAccount): TetiStatus["networkIdentity"] {
  const binding = account.networkIdentity;
  if (!binding) return { state: "unknown" };
  return {
    state: binding.state,
    ...(binding.lastVerifiedAt ? { checkedAt: binding.lastVerifiedAt } : {}),
    ...(binding.errorCode ? { errorCode: binding.errorCode } : {})
  };
}

export class LocalAccountPersistenceError extends Error {
  readonly code = "LOC_SAVE";

  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
  }
}

function requireDisplayName(displayName: string | undefined): string {
  const validation = validateTetiDisplayName(displayName ?? "");
  if (!validation.ok) throw new InvalidDisplayNameError(validation.reason);
  return validation.value;
}

function createProvisionalTetiId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return `teti_${[...randomBytes(9)]
    .map((value) => alphabet[value % alphabet.length])
    .join("")}`;
}

function assertAddressMatchesRelay(address: string, expectedAddressSuffix: string): void {
  if (!address.toLowerCase().endsWith(expectedAddressSuffix.toLowerCase())) {
    throw new Error(`Chatmail address must end in ${expectedAddressSuffix}.`);
  }
}
