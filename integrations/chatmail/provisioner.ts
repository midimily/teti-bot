import { createRuntimeChatmailRpcClient } from "./create-runtime-client.ts";
import type { RuntimeChatmailClientOptions } from "./create-runtime-client.ts";
import { accountQrFromRelayDomain, REQUIRED_REAL_VALIDATION_RELAY_DOMAIN } from "./relay-config.ts";
import type { ChatmailRpcClient } from "./types.ts";

export const DEFAULT_CHATMAIL_ACCOUNT_QR = accountQrFromRelayDomain(REQUIRED_REAL_VALIDATION_RELAY_DOMAIN);

export interface ChatmailProvisionedIdentity {
  accountId: number;
  address: string;
  displayName: string;
  publicKey?: string;
  fingerprint?: string;
}

export interface ChatmailProvisioner {
  createIdentity(displayName: string): Promise<ChatmailProvisionedIdentity>;
}

export interface RpcChatmailProvisionerOptions {
  accountQr?: string;
  cleanupOnFailure?: boolean;
}

export class RpcChatmailProvisioner implements ChatmailProvisioner {
  private readonly rpc: ChatmailRpcClient;
  private readonly accountQr: string;
  private readonly cleanupOnFailure: boolean;

  constructor(rpc: ChatmailRpcClient, options: RpcChatmailProvisionerOptions = {}) {
    this.rpc = rpc;
    this.accountQr = options.accountQr ?? DEFAULT_CHATMAIL_ACCOUNT_QR;
    this.cleanupOnFailure = options.cleanupOnFailure ?? true;
  }

  async createIdentity(displayName: string): Promise<ChatmailProvisionedIdentity> {
    const normalizedDisplayName = displayName.trim();
    if (!normalizedDisplayName) {
      throw new Error("Teti display name is required for chatmail identity provisioning.");
    }

    const accountId = await this.rpc.addAccount();

    try {
      await this.rpc.configureAccount(accountId, {
        displayName: normalizedDisplayName,
        qr: this.accountQr
      });
      await this.rpc.startIo(accountId);

      const identity = await this.rpc.getAccountInfo(accountId);
      const publicIdentity = await this.rpc.getPublicIdentity(accountId);

      return {
        accountId,
        address: publicIdentity.address || identity.address,
        displayName: normalizedDisplayName,
        publicKey: publicIdentity.publicKey,
        fingerprint: publicIdentity.fingerprint
      };
    } catch (error) {
      if (this.cleanupOnFailure) {
        await this.tryRemoveAccount(accountId);
      }

      throw error;
    }
  }

  private async tryRemoveAccount(accountId: number): Promise<void> {
    try {
      await this.rpc.removeAccount(accountId);
    } catch {
      // Best-effort cleanup only. Preserve the provisioning error.
    }
  }
}

export class RuntimeChatmailProvisioner implements ChatmailProvisioner {
  private readonly options: RuntimeChatmailClientOptions;
  private readonly provisionerOptions: RpcChatmailProvisionerOptions;

  constructor(
    options: RuntimeChatmailClientOptions = {},
    provisionerOptions: RpcChatmailProvisionerOptions = {}
  ) {
    this.options = options;
    this.provisionerOptions = provisionerOptions;
  }

  async createIdentity(displayName: string): Promise<ChatmailProvisionedIdentity> {
    const client = createRuntimeChatmailRpcClient(this.options);

    try {
      return await new RpcChatmailProvisioner(client, this.provisionerOptions).createIdentity(
        displayName
      );
    } finally {
      await client.close();
    }
  }
}
