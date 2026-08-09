import assert from "node:assert/strict";
import test from "node:test";
import { LegacyWorkerRegistrySyncAdapter } from "./legacy-worker-adapter.ts";

test("Legacy Worker sync adapter preserves write read-back without normalization drift", async () => {
  const identity = {
    version: 1 as const,
    id: "teti_ukouq6gz8",
    address: "ukouq6gz8@mail.seep.im",
    displayName: "Milo",
    publicKey: "public-key",
    publicProfile: { platform: "macOS", category: [], aiEnvironment: [] }
  };
  const adapter = new LegacyWorkerRegistrySyncAdapter("https://registry.teti.example", {
    fetchImpl: async (input) => {
      assert.equal(String(input), "https://registry.teti.example/profile/teti_ukouq6gz8");
      return Response.json({ success: true, data: identity });
    }
  });

  assert.deepEqual(await adapter.getIdentity(identity.id), identity);
});
