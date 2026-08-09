import assert from "node:assert/strict";
import test from "node:test";
import { HttpTetiNetworkClient } from "./client.ts";
import { TetiNetworkClientError } from "./errors.ts";
import { generateTetiNetworkSigningKey } from "./signing.ts";

const SERVER_REQUEST_ID = "4a4f2fd6-62a8-49fd-9215-e79527bfc281";
const CLIENT_REQUEST_ID = "55555555-5555-4555-8555-555555555555";

test("HTTP client consumes Revision 6 bootstrap and sends versioned Runtime metadata", async () => {
  let request: Request | undefined;
  const client = createClient(async (input, init) => {
    request = new Request(input, init);
    return contractResponse({
      ...bootstrapBody(),
      futureField: { ignored: true },
      capabilities: { ...bootstrapBody().capabilities, futureCapability: true }
    });
  });

  const result = await client.getBootstrap();

  assert.equal(request?.url, "http://127.0.0.1:8788/v1/bootstrap");
  assert.equal(request?.method, "GET");
  assert.equal(request?.headers.get("accept"), "application/json");
  assert.equal(request?.headers.get("Teti-Protocol-Version"), "1");
  assert.equal(request?.headers.get("Teti-Client-Version"), "0.3.5");
  assert.equal(request?.headers.get("Teti-Client-Platform"), "macos");
  assert.equal(request?.headers.get("Teti-Client-Request-ID"), CLIENT_REQUEST_ID);
  assert.deepEqual(result, bootstrapBody());
});

test("HTTP client parses full nodes without confusing Identity and Chatmail keys", async () => {
  const node = publicNode();
  const client = createClient(async (input) => {
    assert.equal(String(input), "http://127.0.0.1:8788/v1/public/nodes/teti_c77np4w6r");
    return contractResponse({ ...node, futureField: true });
  });

  const result = await client.getPublicNode("teti_c77np4w6r");
  assert.equal(result.identityPublicKey, "ed25519:A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg");
  assert.equal(result.delivery.publicKey, "chatmail-key-c77np4w6r");
  assert.equal(result.delivery.address, "c77np4w6r@mail2.seep.im");
});

test("HTTP client serializes directory pagination and validates page counts", async () => {
  let request: Request | undefined;
  const client = createClient(async (input, init) => {
    request = new Request(input, init);
    return contractResponse(directoryPage());
  });

  const result = await client.listPublicNodes({
    limit: 2,
    sort: "updated_desc",
    cursor: "opaque cursor"
  });

  assert.equal(
    request?.url,
    "http://127.0.0.1:8788/v1/public/nodes?limit=2&sort=updated_desc&cursor=opaque+cursor"
  );
  assert.equal(result.items[0]?.id, "teti_a83kd9x2q");
  assert.equal(result.page.returnedCount, 1);

  const malformed = createClient(async () => contractResponse({
    ...directoryPage(),
    page: { limit: 2, returnedCount: 2, nextCursor: null }
  }));
  await assertInvalidResponse(() => malformed.listPublicNodes());
});

test("HTTP client parses durable public stats and rejects inconsistent counts", async () => {
  const client = createClient(async () => contractResponse({
    activeIdentityCount: 7,
    discoverableNodeCount: 3,
    generatedAt: "2026-08-08T12:00:00.000Z"
  }));
  assert.deepEqual(await client.getPublicStats(), {
    activeIdentityCount: 7,
    discoverableNodeCount: 3,
    generatedAt: "2026-08-08T12:00:00.000Z"
  });

  const malformed = createClient(async () => contractResponse({
    activeIdentityCount: 1,
    discoverableNodeCount: 2,
    generatedAt: "2026-08-08T12:00:00.000Z"
  }));
  await assertInvalidResponse(() => malformed.getPublicStats());
});

test("HTTP client maps identity 404 and rate-limit retry metadata by operation", async () => {
  const notFound = createClient(async () => contractResponse({
    error: {
      code: "IDENTITY_NOT_FOUND",
      message: "The requested Teti identity could not be resolved.",
      retryable: false
    },
    requestId: SERVER_REQUEST_ID
  }, 404));
  await assert.rejects(
    () => notFound.getPublicNode("teti_a83kd9x2q"),
    (error) => error instanceof TetiNetworkClientError
      && error.code === "IDENTITY_NOT_FOUND"
      && error.operation === "public_node"
      && error.retryable === false
  );

  const limited = createClient(async () => contractResponse({
    error: { code: "RATE_LIMITED", message: "Try later.", retryable: true },
    requestId: SERVER_REQUEST_ID
  }, 429, { "retry-after": "3" }));
  await assert.rejects(
    () => limited.listPublicNodes(),
    (error) => error instanceof TetiNetworkClientError
      && error.code === "RATE_LIMITED"
      && error.operation === "public_directory"
      && error.retryAfterMs === 3_000
  );
});

test("HTTP client maps dependency failure without exposing SQLite or Redis details", async () => {
  const client = createClient(async () => contractResponse({
    error: {
      code: "DEPENDENCY_UNAVAILABLE",
      message: "A required service dependency is temporarily unavailable.",
      retryable: true
    },
    requestId: SERVER_REQUEST_ID
  }, 503));

  await assert.rejects(
    () => client.getPublicStats(),
    (error) => error instanceof TetiNetworkClientError
      && error.code === "SERVER_UNAVAILABLE"
      && error.operation === "public_stats"
      && error.retryable
      && !error.message.includes("SQLite")
      && !error.message.includes("Redis")
  );
});

test("HTTP client reports and reads minimal signed Presence without idempotency or Profile", async () => {
  const requests: Request[] = [];
  const client = createClient(async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    if (request.method === "PUT") {
      return contractResponse({
        schemaVersion: 1,
        tetiId: "teti_c77np4w6r",
        sessionId: "ps_AAAAAAAAAAAAAAAAAAAAAA",
        sequence: 7,
        mode: "collaborating",
        activityMarker: "collaboration_active",
        reportedAt: "2026-08-09T08:00:00.000Z",
        expiresAt: "2026-08-09T08:00:20.000Z",
        expiresInSeconds: 20
      });
    }
    return contractResponse({
      schemaVersion: 1,
      tetiId: "teti_c77np4w6r",
      state: "offline",
      mode: null,
      activityMarker: null,
      reportedAt: null,
      observedAt: "2026-08-09T08:00:21.000Z",
      expiresAt: null,
      expiresInSeconds: 0
    });
  });
  const authentication = {
    clientInstanceId: "ci_AAAAAAAAAAAAAAAAAAAAAA",
    signingKey: generateTetiNetworkSigningKey()
  };
  const report = await client.reportPresence({
    schemaVersion: 1,
    sessionId: "ps_AAAAAAAAAAAAAAAAAAAAAA",
    sequence: 7,
    mode: "collaborating",
    activityMarker: "collaboration_active"
  }, authentication);
  const read = await client.getPresence("teti_c77np4w6r", authentication);

  assert.equal(report.sequence, 7);
  assert.equal(read.state, "offline");
  assert.equal(requests[0]?.method, "PUT");
  assert.equal(requests[0]?.headers.get("Teti-Idempotency-Key"), null);
  assert.equal(requests[0]?.headers.get("Teti-Client-Instance-ID"), authentication.clientInstanceId);
  assert.deepEqual(await requests[0]?.json(), {
    schemaVersion: 1,
    sessionId: "ps_AAAAAAAAAAAAAAAAAAAAAA",
    sequence: 7,
    mode: "collaborating",
    activityMarker: "collaboration_active"
  });
  assert.equal(requests[1]?.method, "GET");
  assert.equal(requests[1]?.url, "http://127.0.0.1:8788/v1/presence/teti_c77np4w6r");
});

test("HTTP client reads and fully replaces signed PublicProfile with strong ETag", async () => {
  const requests: Request[] = [];
  const client = createClient(async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const revision = request.method === "PUT" ? 1 : 0;
    return contractResponse({
      schemaVersion: 1,
      tetiId: "teti_c77np4w6r",
      revision,
      profile: request.method === "PUT" ? await request.clone().json().then((body) => body.profile) : {
        displayName: null,
        avatarUrl: null,
        summary: null,
        capabilitySummary: null
      },
      isDiscoverable: request.method === "PUT",
      updatedAt: request.method === "PUT" ? "2026-08-09T09:00:00.000Z" : null
    }, 200, {
      etag: `"profile-r${revision}"`,
      "cache-control": "no-store"
    });
  });
  const authentication = {
    clientInstanceId: "ci_AAAAAAAAAAAAAAAAAAAAAA",
    signingKey: generateTetiNetworkSigningKey()
  };
  const current = await client.getProfileSelf(authentication);
  const input = {
    schemaVersion: 1 as const,
    expectedRevision: current.document.revision,
    profile: {
      displayName: "Casey",
      avatarUrl: null,
      summary: null,
      capabilitySummary: {
        schemaVersion: 1 as const,
        platform: "macos" as const,
        category: ["developer"],
        capabilityIds: ["code-analysis"]
      }
    },
    isDiscoverable: true
  };
  const rawBody = JSON.stringify(input);
  const updated = await client.replaceProfileSelf(input, authentication, {
    ifMatch: current.etag,
    idempotencyKey: "profile.replace:00000000-0000-4000-8000-000000000000",
    rawBody
  });

  assert.equal(current.etag, '"profile-r0"');
  assert.equal(updated.document.revision, 1);
  assert.equal(requests[0]?.headers.get("Teti-Idempotency-Key"), null);
  assert.equal(requests[1]?.headers.get("If-Match"), '"profile-r0"');
  assert.equal(requests[1]?.headers.get("Teti-Idempotency-Key"), "profile.replace:00000000-0000-4000-8000-000000000000");
  assert.equal(await requests[1]?.text(), rawBody);
  assert.equal(JSON.stringify(input).includes("aiEnvironment"), false);
});

test("HTTP client maps stale PublicProfile revisions without retrying them as generic conflicts", async () => {
  const client = createClient(async () => contractResponse({
    error: { code: "PROFILE_REVISION_CONFLICT", message: "Stale Profile revision.", retryable: false },
    requestId: SERVER_REQUEST_ID
  }, 412));
  const authentication = {
    clientInstanceId: "ci_AAAAAAAAAAAAAAAAAAAAAA",
    signingKey: generateTetiNetworkSigningKey()
  };
  await assert.rejects(
    () => client.replaceProfileSelf({
      schemaVersion: 1,
      expectedRevision: 0,
      profile: { displayName: null, avatarUrl: null, summary: null, capabilitySummary: null },
      isDiscoverable: false
    }, authentication, {
      ifMatch: '"profile-r0"',
      idempotencyKey: "profile.replace:00000000-0000-4000-8000-000000000001"
    }),
    (error) => error instanceof TetiNetworkClientError
      && error.code === "PROFILE_REVISION_CONFLICT"
      && error.operation === "profile_replace"
      && !error.retryable
  );
});

test("HTTP client signs private Relationship reads and preserves exact command bytes", async () => {
  const requests: Request[] = [];
  const client = createClient(async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const revision = request.method === "POST" ? 2 : 1;
    return contractResponse(relationshipDocument(revision, revision === 2 ? "confirmed" : "requested"),
      request.url.endsWith("/request") ? 201 : 200,
      { etag: `"relationship-r${revision}"`, "cache-control": "no-store" });
  });
  const authentication = {
    clientInstanceId: "ci_AAAAAAAAAAAAAAAAAAAAAA",
    signingKey: generateTetiNetworkSigningKey()
  };
  const read = await client.getRelationshipWithPeer("teti_bbbbbbbbb", authentication);
  const input = { schemaVersion: 1 as const, peerTetiId: "teti_bbbbbbbbb", expectedRevision: 1 };
  const rawBody = JSON.stringify(input);
  const written = await client.requestRelationship(input, authentication, {
    ifMatch: '"relationship-r1"',
    idempotencyKey: "relationship.request:00000000-0000-4000-8000-000000000000",
    rawBody
  });

  assert.equal(read.document.direction, "outgoing");
  assert.equal(written.document.state, "confirmed");
  assert.equal(requests[0]?.headers.get("Teti-Client-Instance-ID"), authentication.clientInstanceId);
  assert.equal(requests[0]?.headers.get("Teti-Idempotency-Key"), null);
  assert.equal(requests[1]?.headers.get("If-Match"), '"relationship-r1"');
  assert.equal(requests[1]?.headers.get("Teti-Idempotency-Key"), "relationship.request:00000000-0000-4000-8000-000000000000");
  assert.equal(await requests[1]?.text(), rawBody);
});

test("HTTP client maps stale Relationship commands and rejects ETag drift", async () => {
  const authentication = {
    clientInstanceId: "ci_AAAAAAAAAAAAAAAAAAAAAA",
    signingKey: generateTetiNetworkSigningKey()
  };
  const stale = createClient(async () => contractResponse({
    error: {
      code: "RELATIONSHIP_REVISION_CONFLICT",
      message: "The Relationship revision does not match.",
      retryable: false
    },
    requestId: SERVER_REQUEST_ID
  }, 412));
  await assert.rejects(
    () => stale.mutateRelationship("rel_AAAAAAAAAAAAAAAAAAAAAA", "reject", {
      schemaVersion: 1,
      expectedRevision: 1
    }, authentication, {
      ifMatch: '"relationship-r1"',
      idempotencyKey: "relationship.reject:00000000-0000-4000-8000-000000000000"
    }),
    (error) => error instanceof TetiNetworkClientError
      && error.code === "RELATIONSHIP_REVISION_CONFLICT"
      && error.operation === "relationship_reject"
      && !error.retryable
  );

  const drift = createClient(async () => contractResponse(
    relationshipDocument(2, "confirmed"),
    200,
    { etag: '"relationship-r1"', "cache-control": "no-store" }
  ));
  await assertInvalidResponse(() => drift.getRelationship(
    "rel_AAAAAAAAAAAAAAAAAAAAAA",
    authentication
  ));
});

test("HTTP client maps protocol errors without leaking HTTP status into control flow", async () => {
  const client = createClient(async () => contractResponse({
    error: {
      code: "PROTOCOL_UNSUPPORTED",
      message: "The requested Teti Network protocol version is not supported.",
      retryable: false
    },
    requestId: SERVER_REQUEST_ID
  }, 426));

  await assert.rejects(
    () => client.getBootstrap(),
    (error) => error instanceof TetiNetworkClientError
      && error.code === "PROTOCOL_UNSUPPORTED"
      && error.requestId === SERVER_REQUEST_ID
      && error.retryable === false
      && error.status === 426
  );
});

test("HTTP client rejects malformed payloads, missing headers, and header/body drift", async () => {
  await assertInvalidResponse(() => createClient(async () => new Response("not-json", {
    status: 200,
    headers: contractHeaders()
  })).getBootstrap());
  await assertInvalidResponse(() => createClient(async () => Response.json(bootstrapBody())).getBootstrap());
  await assertInvalidResponse(() => createClient(async () => contractResponse({
    ...bootstrapBody(),
    contractRevision: 4
  })).getBootstrap());
  await assertInvalidResponse(() => createClient(async () => contractResponse({
    ...publicNode(),
    id: "TETI_NOT_CANONICAL",
    identityPublicKey: 42,
    delivery: { transport: "smtp", address: null, publicKey: [] }
  })).getPublicNode("teti_c77np4w6r"));
});

test("HTTP client applies bounded timeout and validates local request input", async () => {
  const timeoutClient = createClient(async (_input, init) => {
    await new Promise<void>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    return contractResponse(bootstrapBody());
  }, 5);
  await assert.rejects(
    () => timeoutClient.getPublicStats(),
    (error) => error instanceof TetiNetworkClientError
      && error.code === "NETWORK_TIMEOUT"
      && error.operation === "public_stats"
  );

  const client = createClient(async () => contractResponse(publicNode()));
  await assert.rejects(
    () => client.getPublicNode("TETI_BAD"),
    (error) => error instanceof TetiNetworkClientError
      && error.code === "NETWORK_REQUEST_INVALID"
      && !error.retryable
  );
  await assert.rejects(
    () => client.listPublicNodes({ limit: 51 }),
    (error) => error instanceof TetiNetworkClientError
      && error.code === "NETWORK_REQUEST_INVALID"
  );
});

test("HTTP client validates client metadata before sending", () => {
  assert.throws(
    () => new HttpTetiNetworkClient({ clientVersion: "bad version", clientPlatform: "macos" }),
    /client version is invalid/
  );
  assert.throws(
    () => new HttpTetiNetworkClient({ clientVersion: "0.3.3", clientPlatform: "mac os" }),
    /client platform is invalid/
  );
});

function createClient(fetchImpl: typeof fetch, timeoutMs = 5_000): HttpTetiNetworkClient {
  return new HttpTetiNetworkClient({
    baseUrl: "http://127.0.0.1:8788",
    clientVersion: "0.3.5",
    clientPlatform: "macos",
    fetchImpl,
    timeoutMs,
    requestIdFactory: () => CLIENT_REQUEST_ID
  });
}

function bootstrapBody() {
  return {
    protocolVersion: 1,
    contractRevision: 6,
    service: { name: "teti-network" as const, version: "0.1.5" },
    serverTime: "2026-08-08T12:00:00.000Z",
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
      relayBindings: false,
      invites: false
    },
    presencePolicy: {
      collaborating: { reportEverySeconds: 5, ttlSeconds: 20 },
      viewing_connect: { reportEverySeconds: 5, ttlSeconds: 20 },
      online: { reportEverySeconds: 15, ttlSeconds: 45 },
      background: { reportEverySeconds: 30, ttlSeconds: 90 }
    }
  };
}

function publicNode() {
  return {
    id: "teti_c77np4w6r",
    identityPublicKey: "ed25519:A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg",
    delivery: {
      transport: "chatmail" as const,
      address: "c77np4w6r@mail2.seep.im",
      publicKey: "chatmail-key-c77np4w6r"
    },
    profile: {
      revision: 2,
      displayName: "Casey",
      avatarUrl: null,
      summary: "Available through a draining relay.",
      capabilitySummary: {
        schemaVersion: 1,
        platform: "linux",
        category: ["research"],
        capabilityIds: ["code-analysis"],
        aiEnvironment: []
      },
      updatedAt: "2026-08-08T02:00:00.000Z"
    },
    isDiscoverable: true,
    createdAt: "2026-08-08T00:03:00.000Z",
    updatedAt: "2026-08-08T02:00:00.000Z"
  };
}

function directoryPage() {
  return {
    items: [{
      id: "teti_a83kd9x2q",
      delivery: { address: "a83kd9x2q@mail.seep.im" },
      profile: {
        revision: 1,
        displayName: "Alex",
        avatarUrl: null,
        summary: "Builds thoughtful tools.",
        capabilitySummary: {
          schemaVersion: 1,
          platform: "macos",
          category: ["developer"],
          capabilityIds: ["code-analysis"],
          aiEnvironment: []
        },
        updatedAt: "2026-08-08T03:00:00.000Z"
      },
      isDiscoverable: true,
      updatedAt: "2026-08-08T03:00:00.000Z"
    }],
    page: { limit: 2, returnedCount: 1, nextCursor: null },
    sort: "updated_desc"
  };
}

function relationshipDocument(revision: number, state: "requested" | "confirmed") {
  return {
    schemaVersion: 1,
    id: "rel_AAAAAAAAAAAAAAAAAAAAAA",
    revision,
    state,
    peerTetiId: "teti_bbbbbbbbb",
    requesterTetiId: "teti_aaaaaaaaa",
    addresseeTetiId: "teti_bbbbbbbbb",
    direction: "outgoing",
    blockedBy: null,
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: revision === 1 ? "2026-08-09T00:00:00.000Z" : "2026-08-09T00:01:00.000Z",
    stateChangedAt: revision === 1 ? "2026-08-09T00:00:00.000Z" : "2026-08-09T00:01:00.000Z"
  };
}

function contractResponse(
  body: unknown,
  status = 200,
  additionalHeaders: Record<string, string> = {}
): Response {
  return Response.json(body, {
    status,
    headers: { ...contractHeaders(), ...additionalHeaders }
  });
}

function contractHeaders(): Record<string, string> {
  return {
    "Teti-Protocol-Version": "1",
    "Teti-Contract-Revision": "6",
    "X-Request-ID": SERVER_REQUEST_ID
  };
}

async function assertInvalidResponse(operation: () => Promise<unknown>): Promise<void> {
  await assert.rejects(
    operation,
    (error) => error instanceof TetiNetworkClientError
      && error.code === "NETWORK_INVALID_RESPONSE"
  );
}
