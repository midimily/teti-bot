import assert from "node:assert/strict";
import test from "node:test";
import type { TetiAccount, TetiStatus } from "../../../core/account/model.ts";
import {
  LIFECYCLE_MAX_LINE_BYTES,
  LIFECYCLE_PROTOCOL_VERSION,
  type LifecycleRequest
} from "../src/lifecycle-bridge/protocol.ts";
import {
  handleLifecycleLine,
  handleLifecycleRequest,
  type LifecycleSidecarDependencies
} from "../lifecycle-sidecar/handler.ts";
import { redactSecretLikeText } from "../lifecycle-sidecar/security.ts";

test("sidecar returns health response", async () => {
  const response = await handleLifecycleRequest(request("lifecycle.health"), fakeDependencies());

  assert.equal(response.ok, true);
  assert.equal(response.id, "r1");
  assert.equal(response.ok && response.result.status, "ok");
});

test("sidecar reports missing account without creating one", async () => {
  const deps = fakeDependencies();
  const response = await handleLifecycleRequest(request("account.status"), deps);

  assert.equal(response.ok, true);
  assert.deepEqual(response.ok && response.result, {
    exists: false,
    registered: false,
    onlineStatus: "unknown"
  });
  assert.equal(deps.createCalls.length, 0);
});

test("sidecar loads public account DTO only", async () => {
  const account = createAccount("Milo") as TetiAccount & { privateKey?: string; password?: string };
  account.privateKey = "secret-private-key";
  account.password = "secret-password";
  const response = await handleLifecycleRequest(request("account.load"), fakeDependencies({ account }));

  assert.equal(response.ok, true);
  assert.equal(response.ok && response.result?.id, account.id);
  assert.equal(JSON.stringify(response), JSON.stringify(response).includes("secret") ? "leaked" : JSON.stringify(response));
});

test("sidecar creates account through injected authoritative lifecycle", async () => {
  const deps = fakeDependencies();
  const response = await handleLifecycleRequest(
    request("account.create", { name: "  Milo  " }),
    deps
  );

  assert.equal(response.ok, true);
  assert.deepEqual(deps.createCalls, ["Milo"]);
  assert.equal(response.ok && response.result?.displayName, "Milo");
});

test("sidecar rejects invalid methods and protocol versions", async () => {
  const unknown = await handleLifecycleRequest(
    { version: 1, id: "bad-method", method: "shell.exec", params: {} },
    fakeDependencies()
  );
  const wrongVersion = await handleLifecycleRequest(
    { version: 2, id: "bad-version", method: "lifecycle.health", params: {} },
    fakeDependencies()
  );

  assert.equal(unknown.ok, false);
  assert.equal(!unknown.ok && unknown.error.code, "UNKNOWN_METHOD");
  assert.equal(wrongVersion.ok, false);
  assert.equal(!wrongVersion.ok && wrongVersion.error.code, "UNSUPPORTED_PROTOCOL_VERSION");
});

test("sidecar rejects malformed and oversized requests", async () => {
  const malformed = await handleLifecycleLine("{not-json", fakeDependencies());
  const oversized = await handleLifecycleLine("x".repeat(LIFECYCLE_MAX_LINE_BYTES + 1), fakeDependencies());

  assert.equal(malformed.ok, false);
  assert.equal(!malformed.ok && malformed.error.code, "MALFORMED_REQUEST");
  assert.equal(oversized.ok, false);
  assert.equal(!oversized.ok && oversized.error.code, "OVERSIZED_REQUEST");
});

test("sidecar redacts secret-like errors", async () => {
  const deps = fakeDependencies();
  deps.createTetiAccount = async () => {
    throw new Error("failed password=abc token=def privateKey super-secret");
  };

  const response = await handleLifecycleRequest(request("account.create", { name: "Milo" }), deps);

  assert.equal(response.ok, false);
  assert.equal(JSON.stringify(response).includes("abc"), false);
  assert.equal(JSON.stringify(response).includes("def"), false);
  assert.equal(redactSecretLikeText("authorization:Bearer abc").includes("abc"), false);
});

test("sidecar discovery retry registers existing account without creating another one", async () => {
  const deps = fakeDependencies({ account: createAccount("Milo") });
  const response = await handleLifecycleRequest(request("discovery.retry"), deps);

  assert.equal(response.ok, true);
  assert.equal(deps.registerCalls.length, 1);
  assert.equal(deps.createCalls.length, 0);
});

test("sidecar routes peer resolution and connection polling through the bounded bridge", async () => {
  const deps = fakeDependencies({ account: createAccount("Milo") });
  const resolved = await handleLifecycleRequest(request("connection.resolve", { query: "076bm9evq" }), deps);
  const polled = await handleLifecycleRequest(request("connection.poll"), deps);

  assert.equal(resolved.ok, true);
  assert.equal(resolved.ok && resolved.result?.id, "teti_076bm9evq");
  assert.deepEqual(polled.ok && polled.result, {
    connections: [],
    receivedCount: 0,
    heartbeatCount: 0
  });
});

function request(method: LifecycleRequest["method"], params: Record<string, unknown> = {}): LifecycleRequest {
  return {
    version: LIFECYCLE_PROTOCOL_VERSION,
    id: "r1",
    method,
    params
  };
}

function fakeDependencies(options: { account?: TetiAccount | null } = {}): LifecycleSidecarDependencies & {
  createCalls: string[];
  registerCalls: TetiAccount[];
} {
  const createCalls: string[] = [];
  const registerCalls: TetiAccount[] = [];
  let account = options.account ?? null;

  return {
    createCalls,
    registerCalls,
    async loadTetiAccount() {
      return account ? clone(account) : null;
    },
    async createTetiAccount(input: { name: string }) {
      createCalls.push(input.name);
      account = createAccount(input.name);
      return clone(account);
    },
    async getTetiStatus(): Promise<TetiStatus> {
      return {
        exists: account !== null,
        registered: account !== null && registerCalls.length > 0,
        onlineStatus: "unknown"
      };
    },
    async registerDiscovery(existing: TetiAccount) {
      registerCalls.push(clone(existing));
    },
    async getPeerConnectionService() {
      const empty = { connections: [], receivedCount: 0, heartbeatCount: 0 } as const;
      return {
        async resolve(query: string) {
          return {
            id: `teti_${query}`,
            address: "remote@mail.seep.im",
            publicKey: "remote-public-key",
            publicProfile: {}
          };
        },
        async request() { return empty; },
        async list() { return empty; },
        async poll() { return empty; },
        async accept() { return empty; },
        async reject() { return empty; }
      };
    }
  };
}

function createAccount(displayName: string): TetiAccount {
  return {
    version: 1,
    id: `teti_${displayName.toLowerCase()}`,
    address: `${displayName.toLowerCase()}@mail.seep.im`,
    displayName,
    chatmailAccountId: 7,
    publicKey: "public-key",
    publicProfile: {
      platform: "macOS",
      category: ["developer"],
      aiEnvironment: ["Teti Desktop Lifecycle Bridge Alpha"]
    },
    createdAt: new Date().toISOString()
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
