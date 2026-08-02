import assert from "node:assert/strict";
import test from "node:test";
import {
  compareTetiVersions,
  releaseStateForPolicy,
  type TetiReleasePolicy
} from "../../../core/release/policy.ts";
import {
  LocalReleasePolicyService,
  type ReleasePolicyClient,
  type ReleasePolicyStore
} from "../lifecycle-sidecar/runtime/release/service.ts";

const baseline: TetiReleasePolicy = {
  schemaVersion: 1,
  policyVersion: 1,
  channel: "beta",
  minimumSupportedVersion: "0.2.8",
  effectiveAt: "2026-08-02T00:00:00.000Z"
};

test("Release Policy compares the local app version, never a Peer version", () => {
  assert.equal(compareTetiVersions("0.2.8", "0.2.8"), 0);
  assert.equal(compareTetiVersions("0.2.7", "0.2.8"), -1);
  assert.equal(compareTetiVersions("0.3.0", "0.2.99"), 1);
  assert.equal(
    releaseStateForPolicy("0.2.7", baseline, new Date("2026-08-02T00:00:01.000Z")),
    "update_required"
  );
  assert.equal(
    releaseStateForPolicy("0.2.7", baseline, new Date("2026-08-01T23:59:59.000Z")),
    "supported",
    "a future policy floor must not lock early"
  );
});

test("Release Policy is fail-open without authoritative cached evidence", async () => {
  const service = createService(new MemoryReleasePolicyStore(), new ThrowingReleasePolicyClient());
  await service.initialize();

  assert.equal((await service.refresh()).state, "temporarily_unavailable");
});

test("an effective cached floor keeps an obsolete local build locked while offline", async () => {
  const store = new MemoryReleasePolicyStore({
    schemaVersion: 1,
    policy: { ...baseline, minimumSupportedVersion: "0.2.9", policyVersion: 2 },
    checkedAt: "2026-08-02T08:00:00.000Z"
  });
  const service = createService(store, new ThrowingReleasePolicyClient());

  assert.equal((await service.initialize()).state, "update_required");
  assert.equal((await service.refresh()).state, "update_required");
});

test("a newer network policy can advance the local version floor", async () => {
  const store = new MemoryReleasePolicyStore();
  const client: ReleasePolicyClient = {
    async getPolicy() {
      return { ...baseline, policyVersion: 3, minimumSupportedVersion: "0.2.9" };
    }
  };
  const service = createService(store, client);
  await service.initialize();
  const status = await service.refresh();

  assert.equal(status.state, "update_required");
  assert.equal(status.source, "network");
  assert.equal(store.value?.policy.minimumSupportedVersion, "0.2.9");
});

test("an authoritative obsolete floor locks this process even when cache persistence fails", async () => {
  const service = createService(
    {
      async load() { return null; },
      async save() { throw new Error("read-only profile"); }
    },
    {
      async getPolicy() {
        return { ...baseline, policyVersion: 4, minimumSupportedVersion: "0.2.9" };
      }
    }
  );
  await service.initialize();

  const status = await service.refresh();
  assert.equal(status.state, "update_required");
  assert.equal(status.source, "network");
  assert.equal(status.diagnosticCode, "RELEASE_POLICY_INVALID");
});

function createService(store: ReleasePolicyStore, client: ReleasePolicyClient) {
  return new LocalReleasePolicyService({
    currentVersion: "0.2.8",
    buildTimestamp: "2026-08-02T09:00:00.000Z",
    store,
    client,
    now: () => new Date("2026-08-02T09:00:00.000Z")
  });
}

class MemoryReleasePolicyStore implements ReleasePolicyStore {
  value: Awaited<ReturnType<ReleasePolicyStore["load"]>>;

  constructor(value: Awaited<ReturnType<ReleasePolicyStore["load"]>> = null) {
    this.value = value;
  }

  async load() {
    return this.value && structuredClone(this.value);
  }

  async save(value: NonNullable<Awaited<ReturnType<ReleasePolicyStore["load"]>>>) {
    this.value = structuredClone(value);
  }
}

class ThrowingReleasePolicyClient implements ReleasePolicyClient {
  async getPolicy(): Promise<TetiReleasePolicy> {
    throw new TypeError("offline");
  }
}
