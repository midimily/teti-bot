import { randomUUID } from "node:crypto";
import type { TetiAccount } from "../../core/account/model.ts";
import type { TetiAccountStorage } from "../../core/account/storage.ts";
import { normalizeTetiRelayChatmailAddress } from "../../core/identity/public-id.ts";
import { assertTetiNetworkCompatible } from "./compatibility.ts";
import type { TetiNetworkEnvironment } from "./config.ts";
import { TetiNetworkClientError } from "./errors.ts";
import type {
  TetiNetworkPendingRelayBindingCommand,
  TetiNetworkRelayBindingState,
  TetiNetworkRelayBindingStore
} from "./relay-binding-store.ts";
import type {
  TetiNetworkAuthenticatedSigner,
  TetiNetworkClient,
  TetiNetworkPutRelayBindingRequest,
  TetiNetworkRelayBindingResult,
  TetiNetworkRelayCatalogItem
} from "./types.ts";

export const TETI_NETWORK_RELAY_BINDING_ADOPTION_GRANT =
  "TETI_NETWORK_RELAY_BINDING_ADOPTION_GRANT";

export interface TetiNetworkRelayServiceOptions {
  client: TetiNetworkClient;
  accountStorage: TetiAccountStorage;
  store: TetiNetworkRelayBindingStore;
  environment: TetiNetworkEnvironment;
  getAuthentication(): Promise<{
    tetiId: string;
    authentication: TetiNetworkAuthenticatedSigner;
  }>;
  adoptionGrant?: string;
  now?: () => Date;
  idempotencyKeyFactory?: (operation: "adopt" | "create" | "activate" | "revoke") => string;
}

export interface TetiNetworkRelayProvisioningSelection {
  relay: TetiNetworkRelayCatalogItem;
  accountQr: string;
  expectedAddressSuffix: string;
}

/** Runtime-owned Relay selection, binding reconciliation, and explicit migration commands. */
export class TetiNetworkRelayService {
  private readonly client: TetiNetworkClient;
  private readonly accountStorage: TetiAccountStorage;
  private readonly store: TetiNetworkRelayBindingStore;
  private readonly environment: TetiNetworkEnvironment;
  private readonly getAuthentication: TetiNetworkRelayServiceOptions["getAuthentication"];
  private readonly adoptionGrant?: string;
  private readonly now: () => Date;
  private readonly idempotencyKeyFactory: NonNullable<
    TetiNetworkRelayServiceOptions["idempotencyKeyFactory"]
  >;
  private synchronization: Promise<TetiNetworkRelayBindingResult> | null = null;

  constructor(options: TetiNetworkRelayServiceOptions) {
    this.client = options.client;
    this.accountStorage = options.accountStorage;
    this.store = options.store;
    this.environment = options.environment;
    this.getAuthentication = options.getAuthentication;
    this.adoptionGrant = options.adoptionGrant;
    this.now = options.now ?? (() => new Date());
    this.idempotencyKeyFactory = options.idempotencyKeyFactory
      ?? ((operation) => `relay.${operation}:${randomUUID()}`);
  }

  async selectProvisioningRelay(signal?: AbortSignal): Promise<TetiNetworkRelayProvisioningSelection> {
    const bootstrap = await this.client.getBootstrap(signal);
    assertTetiNetworkCompatible(bootstrap);
    const preferred = requireRelayBootstrap(bootstrap.relayBootstrap).preferredRelay;
    const catalog = await this.client.listRelays(signal);
    const relay = catalog.relays.find((candidate) => candidate.id === preferred.id);
    if (!relay
      || relay.domain !== preferred.domain
      || relay.region !== preferred.region
      || relay.accountProvisioning.type !== preferred.accountProvisioning.type
      || relay.accountProvisioning.value !== preferred.accountProvisioning.value
      || relay.status !== "active"
      || !relay.acceptsNewAccounts) {
      throw relayError(
        "RELAY_UNAVAILABLE",
        "relay_list",
        "The preferred Teti Relay is not currently available for account provisioning."
      );
    }
    return {
      relay: structuredClone(relay),
      accountQr: relay.accountProvisioning.value,
      expectedAddressSuffix: `@${relay.domain}`
    };
  }

  synchronize(signal?: AbortSignal): Promise<TetiNetworkRelayBindingResult> {
    if (this.synchronization) return this.synchronization;
    const operation = this.performSynchronization(signal);
    this.synchronization = operation;
    void operation.finally(() => {
      if (this.synchronization === operation) this.synchronization = null;
    }).catch(() => undefined);
    return operation;
  }

  async createMigratingBinding(
    input: { relayId: string; mailbox: string; transportPublicKey: string | null },
    signal?: AbortSignal
  ): Promise<TetiNetworkRelayBindingResult> {
    const current = await this.readCurrent(signal);
    const body: TetiNetworkPutRelayBindingRequest = {
      schemaVersion: 1 as const,
      expectedRevision: current.result.document.revision,
      relayId: input.relayId,
      mailbox: input.mailbox,
      transportPublicKey: input.transportPublicKey
    };
    const rawBody = JSON.stringify(body);
    const pending = await this.pendingCommand(
      "create",
      "/v1/relay-bindings/create",
      rawBody,
      current.result.etag
    );
    const result = await this.client.createRelayBinding(
      body,
      current.authenticated.authentication,
      {
        idempotencyKey: pending.idempotencyKey,
        rawBody: pending.rawBody,
        ifMatch: pending.ifMatch,
        signal
      }
    );
    await this.persist(result);
    return result;
  }

  async activateMigratingBinding(bindingId: string, signal?: AbortSignal) {
    return this.mutate("activate", bindingId, signal);
  }

  async revokeMigratingBinding(bindingId: string, signal?: AbortSignal) {
    return this.mutate("revoke", bindingId, signal);
  }

  private async performSynchronization(signal?: AbortSignal): Promise<TetiNetworkRelayBindingResult> {
    const bootstrap = await this.client.getBootstrap(signal);
    assertTetiNetworkCompatible(bootstrap);
    const account = await this.accountStorage.load();
    if (!account) {
      throw new Error("A local Teti account is required before RelayBinding synchronization.");
    }
    const authenticated = await this.getAuthentication();
    if (authenticated.tetiId !== account.id) {
      throw relayError(
        "RELAY_BINDING_CONFLICT",
        "relay_binding_self",
        "The authenticated Network identity does not match the local Teti account."
      );
    }
    let result = await this.client.getRelayBindingsSelf(authenticated.authentication, signal);
    if (result.document.tetiId !== account.id) {
      throw relayError(
        "RELAY_BINDING_CONFLICT",
        "relay_binding_self",
        "Network returned RelayBindings for another Teti identity."
      );
    }
    if (result.document.active === null) {
      result = await this.adoptMissingBinding(account, authenticated.authentication, result, signal);
    }
    validateActiveBinding(account, result);
    await this.persist(result);
    return structuredClone(result);
  }

  private async adoptMissingBinding(
    account: TetiAccount,
    authentication: TetiNetworkAuthenticatedSigner,
    current: TetiNetworkRelayBindingResult,
    signal?: AbortSignal
  ): Promise<TetiNetworkRelayBindingResult> {
    if (!this.adoptionGrant) {
      throw relayError(
        "RELAY_BINDING_ADOPTION_DENIED",
        "relay_binding_adopt",
        `Existing RelayBinding recovery requires ${TETI_NETWORK_RELAY_BINDING_ADOPTION_GRANT}.`
      );
    }
    const { mailbox, domain } = splitRelayAddress(account.address);
    const catalog = await this.client.listRelays(signal);
    const relay = catalog.relays.find((candidate) => candidate.domain === domain);
    if (!relay || relay.status === "offline") {
      throw relayError(
        "RELAY_UNAVAILABLE",
        "relay_binding_adopt",
        "The existing Chatmail Relay cannot currently be adopted."
      );
    }
    const body = {
      schemaVersion: 1 as const,
      expectedRevision: current.document.revision,
      relayId: relay.id,
      mailbox,
      transportPublicKey: account.publicKey ?? null,
      adoptionGrant: this.adoptionGrant
    };
    const rawBody = JSON.stringify(body);
    const pending = await this.pendingCommand(
      "adopt",
      "/v1/relay-bindings/adopt",
      rawBody,
      current.etag
    );
    const result = await this.client.adoptRelayBinding(body, authentication, {
      idempotencyKey: pending.idempotencyKey,
      rawBody: pending.rawBody,
      ifMatch: pending.ifMatch,
      signal
    });
    await this.persist(result);
    return result;
  }

  private async mutate(command: "activate" | "revoke", bindingId: string, signal?: AbortSignal) {
    const current = await this.readCurrent(signal);
    const body = {
      schemaVersion: 1 as const,
      expectedRevision: current.result.document.revision
    };
    return this.executePersistedCommand(
      command,
      `/v1/relay-bindings/${encodeURIComponent(bindingId)}/${command}`,
      body,
      current,
      signal,
      bindingId
    );
  }

  private async readCurrent(signal?: AbortSignal) {
    const authenticated = await this.getAuthentication();
    const result = await this.client.getRelayBindingsSelf(authenticated.authentication, signal);
    await this.persist(result, false);
    return { authenticated, result };
  }

  private async executePersistedCommand(
    operation: "activate" | "revoke",
    path: string,
    body: { schemaVersion: 1; expectedRevision: number },
    current: Awaited<ReturnType<TetiNetworkRelayService["readCurrent"]>>,
    signal?: AbortSignal,
    bindingId?: string
  ): Promise<TetiNetworkRelayBindingResult> {
    const rawBody = JSON.stringify(body);
    const pending = await this.pendingCommand(operation, path, rawBody, current.result.etag);
    const result = await this.client.mutateRelayBinding(
      bindingId ?? "",
      operation,
      body,
      current.authenticated.authentication,
      {
        idempotencyKey: pending.idempotencyKey,
        rawBody: pending.rawBody,
        ifMatch: pending.ifMatch,
        signal
      }
    );
    await this.persist(result);
    return result;
  }

  private async pendingCommand(
    operation: TetiNetworkPendingRelayBindingCommand["operation"],
    path: string,
    rawBody: string,
    ifMatch: TetiNetworkPendingRelayBindingCommand["ifMatch"]
  ): Promise<TetiNetworkPendingRelayBindingCommand> {
    const stored = await this.store.load();
    const existing = stored?.pending;
    if (existing
      && existing.operation === operation
      && existing.path === path
      && existing.rawBody === rawBody
      && existing.ifMatch === ifMatch) {
      return existing;
    }
    const pending: TetiNetworkPendingRelayBindingCommand = {
      operation,
      path,
      rawBody,
      ifMatch,
      idempotencyKey: this.idempotencyKeyFactory(operation)
    };
    await this.store.save({
      schemaVersion: 1,
      environment: this.environment,
      result: stored?.result ?? null,
      verifiedAt: stored?.verifiedAt ?? null,
      pending
    });
    return pending;
  }

  private async persist(
    result: TetiNetworkRelayBindingResult,
    clearPending = true
  ): Promise<void> {
    const stored = clearPending ? null : await this.store.load();
    const state: TetiNetworkRelayBindingState = {
      schemaVersion: 1,
      environment: this.environment,
      result: structuredClone(result),
      verifiedAt: this.now().toISOString(),
      ...(stored?.pending ? { pending: stored.pending } : {})
    };
    await this.store.save(state);
  }
}

function validateActiveBinding(account: TetiAccount, result: TetiNetworkRelayBindingResult): void {
  const active = result.document.active;
  if (!active
    || active.status !== "active"
    || active.address !== normalizeTetiRelayChatmailAddress(account.address)
    || active.transportPublicKey !== (account.publicKey ?? null)) {
    throw relayError(
      "RELAY_BINDING_CONFLICT",
      "relay_binding_self",
      "Network RelayBinding does not match the local Chatmail account."
    );
  }
}

function requireRelayBootstrap<T>(value: T | undefined): T {
  if (value === undefined) {
    throw relayError(
      "RELAY_UNAVAILABLE",
      "relay_list",
      "Teti Network did not publish Relay bootstrap metadata."
    );
  }
  return value;
}

function splitRelayAddress(address: string): { mailbox: string; domain: string } {
  const normalized = normalizeTetiRelayChatmailAddress(address);
  const separator = normalized.lastIndexOf("@");
  return {
    mailbox: normalized.slice(0, separator),
    domain: normalized.slice(separator + 1)
  };
}

function relayError(
  code:
    | "RELAY_UNAVAILABLE"
    | "RELAY_BINDING_CONFLICT"
    | "RELAY_BINDING_ADOPTION_DENIED",
  operation: "relay_list" | "relay_binding_self" | "relay_binding_adopt",
  message: string
): TetiNetworkClientError {
  return new TetiNetworkClientError({ code, operation, message, retryable: false });
}
