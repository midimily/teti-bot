import { createRuntimeChatmailRpcClient } from "./create-runtime-client.ts";
import type { RuntimeChatmailClientOptions } from "./create-runtime-client.ts";
import { accountQrFromRelayDomain, REQUIRED_REAL_VALIDATION_RELAY_DOMAIN } from "./relay-config.ts";
import type { ChatmailRpcClient } from "./types.ts";
import { ChatmailTransportError } from "./stdio-transport.ts";

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
  timeouts?: Partial<ChatmailProvisioningTimeouts>;
  onStage?: (stage: ChatmailProvisioningStage) => void | Promise<void>;
}

export type ChatmailProvisioningStage =
  | "rpc_account"
  | "relay_config"
  | "io_start"
  | "identity_read"
  | "cleanup";

export interface ChatmailProvisioningTimeouts {
  rpcAccountMs: number;
  relayConfigMs: number;
  ioStartMs: number;
  identityReadMs: number;
  cleanupMs: number;
}

export type ChatmailProvisioningErrorCode =
  | "CM_RPC"
  | "CM_RPC_NOT_FOUND"
  | "CM_RPC_DENIED"
  | "CM_RPC_INCOMPATIBLE"
  | "CM_RPC_LOCKED"
  | "CM_RPC_EXIT"
  | "CM_RPC_TIMEOUT"
  | "CM_RPC_IO"
  | "CM_CFG"
  | "CM_CFG_TIMEOUT"
  | "CM_IO"
  | "CM_IO_TIMEOUT"
  | "CM_ID"
  | "CM_ID_TIMEOUT"
  | "CM_ID_INVALID";

export class ChatmailProvisioningError extends Error {
  readonly code: ChatmailProvisioningErrorCode;
  readonly stage: ChatmailProvisioningStage;

  constructor(
    code: ChatmailProvisioningErrorCode,
    stage: ChatmailProvisioningStage,
    message: string,
    options: { cause?: unknown } = {}
  ) {
    super(message, options);
    this.code = code;
    this.stage = stage;
  }
}

export const DEFAULT_CHATMAIL_PROVISIONING_TIMEOUTS: ChatmailProvisioningTimeouts = {
  rpcAccountMs: 8_000,
  relayConfigMs: 45_000,
  ioStartMs: 10_000,
  identityReadMs: 15_000,
  cleanupMs: 5_000
};

export class RpcChatmailProvisioner implements ChatmailProvisioner {
  private readonly rpc: ChatmailRpcClient;
  private readonly accountQr: string;
  private readonly cleanupOnFailure: boolean;
  private readonly timeouts: ChatmailProvisioningTimeouts;
  private readonly onStage: NonNullable<RpcChatmailProvisionerOptions["onStage"]>;

  constructor(rpc: ChatmailRpcClient, options: RpcChatmailProvisionerOptions = {}) {
    this.rpc = rpc;
    this.accountQr = options.accountQr ?? DEFAULT_CHATMAIL_ACCOUNT_QR;
    this.cleanupOnFailure = options.cleanupOnFailure ?? true;
    this.timeouts = { ...DEFAULT_CHATMAIL_PROVISIONING_TIMEOUTS, ...options.timeouts };
    this.onStage = options.onStage ?? (() => undefined);
  }

  async createIdentity(displayName: string): Promise<ChatmailProvisionedIdentity> {
    const normalizedDisplayName = displayName.trim();
    if (!normalizedDisplayName) {
      throw new Error("Teti display name is required for chatmail identity provisioning.");
    }

    const accountId = await this.runStage(
      "rpc_account",
      this.timeouts.rpcAccountMs,
      "CM_RPC",
      () => this.rpc.addAccount()
    );

    try {
      await this.runStage(
        "relay_config",
        this.timeouts.relayConfigMs,
        "CM_CFG",
        () => this.rpc.configureAccount(accountId, {
          displayName: normalizedDisplayName,
          qr: this.accountQr
        })
      );
      await this.runStage(
        "io_start",
        this.timeouts.ioStartMs,
        "CM_IO",
        () => this.rpc.startIo(accountId)
      );

      const [identity, publicIdentity] = await this.runStage(
        "identity_read",
        this.timeouts.identityReadMs,
        "CM_ID",
        () => Promise.all([
          this.rpc.getAccountInfo(accountId),
          this.rpc.getPublicIdentity(accountId)
        ])
      );
      if (!(publicIdentity.address || identity.address)) {
        throw new ChatmailProvisioningError(
          "CM_ID_INVALID",
          "identity_read",
          "Chatmail did not return a public relay identity."
        );
      }

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
      await this.runStage(
        "cleanup",
        this.timeouts.cleanupMs,
        "CM_RPC",
        () => this.rpc.removeAccount(accountId)
      );
    } catch {
      // Best-effort cleanup only. Preserve the provisioning error.
    }
  }

  private async runStage<T>(
    stage: ChatmailProvisioningStage,
    timeoutMs: number,
    fallbackCode: "CM_RPC" | "CM_CFG" | "CM_IO" | "CM_ID",
    operation: () => Promise<T>
  ): Promise<T> {
    await this.onStage(stage);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(new ChatmailProvisioningError(
          timeoutCode(fallbackCode),
          stage,
          `Chatmail provisioning stage ${stage} timed out.`
        ));
      }, timeoutMs);
    });
    try {
      return await Promise.race([operation(), deadline]);
    } catch (error) {
      if (error instanceof ChatmailProvisioningError) throw error;
      if (error instanceof ChatmailTransportError) {
        throw new ChatmailProvisioningError(error.code, stage, error.message, { cause: error });
      }
      throw new ChatmailProvisioningError(
        fallbackCode,
        stage,
        `Chatmail provisioning failed during ${stage}.`,
        { cause: error }
      );
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

function timeoutCode(
  code: "CM_RPC" | "CM_CFG" | "CM_IO" | "CM_ID"
): ChatmailProvisioningErrorCode {
  if (code === "CM_CFG") return "CM_CFG_TIMEOUT";
  if (code === "CM_IO") return "CM_IO_TIMEOUT";
  if (code === "CM_ID") return "CM_ID_TIMEOUT";
  return "CM_RPC_TIMEOUT";
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
