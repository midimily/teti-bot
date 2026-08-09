import assert from "node:assert/strict";
import test from "node:test";
import { TetiConnectionState } from "../../../core/connection/types.ts";
import {
  projectNetworkRelationship,
  projectNetworkRelationshipRecovery
} from "../lifecycle-sidecar/runtime/network/relationship.ts";
import type { TetiNetworkRelationshipDocument } from "../../../services/network/types.ts";

test("Runtime maps all Network Relationship states without promoting local Accepted", () => {
  assert.deepEqual(projectNetworkRelationship(document("requested", "outgoing")), {
    archived: false,
    state: TetiConnectionState.Requested,
    direction: "outgoing"
  });
  assert.equal(
    projectNetworkRelationship(document("requested", "incoming")).state,
    TetiConnectionState.PendingApproval
  );
  assert.equal(projectNetworkRelationship(document("confirmed", "incoming")).state, TetiConnectionState.Confirmed);
  assert.equal(projectNetworkRelationship(document("rejected", "incoming")).state, TetiConnectionState.Rejected);
  assert.equal(projectNetworkRelationship(document("blocked", "incoming")).state, TetiConnectionState.Blocked);
  assert.equal(projectNetworkRelationship(document("revoked", "incoming")).archived, true);
  assert.equal(
    Object.values(["requested", "confirmed", "rejected", "blocked", "revoked"]).includes("Accepted"),
    false
  );
});

test("Runtime recovery persists canonical ID, revision, ETag, and viewer-relative block actor", () => {
  const relationship = document("blocked", "incoming", 7);
  const record = projectNetworkRelationshipRecovery({
    document: relationship,
    localAccount: {
      version: 1,
      id: "teti_aaaaaaaaa",
      address: "aaaaaaaaa@mail.seep.im",
      chatmailAccountId: 1,
      publicProfile: { platform: "macOS", category: [], aiEnvironment: [] },
      createdAt: relationship.createdAt
    },
    remoteIdentity: {
      id: "teti_bbbbbbbbb",
      address: "bbbbbbbbb@mail.seep.im",
      publicProfile: { platform: "macOS", category: [], aiEnvironment: [] }
    }
  });

  assert.equal(record?.requestId, "rel_AAAAAAAAAAAAAAAAAAAAAA");
  assert.equal(record?.networkRelationship?.revision, 7);
  assert.equal(record?.networkRelationship?.etag, '"relationship-r7"');
  assert.equal(record?.networkRelationship?.blockedBy, "peer");
  assert.equal(record?.state, TetiConnectionState.Blocked);
});

function document(
  state: TetiNetworkRelationshipDocument["state"],
  direction: TetiNetworkRelationshipDocument["direction"],
  revision = 1
): TetiNetworkRelationshipDocument {
  return {
    schemaVersion: 1,
    id: "rel_AAAAAAAAAAAAAAAAAAAAAA",
    revision,
    state,
    peerTetiId: "teti_bbbbbbbbb",
    requesterTetiId: direction === "outgoing" ? "teti_aaaaaaaaa" : "teti_bbbbbbbbb",
    addresseeTetiId: direction === "outgoing" ? "teti_bbbbbbbbb" : "teti_aaaaaaaaa",
    direction,
    blockedBy: state === "blocked" ? "peer" : null,
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:01:00.000Z",
    stateChangedAt: "2026-08-09T00:01:00.000Z"
  };
}
