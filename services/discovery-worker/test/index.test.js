import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "../src/index.js";

test("register stores a public identity card with timestamps and ttl", async () => {
  const env = createEnv();
  const response = await handleRequest(jsonRequest("https://registry.test/register", {
    version: 1,
    id: "teti_a83kd9",
    address: "yxmtewmvc@mail.seep.im",
    displayName: "Milo",
    publicKey: "x".repeat(2048),
    publicProfile: {
      platform: "macOS",
      category: ["developer", "designer"],
      aiEnvironment: ["Claude Code", "Cursor"]
    }
  }), env);

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.data.id, "teti_a83kd9");
  assert.equal(body.data.address, "yxmtewmvc@mail.seep.im");
  assert.equal(body.data.displayName, "Milo");
  assert.equal(body.data.privateKey, undefined);
  assert.equal(JSON.parse(env.store.get("teti:teti_a83kd9")).displayName, "Milo");
  assert.equal(env.putOptions.get("teti:teti_a83kd9").expirationTtl, 604800);
});

test("register rejects private fields", async () => {
  const env = createEnv();
  const response = await handleRequest(jsonRequest("https://registry.test/register", {
    version: 1,
    id: "teti_a83kd9",
    address: "teti_a83kd9@mail.seep.im",
    publicKey: "ed25519-public-key",
    publicProfile: {
      platform: "macOS",
      privateProfile: { secret: true }
    }
  }), env);

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.success, false);
});

test("register is idempotent for the same relay identity and refreshes ttl", async () => {
  const env = createEnv();
  const payload = {
    version: 1,
    id: "teti_a83kd9",
    address: "yxmtewmvc@mail.seep.im",
    publicKey: "stable-public-key",
    publicProfile: { platform: "macOS" }
  };

  assert.equal((await handleRequest(jsonRequest("https://registry.test/register", payload), env)).status, 201);
  const retry = await handleRequest(jsonRequest("https://registry.test/register", payload), env);

  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).data.id, payload.id);
  assert.equal(env.putOptions.get("teti:teti_a83kd9").expirationTtl, 604800);
});

test("registration retry backfills display name into an existing identity", async () => {
  const env = createEnv();
  const payload = {
    version: 1,
    id: "teti_a83kd9",
    address: "yxmtewmvc@mail.seep.im",
    publicKey: "stable-public-key",
    publicProfile: { platform: "macOS" }
  };

  assert.equal((await handleRequest(jsonRequest("https://registry.test/register", payload), env)).status, 201);
  const retry = await handleRequest(jsonRequest("https://registry.test/register", {
    ...payload,
    displayName: "Milo"
  }), env);

  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).data.displayName, "Milo");
  assert.equal(JSON.parse(env.store.get("teti:teti_a83kd9")).displayName, "Milo");
});

test("register rejects an invalid display name", async () => {
  const env = createEnv();
  const response = await handleRequest(jsonRequest("https://registry.test/register", {
    version: 1,
    id: "teti_a83kd9",
    address: "yxmtewmvc@mail.seep.im",
    displayName: "12345678901",
    publicKey: "stable-public-key",
    publicProfile: { platform: "macOS" }
  }), env);

  assert.equal(response.status, 400);
  assert.match((await response.json()).message, /displayName/);
});

test("heartbeat updates only updatedAt and refreshes ttl", async () => {
  const env = createEnv();
  env.store.set("teti:teti_a83kd9", JSON.stringify({
    version: 1,
    id: "teti_a83kd9",
    address: "teti_a83kd9@mail.seep.im",
    publicKey: "ed25519-public-key",
    publicProfile: { platform: "macOS" },
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z"
  }));

  const response = await handleRequest(jsonRequest("https://registry.test/heartbeat", {
    id: "teti_a83kd9"
  }), env);

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.createdAt, "2026-07-10T00:00:00.000Z");
  assert.notEqual(body.data.updatedAt, "2026-07-10T00:00:00.000Z");
  assert.deepEqual(body.data.publicProfile, { platform: "macOS" });
  assert.equal(env.putOptions.get("teti:teti_a83kd9").expirationTtl, 604800);
});

test("heartbeat can update public AI environment and lastSeen", async () => {
  const env = createEnv();
  env.store.set("teti:teti_a83kd9", JSON.stringify({
    version: 1,
    id: "teti_a83kd9",
    address: "teti_a83kd9@mail.seep.im",
    publicKey: "ed25519-public-key",
    publicProfile: { platform: "macOS", aiEnvironment: ["Claude Code"] },
    lastSeen: "2026-07-10T00:00:00.000Z",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z"
  }));

  const response = await handleRequest(jsonRequest("https://registry.test/heartbeat", {
    id: "teti_a83kd9",
    publicProfile: {
      platform: "macOS",
      device: {
        os: {
          name: "macOS",
          version: "15.5"
        },
        hardware: {
          vendor: "Apple",
          model: "Mac Studio",
          architecture: "arm64"
        }
      },
      location: {
        country: "US",
        city: "San Francisco"
      },
      aiEnvironment: ["Claude Code", "Codex"],
      lastSeen: "2026-07-11T00:00:00.000Z"
    }
  }), env);

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.data.publicProfile, {
    platform: "macOS",
    device: {
      os: {
        name: "macOS",
        version: "15.5"
      },
      hardware: {
        vendor: "Apple",
        model: "Mac Studio",
        architecture: "arm64"
      }
    },
    location: {
      country: "US",
      city: "San Francisco"
    },
    aiEnvironment: ["Claude Code", "Codex"],
    lastSeen: "2026-07-11T00:00:00.000Z"
  });
  assert.equal(body.data.lastSeen, "2026-07-11T00:00:00.000Z");
});

test("heartbeat rejects private environment fields", async () => {
  const env = createEnv();
  env.store.set("teti:teti_a83kd9", JSON.stringify({
    version: 1,
    id: "teti_a83kd9",
    address: "teti_a83kd9@mail.seep.im",
    publicKey: "ed25519-public-key",
    publicProfile: { platform: "macOS" },
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z"
  }));

  const response = await handleRequest(jsonRequest("https://registry.test/heartbeat", {
    id: "teti_a83kd9",
    publicProfile: {
      platform: "macOS",
      aiEnvironment: ["Claude Code"],
      device: {
        os: {
          name: "macOS",
          version: "15.5"
        },
        hardware: {
          vendor: "Apple",
          model: "Mac Studio",
          architecture: "arm64",
          serialNumber: "must-not-leak"
        }
      },
      ip: "192.0.2.10",
      hostname: "private-host"
    }
  }), env);

  assert.equal(response.status, 400);
});

test("discover returns at most public identity fields", async () => {
  const env = createEnv();
  env.store.set("teti:teti_a83kd9", JSON.stringify({
    version: 1,
    id: "teti_a83kd9",
    address: "teti_a83kd9@mail.seep.im",
    publicKey: "ed25519-public-key",
    privateKey: "must-not-leak",
    publicProfile: { platform: "macOS" },
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z"
  }));

  const response = await handleRequest(new Request("https://registry.test/discover"), env);

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.items.length, 1);
  assert.equal(body.data.items[0].privateKey, undefined);
});

test("profile validates id", async () => {
  const env = createEnv();
  const response = await handleRequest(new Request("https://registry.test/profile/not-safe"), env);

  assert.equal(response.status, 400);
});

function jsonRequest(url, body) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

function createEnv() {
  const store = new Map();
  const putOptions = new Map();

  return {
    store,
    putOptions,
    TETI: {
      async get(key) {
        return store.get(key) || null;
      },
      async put(key, value, options) {
        store.set(key, value);
        putOptions.set(key, options);
      },
      async list({ prefix, limit }) {
        const keys = [...store.keys()]
          .filter((key) => key.startsWith(prefix))
          .slice(0, limit)
          .map((name) => ({ name }));

        return { keys };
      }
    }
  };
}
