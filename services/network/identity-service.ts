import { randomUUID } from "node:crypto";
import type { TetiAccount, TetiNetworkIdentityBinding } from "../../core/account/model.ts";
import type { TetiAccountStorage } from "../../core/account/storage.ts";
import { assertTetiNetworkCompatible } from "./compatibility.ts";
import {
  type TetiNetworkCredentialScope,
  type TetiNetworkCredentialRecord,
  type TetiNetworkCredentialStore
} from "./credential-store.ts";
import type { TetiNetworkEnvironment } from "./config.ts";
import { TetiNetworkClientError } from "./errors.ts";
import {
  createClientEnrollmentAuthorization,
  createClientEnrollmentProof,
  createFirstClientAuthorization,
  createTetiNetworkSigningKey,
  generateTetiNetworkSigningKey,
  type TetiNetworkStoredSigningKey
} from "./signing.ts";
import type {
  TetiNetworkAdoptIdentityRequest,
  TetiNetworkAuthenticatedSigner,
  TetiNetworkClient,
  TetiNetworkClientInstanceDocument,
  TetiNetworkEnrollClientInstanceRequest,
  TetiNetworkIdentitySession,
  TetiNetworkRegisterIdentityRequest,
  TetiNetworkSigningKey
} from "./types.ts";

export const TETI_NETWORK_ADOPTION_GRANT = "TETI_NETWORK_ADOPTION_GRANT";
export const DEVELOPMENT_FIRST_CLAIM_ADOPTION_GRANT = "teti-development-first-claim";

export interface TetiNetworkIdentityServiceOptions {
  client: TetiNetworkClient;
  accountStorage: TetiAccountStorage;
  credentialStore: TetiNetworkCredentialStore;
  environment: TetiNetworkEnvironment;
  appVersion: string;
  platform: string;
  adoptionGrant?: string;
  now?: () => Date;
  idempotencyKeyFactory?: (operation: "register" | "adopt" | "enroll" | "revoke") => string;
}

/** Runtime-owned bridge between a local Chatmail account and Network identity. */
export class TetiNetworkIdentityService {
  private readonly client: TetiNetworkClient;
  private readonly accountStorage: TetiAccountStorage;
  private readonly credentialStore: TetiNetworkCredentialStore;
  private readonly environment: TetiNetworkEnvironment;
  private readonly appVersion: string;
  private readonly platform: string;
  private readonly adoptionGrant?: string;
  private readonly now: () => Date;
  private readonly idempotencyKeyFactory: NonNullable<
    TetiNetworkIdentityServiceOptions["idempotencyKeyFactory"]
  >;
  private synchronization: Promise<TetiAccount> | null = null;

  constructor(options: TetiNetworkIdentityServiceOptions) {
    this.client = options.client;
    this.accountStorage = options.accountStorage;
    this.credentialStore = options.credentialStore;
    this.environment = options.environment;
    this.appVersion = requireToken(options.appVersion, "app version", 64);
    this.platform = requireToken(options.platform, "platform", 32);
    this.adoptionGrant = options.adoptionGrant;
    this.now = options.now ?? (() => new Date());
    this.idempotencyKeyFactory = options.idempotencyKeyFactory
      ?? ((operation) => `identity.${operation}:${randomUUID()}`);
  }

  synchronize(signal?: AbortSignal): Promise<TetiAccount> {
    if (this.synchronization) return this.synchronization;
    const synchronization = this.performSynchronization(signal);
    this.synchronization = synchronization;
    void synchronization.finally(() => {
      if (this.synchronization === synchronization) this.synchronization = null;
    }).catch(() => undefined);
    return synchronization;
  }

  async enrollClientInstance(
    newClient: TetiNetworkSigningKey,
    input: { platform: string; appVersion: string },
    signal?: AbortSignal
  ): Promise<TetiNetworkClientInstanceDocument> {
    await this.requireCompatible(signal);
    const credentials = await this.requireBoundCredentials();
    const identityRoot = createTetiNetworkSigningKey(credentials.identityRoot);
    const fields = {
      tetiId: credentials.tetiId,
      identityPublicKey: identityRoot.publicKey,
      clientPublicKey: newClient.publicKey,
      platform: requireToken(input.platform, "platform", 32),
      appVersion: requireToken(input.appVersion, "app version", 64)
    };
    const request: TetiNetworkEnrollClientInstanceRequest = {
      schemaVersion: 1,
      clientInstance: {
        publicKey: newClient.publicKey,
        platform: fields.platform,
        appVersion: fields.appVersion
      },
      identityAuthorization: identityRoot.sign(createClientEnrollmentAuthorization(fields)),
      clientProof: newClient.sign(createClientEnrollmentProof(fields))
    };
    const result = await this.client.enrollClientInstance(
      request,
      authenticationFrom(credentials),
      { idempotencyKey: this.idempotencyKeyFactory("enroll"), signal }
    );
    if (result.publicKey !== newClient.publicKey || result.status !== "active") {
      throw localConflict("client_enroll", "Network returned an inconsistent enrolled client.");
    }
    return result;
  }

  async revokeClientInstance(
    clientInstanceId: string,
    signal?: AbortSignal
  ): Promise<TetiNetworkClientInstanceDocument> {
    await this.requireCompatible(signal);
    const credentials = await this.requireBoundCredentials();
    const result = await this.client.revokeClientInstance(
      clientInstanceId,
      authenticationFrom(credentials),
      { idempotencyKey: this.idempotencyKeyFactory("revoke"), signal }
    );
    if (result.id !== clientInstanceId || result.status !== "revoked") {
      throw localConflict("client_revoke", "Network returned an inconsistent revoked client.");
    }
    if (clientInstanceId === credentials.clientInstance.id) {
      const account = await this.accountStorage.load();
      if (account) {
        await this.accountStorage.save({
          ...account,
          networkIdentity: bindingFrom(account, {
            state: "revoked",
            errorCode: "NETWORK_CLIENT_REVOKED"
          })
        });
      }
    }
    return result;
  }

  async getAuthenticatedSigner(): Promise<{
    tetiId: string;
    authentication: TetiNetworkAuthenticatedSigner;
  }> {
    const credentials = await this.requireBoundCredentials();
    return {
      tetiId: credentials.tetiId,
      authentication: authenticationFrom(credentials)
    };
  }

  private async performSynchronization(signal?: AbortSignal): Promise<TetiAccount> {
    const account = await this.accountStorage.load();
    if (!account) throw new Error("A local Teti account is required before Network identity sync.");
    await this.requireCompatible(signal);

    let currentAccount = account;
    const expectedScope = credentialScope(this.environment, currentAccount);
    let credentials = await this.credentialStore.load();
    if (credentials && !credentialScopeMatches(credentials.scope, expectedScope)) {
      if (isBound(credentials)) {
        await this.credentialStore.remove();
        credentials = null;
        currentAccount = await this.prepareForRegistration(currentAccount);
      } else {
        credentials = { ...credentials, scope: expectedScope };
        await this.credentialStore.save(credentials);
      }
    }
    if (credentials
      && isBound(credentials)
      && !boundCredentialMatchesActiveBinding(currentAccount, credentials, this.environment)) {
      await this.credentialStore.remove();
      credentials = null;
      currentAccount = await this.prepareForRegistration(currentAccount);
    }
    if (!credentials) {
      if (currentAccount.networkIdentity?.state === "active"
        && currentAccount.networkIdentity.environment === this.environment) {
        throw unauthorized(
          "identity_self",
          "The local Network credential file is missing for an active identity."
        );
      }
      currentAccount = await this.prepareForRegistration(currentAccount);
      credentials = newCredentialRecord(credentialScope(this.environment, currentAccount));
      await this.credentialStore.save(credentials);
    }
    ensureTransportKeysAreSeparate(currentAccount, credentials);

    if (credentials.tetiId && credentials.clientInstance.id) {
      const session = await this.client.getIdentitySelf(authenticationFrom(credentials), signal);
      return this.commitSession(currentAccount, credentials, session);
    }

    const mode = currentAccount.networkIdentity?.mode ?? "adopt";
    if (credentials.pending) {
      const persistedRequest = parsePendingRequest(
        credentials.pending.rawBody,
        credentials.pending.operation,
        credentials
      );
      if (!pendingRequestMatchesAccount(
        credentials.pending.operation,
        persistedRequest,
        mode,
        currentAccount
      )) {
        // The signing keys are still valid and intentionally retained. Only an
        // unbound write belonging to a different local account/mode is stale.
        delete credentials.pending;
        await this.credentialStore.save(credentials);
      }
    }
    if (!credentials.pending) {
      const rawBody = JSON.stringify(this.createFirstClientRequest(mode, currentAccount, credentials));
      credentials.pending = {
        operation: mode,
        idempotencyKey: this.idempotencyKeyFactory(mode),
        rawBody
      };
      // Persist keys, body bytes, and idempotency key before the first write.
      await this.credentialStore.save(credentials);
    }

    const request = parsePendingRequest(
      credentials.pending.rawBody,
      credentials.pending.operation,
      credentials
    );
    const pendingClient = createTetiNetworkSigningKey(credentials.clientInstance);
    const options = {
      idempotencyKey: credentials.pending.idempotencyKey,
      rawBody: credentials.pending.rawBody,
      signal
    };
    const session = credentials.pending.operation === "register"
      ? await this.client.registerIdentity(
          request as unknown as TetiNetworkRegisterIdentityRequest,
          pendingClient,
          options
        )
      : await this.client.adoptIdentity(
          request as unknown as TetiNetworkAdoptIdentityRequest,
          pendingClient,
          options
        );
    return this.commitSession(currentAccount, credentials, session);
  }

  private async prepareForRegistration(account: TetiAccount): Promise<TetiAccount> {
    if (account.networkIdentity?.state !== "active") return account;
    const pending: TetiAccount = {
      ...account,
      networkIdentity: {
        schemaVersion: 1,
        environment: this.environment,
        mode: "register",
        state: "pending"
      }
    };
    await this.accountStorage.save(pending);
    return pending;
  }

  private createFirstClientRequest(
    mode: "register" | "adopt",
    account: TetiAccount,
    credentials: TetiNetworkCredentialRecord
  ): TetiNetworkRegisterIdentityRequest | TetiNetworkAdoptIdentityRequest {
    const identityRoot = createTetiNetworkSigningKey(credentials.identityRoot);
    const client = createTetiNetworkSigningKey(credentials.clientInstance);
    const delivery = { address: account.address, publicKey: account.publicKey ?? null };
    const authorization = identityRoot.sign(createFirstClientAuthorization({
      operation: mode,
      tetiId: mode === "adopt" ? account.id : "",
      identityPublicKey: identityRoot.publicKey,
      clientPublicKey: client.publicKey,
      platform: this.platform,
      appVersion: this.appVersion,
      deliveryAddress: delivery.address,
      transportPublicKey: delivery.publicKey
    }));
    if (mode === "adopt") {
      if (!this.adoptionGrant) {
        throw unauthorized(
          "identity_adopt",
          `Existing Teti identity adoption requires ${TETI_NETWORK_ADOPTION_GRANT}.`
        );
      }
      return {
        schemaVersion: 1,
        tetiId: account.id,
        adoptionGrant: this.adoptionGrant,
        identityPublicKey: identityRoot.publicKey,
        clientInstance: {
          publicKey: client.publicKey,
          platform: this.platform,
          appVersion: this.appVersion
        },
        identityAuthorization: authorization,
        delivery
      };
    }
    return {
      schemaVersion: 1,
      identityPublicKey: identityRoot.publicKey,
      clientInstance: {
        publicKey: client.publicKey,
        platform: this.platform,
        appVersion: this.appVersion
      },
      identityAuthorization: authorization,
      delivery
    };
  }

  private async commitSession(
    account: TetiAccount,
    credentials: TetiNetworkCredentialRecord,
    session: TetiNetworkIdentitySession
  ): Promise<TetiAccount> {
    validateSession(account, credentials, session, this.platform, this.appVersion);
    const boundCredentials: TetiNetworkCredentialRecord = {
      schemaVersion: 1,
      scope: credentials.scope ?? credentialScope(this.environment, account),
      identityRoot: credentials.identityRoot,
      clientInstance: {
        publicKey: credentials.clientInstance.publicKey,
        privateSeed: credentials.clientInstance.privateSeed,
        id: session.clientInstance.id,
        platform: session.clientInstance.platform,
        appVersion: session.clientInstance.appVersion
      },
      tetiId: session.identity.tetiId
    };
    // If account persistence fails, the next start uses signed /self to finish recovery.
    await this.credentialStore.save(boundCredentials);
    const updated: TetiAccount = {
      ...account,
      id: session.identity.tetiId,
      networkIdentity: {
        schemaVersion: 1,
        environment: this.environment,
        mode: credentials.pending?.operation ?? account.networkIdentity?.mode ?? "adopt",
        state: "active",
        identityPublicKey: session.identity.identityPublicKey,
        clientInstanceId: session.clientInstance.id,
        lastVerifiedAt: this.now().toISOString()
      }
    };
    await this.accountStorage.save(updated);
    return updated;
  }

  private async requireCompatible(signal?: AbortSignal): Promise<void> {
    assertTetiNetworkCompatible(await this.client.getBootstrap(signal));
  }

  private async requireBoundCredentials(): Promise<TetiNetworkCredentialRecord & {
    tetiId: string;
    clientInstance: TetiNetworkCredentialRecord["clientInstance"] & { id: string };
  }> {
    const credentials = await this.credentialStore.load();
    if (!credentials || !isBound(credentials)) {
      throw unauthorized("identity_self", "Teti Network identity is not enrolled on this client.");
    }
    const account = await this.accountStorage.load();
    if (!account
      || !credentialScopeMatches(
        credentials.scope,
        credentialScope(this.environment, account)
      )
      || !boundCredentialMatchesActiveBinding(account, credentials, this.environment)) {
      await this.credentialStore.remove();
      throw unauthorized(
        "identity_self",
        "The local Network credentials do not belong to this account and environment."
      );
    }
    return credentials;
  }
}

function newCredentialRecord(scope: TetiNetworkCredentialScope): TetiNetworkCredentialRecord {
  const identityRoot = generateTetiNetworkSigningKey();
  const clientInstance = generateTetiNetworkSigningKey();
  return {
    schemaVersion: 1,
    scope,
    identityRoot: storedKey(identityRoot),
    clientInstance: storedKey(clientInstance)
  };
}

function storedKey(key: ReturnType<typeof generateTetiNetworkSigningKey>): TetiNetworkStoredSigningKey {
  return { publicKey: key.publicKey, privateSeed: key.privateSeed };
}

function authenticationFrom(
  credentials: TetiNetworkCredentialRecord & { clientInstance: { id?: string } }
): TetiNetworkAuthenticatedSigner {
  if (!credentials.clientInstance.id) {
    throw unauthorized("identity_self", "Teti Network ClientInstance is not enrolled.");
  }
  return {
    clientInstanceId: credentials.clientInstance.id,
    signingKey: createTetiNetworkSigningKey(credentials.clientInstance)
  };
}

function validateSession(
  account: TetiAccount,
  credentials: TetiNetworkCredentialRecord,
  session: TetiNetworkIdentitySession,
  platform: string,
  appVersion: string
): void {
  const expectedPlatform = credentials.clientInstance.platform ?? platform;
  const expectedAppVersion = credentials.clientInstance.appVersion ?? appVersion;
  if (session.identity.identityPublicKey !== credentials.identityRoot.publicKey
    || session.clientInstance.publicKey !== credentials.clientInstance.publicKey
    || session.delivery.address !== account.address
    || session.delivery.publicKey !== (account.publicKey ?? null)
    || session.clientInstance.platform !== expectedPlatform
    || session.clientInstance.appVersion !== expectedAppVersion
    || session.identity.status !== "active"
    || session.clientInstance.status !== "active") {
    throw localConflict("identity_self", "Network identity does not match this local account.");
  }
  if (credentials.tetiId && session.identity.tetiId !== credentials.tetiId) {
    throw localConflict("identity_self", "Network returned a different Teti ID for this client.");
  }
  if (credentials.pending?.operation === "adopt" && session.identity.tetiId !== account.id) {
    throw localConflict("identity_adopt", "Network adoption changed the existing Teti ID.");
  }
}

function bindingFrom(
  account: TetiAccount,
  update: Pick<TetiNetworkIdentityBinding, "state" | "errorCode">
): TetiNetworkIdentityBinding {
  return {
    schemaVersion: 1,
    ...(account.networkIdentity?.environment
      ? { environment: account.networkIdentity.environment }
      : {}),
    mode: account.networkIdentity?.mode ?? "adopt",
    state: update.state,
    ...(account.networkIdentity?.identityPublicKey
      ? { identityPublicKey: account.networkIdentity.identityPublicKey }
      : {}),
    ...(account.networkIdentity?.clientInstanceId
      ? { clientInstanceId: account.networkIdentity.clientInstanceId }
      : {}),
    ...(account.networkIdentity?.lastVerifiedAt
      ? { lastVerifiedAt: account.networkIdentity.lastVerifiedAt }
      : {}),
    ...(update.errorCode ? { errorCode: update.errorCode } : {})
  };
}

function credentialScope(
  environment: TetiNetworkEnvironment,
  account: Pick<TetiAccount, "address" | "publicKey">
): TetiNetworkCredentialScope {
  return {
    environment,
    deliveryAddress: account.address,
    transportPublicKey: account.publicKey ?? null
  };
}

function credentialScopeMatches(
  actual: TetiNetworkCredentialScope | undefined,
  expected: TetiNetworkCredentialScope
): boolean {
  return actual?.environment === expected.environment
    && actual.deliveryAddress === expected.deliveryAddress
    && actual.transportPublicKey === expected.transportPublicKey;
}

function isBound(
  credentials: TetiNetworkCredentialRecord
): credentials is TetiNetworkCredentialRecord & {
  tetiId: string;
  clientInstance: TetiNetworkCredentialRecord["clientInstance"] & { id: string };
} {
  return Boolean(credentials.tetiId && credentials.clientInstance.id);
}

function boundCredentialMatchesActiveBinding(
  account: TetiAccount,
  credentials: TetiNetworkCredentialRecord & {
    tetiId: string;
    clientInstance: TetiNetworkCredentialRecord["clientInstance"] & { id: string };
  },
  environment: TetiNetworkEnvironment
): boolean {
  const binding = account.networkIdentity;
  if (binding?.state !== "active" || binding.environment !== environment) return true;
  return binding.identityPublicKey === credentials.identityRoot.publicKey
    && binding.clientInstanceId === credentials.clientInstance.id
    && account.id === credentials.tetiId;
}

function ensureTransportKeysAreSeparate(
  account: TetiAccount,
  credentials: TetiNetworkCredentialRecord
): void {
  if (account.publicKey
    && (account.publicKey === credentials.identityRoot.publicKey
      || account.publicKey === credentials.clientInstance.publicKey)) {
    throw localConflict("identity_self", "Chatmail and Network signing keys must be distinct.");
  }
}

function parsePendingRequest(
  rawBody: string,
  operation: "register" | "adopt",
  credentials: TetiNetworkCredentialRecord
): TetiNetworkRegisterIdentityRequest | TetiNetworkAdoptIdentityRequest {
  const parsed = JSON.parse(rawBody) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw localConflict("identity_self", "Persisted Network identity request is invalid.");
  }
  const body = parsed as Record<string, unknown>;
  const client = body.clientInstance;
  if (body.schemaVersion !== 1
    || body.identityPublicKey !== credentials.identityRoot.publicKey
    || !client
    || typeof client !== "object"
    || Array.isArray(client)
    || (client as Record<string, unknown>).publicKey !== credentials.clientInstance.publicKey
    || (operation === "adopt"
      ? typeof body.tetiId !== "string" || typeof body.adoptionGrant !== "string"
      : body.tetiId !== undefined || body.adoptionGrant !== undefined)) {
    throw localConflict("identity_self", "Persisted Network identity request does not match local keys.");
  }
  return parsed as TetiNetworkRegisterIdentityRequest | TetiNetworkAdoptIdentityRequest;
}

function pendingRequestMatchesAccount(
  operation: "register" | "adopt",
  request: TetiNetworkRegisterIdentityRequest | TetiNetworkAdoptIdentityRequest,
  expectedOperation: "register" | "adopt",
  account: TetiAccount
): boolean {
  if (operation !== expectedOperation) return false;
  if (!request.delivery || request.delivery.address !== account.address) return false;
  if (request.delivery.publicKey !== (account.publicKey ?? null)) return false;
  return operation === "register"
    || (request as TetiNetworkAdoptIdentityRequest).tetiId === account.id;
}

function requireToken(value: string, label: string, maximumLength: number): string {
  if (typeof value !== "string"
    || !value
    || value.length > maximumLength
    || !/^[A-Za-z0-9._+-]+$/.test(value)) {
    throw new Error(`Teti Network ${label} is invalid.`);
  }
  return value;
}

function unauthorized(
  operation: "identity_adopt" | "identity_self",
  message: string
): TetiNetworkClientError {
  return new TetiNetworkClientError({
    code: "NETWORK_UNAUTHORIZED",
    operation,
    message,
    retryable: false
  });
}

function localConflict(
  operation: "identity_adopt" | "identity_self" | "client_enroll" | "client_revoke",
  message: string
): TetiNetworkClientError {
  return new TetiNetworkClientError({
    code: "NETWORK_CONFLICT",
    operation,
    message,
    retryable: false
  });
}
