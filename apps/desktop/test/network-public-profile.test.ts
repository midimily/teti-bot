import assert from "node:assert/strict";
import test from "node:test";
import { projectNetworkPublicProfile } from "../lifecycle-sidecar/runtime/network/public-profile.ts";

test("Network PublicProfile projection excludes Presence, Resource, Agent metadata, and Passport policy", () => {
  const result = projectNetworkPublicProfile({
    version: 1,
    id: "teti_c77np4w6r",
    address: "c77np4w6r@mail.seep.im",
    displayName: " Casey ",
    chatmailAccountId: 1,
    publicProfile: {
      platform: "macOS",
      category: ["developer", "Developer", "not allowed"],
      aiEnvironment: ["Codex"],
      lastSeen: "2026-08-09T09:00:00.000Z",
      device: {
        os: { name: "macOS", version: "15" },
        hardware: { architecture: "arm64", model: "Mac" }
      },
      location: { city: "Hong Kong" }
    },
    createdAt: "2026-08-09T00:00:00.000Z"
  }, [{
    schemaVersion: 1,
    agentId: "codex",
    adapterId: "codex-local",
    adapterRevision: 7,
    capabilityIds: ["image-editing", "code-analysis"],
    inputModes: ["text"],
    outputModes: ["text"],
    readyAt: "2026-08-09T09:00:00.000Z"
  }]);

  assert.deepEqual(result, {
    profile: {
      displayName: "Casey",
      avatarUrl: null,
      summary: null,
      capabilitySummary: {
        schemaVersion: 1,
        platform: "macos",
        category: ["developer"],
        capabilityIds: ["code-analysis", "image-editing"]
      }
    },
    isDiscoverable: true
  });
  const serialized = JSON.stringify(result);
  for (const privateField of ["lastSeen", "device", "location", "agentId", "adapterId", "readyAt", "sharing"]) {
    assert.equal(serialized.includes(privateField), false);
  }
});
