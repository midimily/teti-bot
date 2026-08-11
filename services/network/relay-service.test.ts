import assert from "node:assert/strict";
import test from "node:test";
import { MemoryTetiAccountStorage } from "../../core/account/storage.ts";
import { TetiNetworkClientError } from "./errors.ts";
import { FakeTetiNetworkClient } from "./fake-client.ts";
import { MemoryTetiNetworkRelayBindingStore } from "./relay-binding-store.ts";
import { TetiNetworkRelayService } from "./relay-service.ts";
import { generateTetiNetworkSigningKey } from "./signing.ts";
import type {
  TetiNetworkAdoptRelayBindingRequest,
  TetiNetworkAuthenticatedSigner,
  TetiNetworkPutRelayBindingRequest,
  TetiNetworkRelayBindingResult,
  TetiNetworkRelayBindingWriteOptions
} from "./types.ts";

const ACCOUNT = {
  version: 1 as const,
  id: "teti_a1b2c3d4e",
  address: "a1b2c3d4e@mail.seep.im",
  displayName: "Alex",
  chatmailAccountId: 7,
  publicKey: "CHATMAIL-TRANSPORT-KEY-A",
  publicProfile: {},
  createdAt: "2026-08-11T09:00:00.000Z"
};

const AUTHENTICATION: TetiNetworkAuthenticatedSigner = {
  clientInstanceId: "ci_AAAAAAAAAAAAAAAAAAAAAA",
  signingKey: generateTetiNetworkSigningKey()
};

test("Relay service confirms Network bootstrap against the authoritative catalog before provisioning", async () => {
  const client = configuredClient();
  const service = await createService(client);

  assert.deepEqual(await service.selectProvisioningRelay(), {
    relay: relayCatalogItem(),
    accountQr: "dcaccount:mail.seep.im",
    expectedAddressSuffix: "@mail.seep.im"
  });
  assert.equal(client.calls, 1);
  assert.equal(client.relayListCalls, 1);

  client.setRelayCatalog({
    schemaVersion: 1,
    relays: [{ ...relayCatalogItem(), acceptsNewAccounts: false }],
    generatedAt: "2026-08-11T10:00:00.000Z"
  });
  await assert.rejects(
    () => service.selectProvisioningRelay(),
    (error) => error instanceof TetiNetworkClientError
      && error.code === "RELAY_UNAVAILABLE"
      && error.operation === "relay_list"
  );
});

test("Relay service accepts only an exact active binding and caches it per Network environment", async () => {
  const client = configuredClient();
  client.setRelayBindingResult(bindingResult(1));
  const store = new MemoryTetiNetworkRelayBindingStore();
  const service = await createService(client, { store });

  const result = await service.synchronize();

  assert.equal(result.document.active?.id, "rb_AAAAAAAAAAAAAAAAAAAAAA");
  assert.equal(client.relayBindingSelfCalls.length, 1);
  assert.equal(client.relayBindingAdoptCalls.length, 0);
  assert.deepEqual(await store.load(), {
    schemaVersion: 1,
    environment: "local_development",
    result,
    verifiedAt: "2026-08-11T10:00:00.000Z"
  });

  client.setRelayBindingResult(bindingResult(1, {
    address: "other0001@mail.seep.im",
    mailbox: "other0001"
  }));
  await assert.rejects(
    () => service.synchronize(),
    (error) => error instanceof TetiNetworkClientError
      && error.code === "RELAY_BINDING_CONFLICT"
  );
});

test("existing Chatmail account adoption is explicit, exact, and never reprovisions the account", async () => {
  const deniedClient = configuredClient();
  deniedClient.setRelayBindingResult(emptyBindingResult());
  await assert.rejects(
    () => createService(deniedClient).then((service) => service.synchronize()),
    (error) => error instanceof TetiNetworkClientError
      && error.code === "RELAY_BINDING_ADOPTION_DENIED"
  );

  const client = new AdoptingClient(bootstrap());
  client.setRelayCatalog(catalog());
  client.setRelayBindingResult(emptyBindingResult());
  const service = await createService(client, { adoptionGrant: "TEST-ONLY-OPERATOR-GRANT" });

  const result = await service.synchronize();

  assert.equal(result.document.active?.address, ACCOUNT.address);
  assert.deepEqual(client.relayBindingAdoptCalls[0]?.input, {
    schemaVersion: 1,
    expectedRevision: 0,
    relayId: "relay_mail_seep_im",
    mailbox: "a1b2c3d4e",
    transportPublicKey: ACCOUNT.publicKey,
    adoptionGrant: "TEST-ONLY-OPERATOR-GRANT"
  });
  assert.equal(client.relayBindingAdoptCalls[0]?.options.ifMatch, '"relay-bindings-r0"');
  assert.equal(client.relayBindingAdoptCalls[0]?.options.rawBody?.includes("password"), false);
});

test("Relay migration retries preserve the exact command and idempotency key across Runtime restart", async () => {
  const store = new MemoryTetiNetworkRelayBindingStore();
  const failing = new FailingCreateClient(bootstrap());
  failing.setRelayCatalog(catalog());
  failing.setRelayBindingResult(bindingResult(1));
  const first = await createService(failing, {
    store,
    idempotencyKeyFactory: () => "relay.create:00000000-0000-4000-8000-000000000000"
  });

  await assert.rejects(
    () => first.createMigratingBinding({
      relayId: "relay_mail2_seep_im",
      mailbox: "a1b2c3d4e-next",
      transportPublicKey: "CHATMAIL-TRANSPORT-KEY-B"
    }),
    (error) => error instanceof TetiNetworkClientError && error.code === "NETWORK_TIMEOUT"
  );
  const pending = (await store.load())?.pending;
  assert.equal(pending?.path, "/v1/relay-bindings/create");

  const recovered = new CreatingClient(bootstrap());
  recovered.setRelayCatalog(catalog());
  recovered.setRelayBindingResult(bindingResult(1));
  const second = await createService(recovered, {
    store,
    idempotencyKeyFactory: () => {
      throw new Error("A recovered exact command must not mint another idempotency key.");
    }
  });
  const result = await second.createMigratingBinding({
    relayId: "relay_mail2_seep_im",
    mailbox: "a1b2c3d4e-next",
    transportPublicKey: "CHATMAIL-TRANSPORT-KEY-B"
  });

  assert.equal(result.document.migrating?.address, "a1b2c3d4e-next@mail2.seep.im");
  assert.equal(recovered.relayBindingCreateCalls[0]?.options.idempotencyKey, pending?.idempotencyKey);
  assert.equal(recovered.relayBindingCreateCalls[0]?.options.rawBody, pending?.rawBody);
  assert.equal((await store.load())?.pending, undefined);
});

async function createService(
  client: FakeTetiNetworkClient,
  options: {
    store?: MemoryTetiNetworkRelayBindingStore;
    adoptionGrant?: string;
    idempotencyKeyFactory?: () => string;
  } = {}
): Promise<TetiNetworkRelayService> {
  const accountStorage = new MemoryTetiAccountStorage();
  await accountStorage.save(ACCOUNT);
  return new TetiNetworkRelayService({
    client,
    accountStorage,
    store: options.store ?? new MemoryTetiNetworkRelayBindingStore(),
    environment: "local_development",
    getAuthentication: async () => ({
      tetiId: ACCOUNT.id,
      authentication: AUTHENTICATION
    }),
    adoptionGrant: options.adoptionGrant,
    now: () => new Date("2026-08-11T10:00:00.000Z"),
    idempotencyKeyFactory: options.idempotencyKeyFactory
  });
}

function configuredClient(): FakeTetiNetworkClient {
  const client = new FakeTetiNetworkClient(bootstrap());
  client.setRelayCatalog(catalog());
  return client;
}

function bootstrap() {
  return {
    protocolVersion: 1,
    contractRevision: 8,
    service: { name: "teti-network" as const, version: "0.1.8" },
    serverTime: "2026-08-11T10:00:00.000Z",
    protocolSupport: { minimumSupportedVersion: 1, supportedVersions: [1] },
    releasePolicy: {
      schemaVersion: 1 as const,
      policyVersion: 1,
      channel: "beta" as const,
      minimumSupportedVersion: "0.3.0",
      effectiveAt: "2026-08-08T00:00:00.000Z"
    },
    capabilities: {
      publicDirectory: true,
      identity: true,
      clientAuthentication: true,
      presence: true,
      publicProfile: true,
      relationships: true,
      relayBindings: true,
      invites: false
    },
    presencePolicy: {
      collaborating: { reportEverySeconds: 5, ttlSeconds: 20 },
      viewing_connect: { reportEverySeconds: 5, ttlSeconds: 20 },
      online: { reportEverySeconds: 15, ttlSeconds: 45 },
      background: { reportEverySeconds: 30, ttlSeconds: 90 }
    },
    relayBootstrap: {
      schemaVersion: 1 as const,
      preferredRelay: {
        id: "relay_mail_seep_im",
        domain: "mail.seep.im",
        region: "osaka",
        accountProvisioning: { type: "chatmail_qr" as const, value: "dcaccount:mail.seep.im" }
      },
      catalogPath: "/v1/relays" as const
    }
  };
}

function relayCatalogItem() {
  return {
    id: "relay_mail_seep_im",
    domain: "mail.seep.im",
    region: "osaka",
    status: "active" as const,
    acceptsNewAccounts: true,
    accountProvisioning: { type: "chatmail_qr" as const, value: "dcaccount:mail.seep.im" }
  };
}

function catalog() {
  return {
    schemaVersion: 1 as const,
    relays: [
      relayCatalogItem(),
      {
        id: "relay_mail2_seep_im",
        domain: "mail2.seep.im",
        region: "tokyo",
        status: "active" as const,
        acceptsNewAccounts: true,
        accountProvisioning: { type: "chatmail_qr" as const, value: "dcaccount:mail2.seep.im" }
      }
    ],
    generatedAt: "2026-08-11T10:00:00.000Z"
  };
}

function emptyBindingResult(): TetiNetworkRelayBindingResult {
  return {
    document: {
      schemaVersion: 1,
      tetiId: ACCOUNT.id,
      revision: 0,
      active: null,
      migrating: null,
      updatedAt: null
    },
    etag: '"relay-bindings-r0"'
  };
}

function bindingResult(
  revision: number,
  activeOverride: { address: string; mailbox: string } | undefined = undefined,
  withMigrating = false
): TetiNetworkRelayBindingResult {
  return {
    document: {
      schemaVersion: 1,
      tetiId: ACCOUNT.id,
      revision,
      active: {
        id: "rb_AAAAAAAAAAAAAAAAAAAAAA",
        relay: { id: "relay_mail_seep_im", domain: "mail.seep.im", region: "osaka", status: "active" },
        mailbox: activeOverride?.mailbox ?? "a1b2c3d4e",
        address: activeOverride?.address ?? ACCOUNT.address,
        transportPublicKey: ACCOUNT.publicKey,
        status: "active",
        createdAt: "2026-08-11T09:00:00.000Z",
        updatedAt: "2026-08-11T09:00:00.000Z"
      },
      migrating: withMigrating ? {
        id: "rb_BBBBBBBBBBBBBBBBBBBBBB",
        relay: { id: "relay_mail2_seep_im", domain: "mail2.seep.im", region: "tokyo", status: "active" },
        mailbox: "a1b2c3d4e-next",
        address: "a1b2c3d4e-next@mail2.seep.im",
        transportPublicKey: "CHATMAIL-TRANSPORT-KEY-B",
        status: "migrating",
        createdAt: "2026-08-11T10:00:00.000Z",
        updatedAt: "2026-08-11T10:00:00.000Z"
      } : null,
      updatedAt: "2026-08-11T10:00:00.000Z"
    },
    etag: `"relay-bindings-r${revision}"`
  };
}

class AdoptingClient extends FakeTetiNetworkClient {
  override async adoptRelayBinding(
    input: TetiNetworkAdoptRelayBindingRequest,
    authentication: TetiNetworkAuthenticatedSigner,
    options: TetiNetworkRelayBindingWriteOptions
  ): Promise<TetiNetworkRelayBindingResult> {
    this.setRelayBindingResult(bindingResult(1));
    return super.adoptRelayBinding(input, authentication, options);
  }
}

class FailingCreateClient extends FakeTetiNetworkClient {
  override async createRelayBinding(
    input: TetiNetworkPutRelayBindingRequest,
    _authentication: TetiNetworkAuthenticatedSigner,
    options: TetiNetworkRelayBindingWriteOptions
  ): Promise<TetiNetworkRelayBindingResult> {
    this.relayBindingCreateCalls.push({ input: structuredClone(input), options: { ...options } });
    throw new TetiNetworkClientError({
      code: "NETWORK_TIMEOUT",
      operation: "relay_binding_create",
      message: "Timed out after an unknown commit boundary.",
      retryable: true
    });
  }
}

class CreatingClient extends FakeTetiNetworkClient {
  override async createRelayBinding(
    input: TetiNetworkPutRelayBindingRequest,
    authentication: TetiNetworkAuthenticatedSigner,
    options: TetiNetworkRelayBindingWriteOptions
  ): Promise<TetiNetworkRelayBindingResult> {
    this.setRelayBindingResult(bindingResult(2, undefined, true));
    return super.createRelayBinding(input, authentication, options);
  }
}
