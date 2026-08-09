import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";
import type { TetiAccount } from "../../../core/account/model.ts";
import { MemoryTetiAccountStorage } from "../../../core/account/storage.ts";
import { HttpTetiNetworkClient } from "../client.ts";
import { MemoryTetiNetworkCredentialStore } from "../credential-store.ts";
import { TetiNetworkClientError } from "../errors.ts";
import { TetiNetworkIdentityService } from "../identity-service.ts";
import { MemoryTetiNetworkRelationshipCommandStore } from "../relationship-command-store.ts";
import { TetiNetworkRelationshipService } from "../relationship-service.ts";

const execFileAsync = promisify(execFile);
const NETWORK_ROOT = "/Users/macstudio/Documents/MidiMily/teti-network";

test("Beta 0.3.5 App converges and persists the full Relationship contract on an isolated local Network", async () => {
  const directory = await mkdtemp(join(tmpdir(), "teti-app-beta035-"));
  const databasePath = join(directory, "network.db");
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const redisPrefix = `teti-app-beta035:${randomUUID()}`;
  let network: ChildProcess | undefined;
  try {
    network = startNetwork({ port, databasePath, redisPrefix });
    await waitForReady(baseUrl, network);
    await execFileAsync("/usr/bin/sqlite3", [databasePath, [
      "INSERT INTO relays (id, domain, region, status, created_at, updated_at)",
      "VALUES ('relay_beta035', 'mail.seep.im', 'local', 'active', 0, 0);"
    ].join(" ")]);

    const clientA = client(baseUrl);
    const clientB = client(baseUrl);
    const identityA = await identityHarness(clientA, account("teti_reltesta1", "reltesta1@mail.seep.im", 1));
    const identityB = await identityHarness(clientB, account("teti_reltestb1", "reltestb1@mail.seep.im", 2));
    const signerA = await identityA.getAuthenticatedSigner();
    const signerB = await identityB.getAuthenticatedSigner();
    assert.notEqual(signerA.tetiId, signerB.tetiId);

    const relationshipA = relationshipService(clientA, signerA, "a");
    const relationshipB = relationshipService(clientB, signerB, "b");
    const [fromA, fromB] = await Promise.all([
      relationshipA.request(signerB.tetiId),
      relationshipB.request(signerA.tetiId)
    ]);
    const canonicalId = fromA.document.id;
    const afterRaceA = await relationshipA.getByPeer(signerB.tetiId);
    const afterRaceB = await relationshipB.getByPeer(signerA.tetiId);
    assert.equal(afterRaceA?.document.id, canonicalId);
    assert.equal(afterRaceB?.document.id, canonicalId);
    assert.equal(afterRaceA?.document.state, "confirmed");
    assert.equal(afterRaceB?.document.state, "confirmed");
    assert.equal(fromB.document.id, canonicalId);

    const addresseeRelationship = afterRaceA?.document.addresseeTetiId === signerA.tetiId
      ? relationshipA
      : relationshipB;
    const repeatedAccept = await addresseeRelationship.accept(canonicalId);
    assert.equal(repeatedAccept.document.state, "confirmed");
    assert.equal(repeatedAccept.document.revision, afterRaceB?.document.revision);

    const staleRevision = repeatedAccept.document.revision - 1;
    await assert.rejects(
      () => clientB.mutateRelationship(canonicalId, "reject", {
        schemaVersion: 1,
        expectedRevision: staleRevision
      }, signerB.authentication, {
        ifMatch: `"relationship-r${staleRevision}"`,
        idempotencyKey: `relationship.reject:stale-${randomUUID()}`
      }),
      (error) => error instanceof TetiNetworkClientError
        && error.code === "RELATIONSHIP_REVISION_CONFLICT"
        && error.status === 412
    );

    const blocked = await relationshipA.block(canonicalId);
    assert.equal(blocked.document.state, "blocked");
    assert.equal(blocked.document.blockedBy, "self");
    assert.equal((await relationshipB.getByPeer(signerA.tetiId))?.document.blockedBy, "peer");
    await assert.rejects(
      () => relationshipB.revoke(canonicalId),
      (error) => error instanceof TetiNetworkClientError
        && error.code === "RELATIONSHIP_BLOCKED"
    );
    const revoked = await relationshipA.revoke(canonicalId);
    assert.equal(revoked.document.state, "revoked");

    await stopNetwork(network);
    network = startNetwork({ port, databasePath, redisPrefix });
    await waitForReady(baseUrl, network);
    const afterRestartA = relationshipService(client(baseUrl), signerA, "restart-a");
    const afterRestartB = relationshipService(client(baseUrl), signerB, "restart-b");
    assert.equal((await afterRestartA.getByPeer(signerB.tetiId))?.document.state, "revoked");
    assert.equal((await afterRestartB.getByPeer(signerA.tetiId))?.document.id, canonicalId);

    const requestedAgain = await afterRestartA.request(signerB.tetiId);
    assert.equal(requestedAgain.document.state, "requested");
    const rejected = await afterRestartB.reject(canonicalId);
    assert.equal(rejected.document.state, "rejected");
    assert.equal((await afterRestartB.reject(canonicalId)).document.revision, rejected.document.revision);
    const finalRequest = await afterRestartA.request(signerB.tetiId);
    const finalConfirmed = await afterRestartB.accept(canonicalId);
    assert.equal(finalConfirmed.document.state, "confirmed");
    assert.equal(finalConfirmed.document.id, finalRequest.document.id);
    assert.equal(finalConfirmed.document.id, canonicalId);
  } finally {
    if (network) await stopNetwork(network).catch(() => undefined);
    await cleanupRedis(redisPrefix).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

function startNetwork(input: { port: number; databasePath: string; redisPrefix: string }): ChildProcess {
  return spawn(process.execPath, ["--enable-source-maps", "dist/src/server.js"], {
    cwd: NETWORK_ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(input.port),
      LOG_LEVEL: "error",
      DATABASE_PATH: input.databasePath,
      MIGRATIONS_DIR: join(NETWORK_ROOT, "migrations"),
      REDIS_URL: "redis://127.0.0.1:6379",
      REDIS_KEY_PREFIX: input.redisPrefix,
      RELATIONSHIP_READ_RATE_LIMIT_MAX_REQUESTS: "200",
      RELATIONSHIP_COMMAND_RATE_LIMIT_MAX_REQUESTS: "200",
      RELATIONSHIP_REQUEST_PEER_RATE_LIMIT_MAX_REQUESTS: "20",
      IDENTITY_ADOPTION_MODE: "development_first_claim"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

async function waitForReady(baseUrl: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 10_000;
  let output = "";
  child.stdout?.on("data", (chunk) => { output += String(chunk); });
  child.stderr?.on("data", (chunk) => { output += String(chunk); });
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Temporary Network exited: ${output}`);
    try {
      const response = await fetch(`${baseUrl}/ready`);
      if (response.status === 200) return;
    } catch {
      // Startup is still in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Temporary Network did not become ready: ${output}`);
}

async function stopNetwork(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 3_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function identityHarness(client: HttpTetiNetworkClient, local: TetiAccount) {
  const accountStorage = new MemoryTetiAccountStorage();
  await accountStorage.save(local);
  const service = new TetiNetworkIdentityService({
    client,
    accountStorage,
    credentialStore: new MemoryTetiNetworkCredentialStore(),
    appVersion: "0.3.5",
    platform: "macos"
  });
  await service.synchronize();
  return service;
}

function relationshipService(
  client: HttpTetiNetworkClient,
  signer: Awaited<ReturnType<TetiNetworkIdentityService["getAuthenticatedSigner"]>>,
  prefix: string
): TetiNetworkRelationshipService {
  return new TetiNetworkRelationshipService({
    client,
    store: new MemoryTetiNetworkRelationshipCommandStore(),
    getAuthentication: async () => signer,
    idempotencyKeyFactory: (operation) => `relationship.${operation}:${prefix}-${randomUUID()}`
  });
}

function client(baseUrl: string): HttpTetiNetworkClient {
  return new HttpTetiNetworkClient({
    baseUrl,
    clientVersion: "0.3.5",
    clientPlatform: "macos"
  });
}

function account(id: string, address: string, chatmailAccountId: number): TetiAccount {
  return {
    version: 1,
    id,
    address,
    chatmailAccountId,
    publicKey: `chatmail-key-${id}`,
    publicProfile: { platform: "macOS", category: [], aiEnvironment: [] },
    networkIdentity: { schemaVersion: 1, mode: "register", state: "pending" },
    createdAt: "2026-08-09T00:00:00.000Z"
  };
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate an integration port."));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function cleanupRedis(prefix: string): Promise<void> {
  const { stdout } = await execFileAsync("/usr/local/bin/redis-cli", [
    "--scan",
    "--pattern",
    `${prefix}:*`
  ]).catch(async () => execFileAsync("/opt/homebrew/bin/redis-cli", [
    "--scan",
    "--pattern",
    `${prefix}:*`
  ]));
  const keys = stdout.split("\n").filter(Boolean);
  if (keys.length === 0) return;
  const binary = await execFileAsync("/usr/bin/which", ["redis-cli"])
    .then(({ stdout: path }) => path.trim());
  await execFileAsync(binary, ["DEL", ...keys]);
}
