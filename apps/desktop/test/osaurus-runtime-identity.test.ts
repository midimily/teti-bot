import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  OSAURUS_BUNDLE_IDENTIFIER,
  OSAURUS_DEVELOPER_TEAM_ID,
  OsaurusRuntimeIdentityVerifier,
  type OsaurusRuntimeIdentitySystem
} from "../../../integrations/agents/osaurus/runtime-identity.ts";

const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-07-29T04:00:00.000Z");

test("Osaurus identity binds fresh shared config, listener PID, app bundle, and signature", async () => {
  const fixture = await runtimeFixture();
  try {
    const system = fakeSystem(fixture.executablePath);
    const verifier = new OsaurusRuntimeIdentityVerifier({
      runtimeRoot: fixture.runtimeRoot,
      homeDirectory: fixture.home,
      now: () => NOW,
      system
    });
    const identity = await verifier.discoverLatestTrustedRuntime();
    assert.ok(identity);
    assert.equal(identity.listenerPid, 4242);
    assert.equal(identity.bundleIdentifier, OSAURUS_BUNDLE_IDENTIFIER);
    assert.equal(identity.teamIdentifier, OSAURUS_DEVELOPER_TEAM_ID);
    assert.match(identity.codeIdentityHash, /^sha256:[a-f0-9]{64}$/);

    await verifier.verifyListener({
      endpoint: identity.endpoint,
      runtimeInstanceId: identity.instanceId,
      listenerPid: identity.listenerPid,
      codeIdentityHash: identity.codeIdentityHash
    });
    await verifier.verifyConnectedSocket({
      endpoint: identity.endpoint,
      runtimeInstanceId: identity.instanceId,
      listenerPid: identity.listenerPid,
      codeIdentityHash: identity.codeIdentityHash,
      clientPort: 54321,
      serverPort: 1337
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("localhost metadata cannot bless a port owned by a differently signed process", async () => {
  const fixture = await runtimeFixture();
  try {
    const system = fakeSystem(fixture.executablePath, {
      teamIdentifier: "ATTACKER123"
    });
    const verifier = new OsaurusRuntimeIdentityVerifier({
      runtimeRoot: fixture.runtimeRoot,
      homeDirectory: fixture.home,
      now: () => NOW,
      system
    });
    assert.deepEqual(await verifier.discoverRuntime(), {
      state: "untrusted",
      identity: null
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("an old shared-config timestamp remains eligible when the signed listener is live", async () => {
  const fixture = await runtimeFixture({ updatedAt: "2025-07-29T04:00:00.000Z" });
  try {
    const verifier = new OsaurusRuntimeIdentityVerifier({
      runtimeRoot: fixture.runtimeRoot,
      homeDirectory: fixture.home,
      now: () => NOW,
      system: fakeSystem(fixture.executablePath)
    });
    assert.ok(await verifier.discoverLatestTrustedRuntime());
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("exposed, hostname, future-dated, and wrong-PID runtime claims fail closed", async () => {
  for (const mutation of [
    { exposeToNetwork: true },
    { updatedAt: "2026-07-29T04:01:00.000Z" },
    { address: "localhost", url: "http://localhost:1337" }
  ]) {
    const fixture = await runtimeFixture(mutation);
    try {
      const verifier = new OsaurusRuntimeIdentityVerifier({
        runtimeRoot: fixture.runtimeRoot,
        homeDirectory: fixture.home,
        now: () => NOW,
        system: fakeSystem(fixture.executablePath)
      });
      assert.equal(await verifier.discoverLatestTrustedRuntime(), null);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }

  const fixture = await runtimeFixture();
  try {
    const verifier = new OsaurusRuntimeIdentityVerifier({
      runtimeRoot: fixture.runtimeRoot,
      homeDirectory: fixture.home,
      now: () => NOW,
      system: fakeSystem(fixture.executablePath, { establishedPids: [9999] })
    });
    const identity = await verifier.discoverLatestTrustedRuntime();
    assert.ok(identity);
    await assert.rejects(() => verifier.verifyConnectedSocket({
      endpoint: identity.endpoint,
      runtimeInstanceId: identity.instanceId,
      listenerPid: identity.listenerPid,
      codeIdentityHash: identity.codeIdentityHash,
      clientPort: 54321,
      serverPort: 1337
    }));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function runtimeFixture(mutation: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "teti-osaurus-identity-"));
  const home = join(root, "home");
  const appPath = join(home, "Applications", "Osaurus.app");
  const executablePath = join(appPath, "Contents", "MacOS", "osaurus");
  const runtimeRoot = join(home, ".osaurus", "runtime");
  const instancePath = join(runtimeRoot, INSTANCE_ID);
  await mkdir(join(appPath, "Contents", "MacOS"), { recursive: true });
  await mkdir(instancePath, { recursive: true });
  await writeFile(executablePath, "signed fixture", "utf8");
  await writeFile(join(instancePath, "configuration.json"), JSON.stringify({
    instanceId: INSTANCE_ID,
    updatedAt: NOW.toISOString(),
    port: 1337,
    address: "127.0.0.1",
    url: "http://127.0.0.1:1337",
    exposeToNetwork: false,
    health: "running",
    ...mutation
  }), "utf8");
  return { root, home, appPath, executablePath, runtimeRoot };
}

function fakeSystem(
  executablePath: string,
  overrides: {
    listenerPids?: number[];
    establishedPids?: number[];
    teamIdentifier?: string;
  } = {}
): OsaurusRuntimeIdentitySystem {
  return {
    async listenerPids() { return overrides.listenerPids ?? [4242]; },
    async establishedServerPids() { return overrides.establishedPids ?? [4242]; },
    async executablePath() { return executablePath; },
    async verifySignature() {
      return {
        bundleIdentifier: OSAURUS_BUNDLE_IDENTIFIER,
        teamIdentifier: overrides.teamIdentifier ?? OSAURUS_DEVELOPER_TEAM_ID,
        codeDirectoryHash: "a".repeat(40)
      };
    },
    async readBundleValue(_appPath, key) {
      if (key === "CFBundleIdentifier") return OSAURUS_BUNDLE_IDENTIFIER;
      if (key === "CFBundleShortVersionString") return "0.22.2";
      return null;
    }
  };
}
