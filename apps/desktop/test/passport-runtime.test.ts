import assert from "node:assert/strict";
import test from "node:test";
import type { TetiAccount } from "../../../core/account/model.ts";
import type { RemoteAiStatusSnapshot } from "../../../core/ai-status/types.ts";
import type { PeerConnectionDto } from "../src/lifecycle-bridge/protocol.ts";
import type { CodexUsageState } from "../src/codex-usage/types.ts";
import {
  mapCodexUsageResource,
  mapRemoteAiStatus
} from "../lifecycle-sidecar/runtime/passport/mappers.ts";
import { RuntimePassportService } from "../lifecycle-sidecar/runtime/passport/service.ts";
import { resourceSharingPolicy } from "../lifecycle-sidecar/runtime/passport/sharing.ts";

test("Codex usage maps to the frozen generic AI Resource contract", () => {
  const resource = mapCodexUsageResource(readyUsage(), "2026-07-22T00:00:00.000Z");
  assert.deepEqual(resource, {
    id: "openai.codex",
    provider: "OpenAI",
    product: "Codex",
    kind: "subscription",
    plan: { key: "plus", displayName: "Plus" },
    availability: "available",
    quotas: [{
      period: "week",
      remainingPercent: 42,
      resetAt: "2026-07-25T00:00:00.000Z",
      windowSeconds: 604_800,
      identification: "exact"
    }],
    assurance: "provider_observed",
    observedAt: "2026-07-22T00:00:00.000Z"
  });
  assert.doesNotMatch(JSON.stringify(resource), /token|accountId|raw/);
});

test("remote Passport state distinguishes unknown, disabled, fresh, and stale without never_shared", () => {
  const now = new Date("2026-07-22T00:10:00.000Z");
  assert.equal(mapRemoteAiStatus(undefined, now).state, "unknown");
  assert.equal(mapRemoteAiStatus(remoteStatus("disabled", "2026-07-22T00:20:00.000Z"), now).state, "disabled");
  assert.equal(mapRemoteAiStatus(remoteStatus("enabled", "2026-07-22T00:20:00.000Z"), now).state, "fresh");
  const stale = mapRemoteAiStatus(remoteStatus("enabled", "2026-07-22T00:10:00.000Z"), now);
  assert.equal(stale.state, "stale");
  assert.equal(stale.resources[0]?.availability, "stale");
});

test("Runtime Passport reads aggregate local caches only and keep revision stable", async () => {
  let accountReads = 0;
  let sharingReads = 0;
  let now = new Date("2026-07-22T00:00:00.000Z");
  const connection = peerConnection(remoteStatus("enabled", "2026-07-22T00:30:00.000Z"));
  const service = new RuntimePassportService({
    sources: {
      async loadAccount() {
        accountReads += 1;
        return account();
      },
      getConnections() { return [connection]; },
      getCodexUsage() { return readyUsage(); },
      getRegistry() { return { state: "registered" }; },
      async getSharing() {
        sharingReads += 1;
        return resourceSharingPolicy(false);
      }
    },
    now: () => now
  });

  const first = await service.getSnapshot();
  now = new Date("2026-07-22T00:00:03.000Z");
  const second = await service.getSnapshot();
  assert.equal(first.revision, 1);
  assert.equal(second.revision, 1);
  assert.equal(second.generatedAt, first.generatedAt);
  assert.equal(second.identity?.displayName, "Milo");
  assert.equal(second.connections[0]?.passport.state, "fresh");
  assert.equal(accountReads, 2);
  assert.equal(sharingReads, 2);
});

function readyUsage(): CodexUsageState {
  return {
    status: "ready",
    snapshot: {
      source: "live",
      planTypeRaw: "plus",
      planDisplayName: null,
      membershipVerified: false,
      weekly: {
        remainingPercent: 42,
        usedPercent: 58,
        resetAt: "2026-07-25T00:00:00.000Z",
        windowSeconds: 604_800,
        identification: "exact"
      },
      observedAt: "2026-07-22T00:00:00.000Z",
      fetchedAt: "2026-07-22T00:00:00.000Z",
      stale: false
    }
  };
}

function remoteStatus(
  sharing: "enabled" | "disabled",
  expiresAt: string
): RemoteAiStatusSnapshot {
  return {
    schemaVersion: 1,
    sharing,
    generatedAt: "2026-07-22T00:00:00.000Z",
    expiresAt,
    receivedAt: "2026-07-22T00:00:01.000Z",
    tools: sharing === "enabled" ? [{
      toolId: "openai.codex",
      status: "ready",
      plan: { key: "plus", membershipVerified: false },
      quotas: [],
      observedAt: "2026-07-22T00:00:00.000Z"
    }] : []
  };
}

function peerConnection(remoteAiStatus: RemoteAiStatusSnapshot): PeerConnectionDto {
  return {
    requestId: "request-1",
    state: "Confirmed",
    direction: "outgoing",
    remoteTetiId: "teti_remote001",
    remoteAddress: "remote001@mail.seep.im",
    remoteDisplayName: "Remote",
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-21T00:00:00.000Z",
    lastHeartbeatReceivedAt: "2026-07-22T00:00:00.000Z",
    remoteAiStatus
  };
}

function account(): TetiAccount {
  return {
    version: 1,
    id: "teti_local0001",
    address: "local0001@mail.seep.im",
    displayName: "Milo",
    chatmailAccountId: 1,
    publicProfile: { platform: "macOS", category: [], aiEnvironment: [] },
    createdAt: "2026-07-21T00:00:00.000Z"
  };
}
