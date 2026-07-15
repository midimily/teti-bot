import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { TetiAccountManager } from "../core/account/manager.ts";
import { FileTetiAccountStorage } from "../core/account/storage.ts";
import { FileTetiConnectionStorage } from "../core/connection/storage.ts";
import { TetiConnectionManager } from "../core/connection/manager.ts";
import { TetiConnectionState } from "../core/connection/types.ts";
import { ChatmailConnectionMessagingAdapter } from "../integrations/chatmail/connection-messaging.ts";
import type {
  ConnectionMessagingAdapter,
  ConnectionReceiveDiagnostic,
  ReceiveConnectionRequestsInput,
  ReceivedConnectionEvent,
  SendConnectionAcceptInput,
  SendConnectionRejectInput,
  SendConnectionRequestInput,
  SentConnectionEvent,
  SentConnectionRequest
} from "../integrations/chatmail/connection-messaging.ts";
import { createRuntimeChatmailRpcClient } from "../integrations/chatmail/create-runtime-client.ts";
import {
  DIAGNOSTIC_PLAIN_TEXT_BODY,
  classifyDeliveryMatrixResult,
  redactDeliveryDiagnostics,
  safeMessagePreview,
  sendDiagnosticPlainTextMessage
} from "../integrations/chatmail/delivery-diagnostics.ts";
import { RealChatmailAdapter } from "../integrations/chatmail/real-adapter.ts";
import { RuntimeChatmailProvisioner } from "../integrations/chatmail/provisioner.ts";
import {
  DEFAULT_TETI_REGISTRY_URL,
  RegistryDiscoveryClient
} from "../services/discovery/registry-client.ts";
import { TetiDiscoveryService } from "../services/discovery/client.ts";
import type { EnvironmentScan } from "../core/environment/types.ts";
import type { TetiIdentity } from "../services/discovery/types.ts";
import type { RuntimeChatmailRpcClient } from "../integrations/chatmail/create-runtime-client.ts";

const DEFAULT_RPC_PATH =
  "/Users/macstudio/Documents/AICoRun/core/target/release/deltachat-rpc-server";

let activeRoot: string | undefined;
let activeDiagnostics: E2EDiagnostics | undefined;

interface NodePaths {
  root: string;
  accountPath: string;
  connectionsPath: string;
  chatmailAccountsPath: string;
}

interface TestNode {
  label: "A" | "B";
  paths: NodePaths;
  accountStorage: FileTetiAccountStorage;
  connectionStorage: FileTetiConnectionStorage;
}

interface E2EDiagnostics {
  mode: "connection" | "plain-text";
  sameHost: boolean;
  pollSeconds: number;
  nodes: Record<"A" | "B", {
    accountsPath: string;
    accountPath: string;
    connectionsPath: string;
    accountId?: number;
    address?: string;
  }>;
  startIo: Array<{ node: "A" | "B"; accountId: number; result: "ok" | "error"; error?: string }>;
  sends: Array<{ node: "A" | "B"; kind: string; toAddress: string; messageId: number; chatId?: number }>;
  messageStatuses: Array<{ node: "A" | "B"; messageId: number; chatId?: number; state?: number; showPadlock?: boolean; error?: string | null }>;
  nextMessageSnapshots: Array<{ node: "A" | "B"; label: string; messageIds: number[]; count: number }>;
  receiveDiagnostics: Array<{ node: "A" | "B"; diagnostic: ConnectionReceiveDiagnostic }>;
  plainTextDiagnostics: Array<{ node: "A" | "B"; messageId?: number; chatId?: number; preview?: string; received?: boolean }>;
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const root = await mkdtemp(join(tmpdir(), "teti-alpha1-real-message-"));
  activeRoot = root;
  const rpcServerPath = process.env.TETI_DELTACHAT_RPC_PATH ?? DEFAULT_RPC_PATH;
  const registryUrl = process.env.TETI_REGISTRY_URL ?? DEFAULT_TETI_REGISTRY_URL;
  const nodeA = options.senderAccountPath
    ? createTestNodeFromAccountPath(options.senderAccountPath, "A")
    : createTestNode(root, "A");
  const nodeB = options.receiverAccountPath
    ? createTestNodeFromAccountPath(options.receiverAccountPath, "B")
    : createTestNode(root, "B");
  const diagnostics = createDiagnostics(nodeA, nodeB, options);
  activeDiagnostics = diagnostics;

  const accountA = options.senderAccountPath
    ? await nodeA.accountStorage.load()
    : await createAccount(nodeA, "Teti Alpha A", rpcServerPath, registryUrl);
  const accountB = options.receiverAccountPath
    ? await nodeB.accountStorage.load()
    : await createAccount(nodeB, "Teti Alpha B", rpcServerPath, registryUrl);
  if (!accountA || !accountB) {
    throw new Error("Both sender and receiver Teti accounts are required.");
  }
  diagnostics.nodes.A.accountId = accountA.chatmailAccountId;
  diagnostics.nodes.A.address = accountA.address;
  diagnostics.nodes.B.accountId = accountB.chatmailAccountId;
  diagnostics.nodes.B.address = accountB.address;

  const discovery = new TetiDiscoveryService({
    registry: new RegistryDiscoveryClient(registryUrl)
  });
  const discovered = await discovery.discoverTetis({ limit: 50 });
  const discoveredB = discovered.find((identity) => identity.id === accountB.id) ?? null;
  if (!discoveredB) {
    throw new Error(`Node A did not discover Node B identity ${accountB.id}.`);
  }

  const runtimeA = createRuntime(nodeA, rpcServerPath);
  const runtimeB = createRuntime(nodeB, rpcServerPath);

  try {
    await startIoWithDiagnostics(runtimeA, diagnostics, "A", accountA.chatmailAccountId);
    await startIoWithDiagnostics(runtimeB, diagnostics, "B", accountB.chatmailAccountId);
    await delay(15000);
    await captureNextMessageIds(runtimeB, diagnostics, "B", accountB.chatmailAccountId, "before-send");

    if (options.plainText) {
      const plainTextResult = await runPlainTextDeliveryTest({
        runtimeA,
        runtimeB,
        diagnostics,
        accountA,
        accountB,
        pollSeconds: options.pollSeconds
      });
      await captureNextMessageIds(runtimeB, diagnostics, "B", accountB.chatmailAccountId, "after-plain-text");

      console.log(
        JSON.stringify(
          redactDeliveryDiagnostics({
            ok: plainTextResult.received,
            classification: classifyDeliveryMatrixResult({
              sendSucceeded: Boolean(plainTextResult.sent),
              receiveSucceeded: plainTextResult.received
            }),
            root,
            registryUrl,
            plainText: plainTextResult,
            nodeA: {
              id: accountA.id,
              address: accountA.address,
              chatmailAccountId: accountA.chatmailAccountId
            },
            nodeB: {
              id: accountB.id,
              address: accountB.address,
              chatmailAccountId: accountB.chatmailAccountId
            },
            diagnostics
          }),
          null,
          2
        )
      );
      if (!plainTextResult.received) {
        process.exitCode = 1;
      }
      return;
    }

    const messagingA = new DiagnosticConnectionMessagingAdapter(
      new ChatmailConnectionMessagingAdapter(new RealChatmailAdapter(runtimeA)),
      "A",
      diagnostics
    );
    const messagingB = new DiagnosticConnectionMessagingAdapter(
      new ChatmailConnectionMessagingAdapter(new RealChatmailAdapter(runtimeB)),
      "B",
      diagnostics
    );
    const managerA = createConnectionManager(nodeA, messagingA);
    const managerB = createConnectionManager(nodeB, messagingB);

    const requestRecord = await managerA.createRequest(discoveredB as TetiIdentity);
    await captureLastSendStatus(runtimeA, diagnostics, "A", accountA.chatmailAccountId);
    let incomingRecord;
    let acceptedRecord;
    let confirmedA;
    try {
      incomingRecord = await waitForConnectionState(
        managerB,
        requestRecord.requestId,
        TetiConnectionState.PendingApproval,
        options.pollSeconds * 1000,
        diagnostics,
        "B"
      );
      acceptedRecord = await managerB.acceptRequest(incomingRecord.requestId);
      await captureLastSendStatus(runtimeB, diagnostics, "B", accountB.chatmailAccountId);
      confirmedA = await waitForConnectionState(
        managerA,
        requestRecord.requestId,
        TetiConnectionState.Confirmed,
        options.pollSeconds * 1000,
        diagnostics,
        "A"
      );
    } catch (error) {
      await captureLastSendStatus(runtimeA, diagnostics, "A", accountA.chatmailAccountId);
      await captureLastSendStatus(runtimeB, diagnostics, "B", accountB.chatmailAccountId);
      throw error;
    }
    const confirmedB = (await managerB.listConnections()).find(
      (connection) => connection.requestId === requestRecord.requestId
    );

    const publicIdentityA = await runtimeA.getPublicIdentity(accountA.chatmailAccountId);
    const publicIdentityB = await runtimeB.getPublicIdentity(accountB.chatmailAccountId);
    await captureNextMessageIds(runtimeB, diagnostics, "B", accountB.chatmailAccountId, "after-connection");

    console.log(
      JSON.stringify(
        redactDeliveryDiagnostics({
          ok: true,
          classification: classifyDeliveryMatrixResult({
            sendSucceeded: true,
            receiveSucceeded: true
          }),
          root,
          registryUrl,
          nodeA: {
            id: accountA.id,
            address: accountA.address,
            chatmailAccountId: accountA.chatmailAccountId,
            publicIdentity: publicIdentityA
          },
          nodeB: {
            id: accountB.id,
            address: accountB.address,
            chatmailAccountId: accountB.chatmailAccountId,
            publicIdentity: publicIdentityB
          },
          discovery: {
            aDiscoveredB: true,
            discoveredCount: discovered.length,
            differentAddress: accountA.address !== accountB.address,
            differentTetiId: accountA.id !== accountB.id
          },
          connection: {
            requestId: requestRecord.requestId,
            sentState: requestRecord.state,
            incomingState: incomingRecord.state,
            acceptedState: acceptedRecord.state,
            nodeAState: confirmedA.state,
            nodeBState: confirmedB?.state,
            nodeAConfirmedAt: confirmedA.confirmedAt,
            nodeBConfirmedAt: confirmedB?.confirmedAt
          },
          diagnostics
        }),
        null,
        2
      )
    );
  } finally {
    await Promise.allSettled([runtimeA.close(), runtimeB.close()]);
  }
}

function createTestNode(root: string, label: "A" | "B"): TestNode {
  const nodeRoot = join(root, `node-${label.toLowerCase()}`);
  const paths: NodePaths = {
    root: nodeRoot,
    accountPath: join(nodeRoot, "teti", "account.json"),
    connectionsPath: join(nodeRoot, "teti", "connections.json"),
    chatmailAccountsPath: join(nodeRoot, "chatmail-accounts")
  };

  return {
    label,
    paths,
    accountStorage: new FileTetiAccountStorage(paths.accountPath),
    connectionStorage: new FileTetiConnectionStorage(paths.connectionsPath)
  };
}

function createTestNodeFromAccountPath(accountPathInput: string, label: "A" | "B"): TestNode {
  const accountPath = resolve(accountPathInput);
  const tetiDir = dirname(accountPath);
  const nodeRoot = dirname(tetiDir);
  const paths: NodePaths = {
    root: nodeRoot,
    accountPath,
    connectionsPath: join(tetiDir, "connections.json"),
    chatmailAccountsPath: join(nodeRoot, "chatmail-accounts")
  };

  return {
    label,
    paths,
    accountStorage: new FileTetiAccountStorage(paths.accountPath),
    connectionStorage: new FileTetiConnectionStorage(paths.connectionsPath)
  };
}

async function createAccount(
  node: TestNode,
  displayName: string,
  rpcServerPath: string,
  registryUrl: string
) {
  const manager = new TetiAccountManager({
    storage: node.accountStorage,
    chatmailProvisioner: new RuntimeChatmailProvisioner({
      runtime: {
        rpcServerPath,
        accountsPath: node.paths.chatmailAccountsPath
      },
      transport: {
        requestTimeoutMs: 120000
      }
    }),
    discoveryClient: new RegistryDiscoveryClient(registryUrl),
    environmentScanner: async () => mockEnvironmentScan()
  });

  return manager.createTetiAccount({
    displayName,
    publicProfile: {
      platform: "macOS",
      category: ["developer"],
      aiEnvironment: ["Codex"]
    }
  });
}

function createRuntime(node: TestNode, rpcServerPath: string): RuntimeChatmailRpcClient {
  return createRuntimeChatmailRpcClient({
    runtime: {
      rpcServerPath,
      accountsPath: node.paths.chatmailAccountsPath
    },
    transport: {
      requestTimeoutMs: 30000
    }
  });
}

function createConnectionManager(
  node: TestNode,
  messagingAdapter: ConnectionMessagingAdapter
): TetiConnectionManager {
  return new TetiConnectionManager({
    accountStorage: node.accountStorage,
    connectionStorage: node.connectionStorage,
    messagingAdapter
  });
}

async function waitForConnectionState(
  manager: TetiConnectionManager,
  requestId: string,
  expectedState: TetiConnectionState,
  timeoutMs: number,
  diagnostics: E2EDiagnostics,
  node: "A" | "B"
) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await manager.receiveEvents({
        limit: 20,
        pollCount: 2,
        pollIntervalMs: 1000,
        onDiagnostic: (diagnostic) => diagnostics.receiveDiagnostics.push({ node, diagnostic })
      });
    } catch (error) {
      lastError = error;
    }

    const connection = (await manager.listConnections()).find(
      (item) => item.requestId === requestId
    );
    if (connection?.state === expectedState) {
      return connection;
    }

    await delay(1500);
  }

  throw new Error(
    `Timed out waiting for ${requestId} to reach ${expectedState}. Last receive error: ${String(
      lastError
    )}`
  );
}

function createDiagnostics(
  nodeA: TestNode,
  nodeB: TestNode,
  options: DeliveryMatrixCliOptions
): E2EDiagnostics {
  return {
    mode: options.plainText ? "plain-text" : "connection",
    sameHost: options.sameHost,
    pollSeconds: options.pollSeconds,
    nodes: {
      A: {
        accountsPath: nodeA.paths.chatmailAccountsPath,
        accountPath: nodeA.paths.accountPath,
        connectionsPath: nodeA.paths.connectionsPath
      },
      B: {
        accountsPath: nodeB.paths.chatmailAccountsPath,
        accountPath: nodeB.paths.accountPath,
        connectionsPath: nodeB.paths.connectionsPath
      }
    },
    startIo: [],
    sends: [],
    messageStatuses: [],
    nextMessageSnapshots: [],
    receiveDiagnostics: [],
    plainTextDiagnostics: []
  };
}

async function startIoWithDiagnostics(
  runtime: RuntimeChatmailRpcClient,
  diagnostics: E2EDiagnostics,
  node: "A" | "B",
  accountId: number
): Promise<void> {
  try {
    await runtime.startIo(accountId);
    diagnostics.startIo.push({ node, accountId, result: "ok" });
  } catch (error) {
    diagnostics.startIo.push({
      node,
      accountId,
      result: "error",
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

async function captureNextMessageIds(
  runtime: RuntimeChatmailRpcClient,
  diagnostics: E2EDiagnostics,
  node: "A" | "B",
  accountId: number,
  label: string
): Promise<void> {
  try {
    const messageIds = await runtime.getNextMessageIds(accountId);
    diagnostics.nextMessageSnapshots.push({
      node,
      label,
      messageIds,
      count: messageIds.length
    });
  } catch {
    diagnostics.nextMessageSnapshots.push({
      node,
      label,
      messageIds: [],
      count: 0
    });
  }
}

async function runPlainTextDeliveryTest(input: {
  runtimeA: RuntimeChatmailRpcClient;
  runtimeB: RuntimeChatmailRpcClient;
  diagnostics: E2EDiagnostics;
  accountA: NonNullable<Awaited<ReturnType<FileTetiAccountStorage["load"]>>>;
  accountB: NonNullable<Awaited<ReturnType<FileTetiAccountStorage["load"]>>>;
  pollSeconds: number;
}): Promise<{ sent?: { messageId: number; chatId?: number }; received: boolean }> {
  const adapterA = new RealChatmailAdapter(input.runtimeA);
  const adapterB = new RealChatmailAdapter(input.runtimeB);
  const receiverPublicIdentity = await input.runtimeB.getPublicIdentity(
    input.accountB.chatmailAccountId
  );
  const sent = await sendDiagnosticPlainTextMessage(adapterA, {
    accountId: input.accountA.chatmailAccountId,
    peerAddress: input.accountB.address,
    peerPublicKey: receiverPublicIdentity.publicKey ?? input.accountB.publicKey,
    peerDisplayName: input.accountB.displayName
  });
  input.diagnostics.sends.push({
    node: "A",
    kind: "diagnostic.plain_text",
    toAddress: input.accountB.address,
    messageId: sent.messageId,
    chatId: sent.chatId
  });
  await captureLastSendStatus(
    input.runtimeA,
    input.diagnostics,
    "A",
    input.accountA.chatmailAccountId
  );

  const deadline = Date.now() + input.pollSeconds * 1000;
  while (Date.now() < deadline) {
    const messages = await adapterB.receiveMessages({
      accountId: input.accountB.chatmailAccountId,
      limit: 20,
      onDiagnostic: (diagnostic) =>
        input.diagnostics.receiveDiagnostics.push({
          node: "B",
          diagnostic: { source: "chatmail", ...diagnostic }
        })
    });

    for (const message of messages) {
      const preview = safeMessagePreview(message.text);
      input.diagnostics.plainTextDiagnostics.push({
        node: "B",
        messageId: message.messageId,
        chatId: message.chatId,
        preview,
        received: preview === DIAGNOSTIC_PLAIN_TEXT_BODY
      });
      if (message.text === DIAGNOSTIC_PLAIN_TEXT_BODY) {
        await captureLastSendStatus(
          input.runtimeA,
          input.diagnostics,
          "A",
          input.accountA.chatmailAccountId
        );
        return {
          sent,
          received: true
        };
      }
    }

    await delay(1500);
  }

  await captureLastSendStatus(
    input.runtimeA,
    input.diagnostics,
    "A",
    input.accountA.chatmailAccountId
  );
  return {
    sent,
    received: false
  };
}

async function captureLastSendStatus(
  runtime: RuntimeChatmailRpcClient,
  diagnostics: E2EDiagnostics,
  node: "A" | "B",
  accountId: number
): Promise<void> {
  const send = diagnostics.sends.findLast((item) => item.node === node);
  if (!send) {
    return;
  }

  try {
    const status = await runtime.getMessageStatus(accountId, send.messageId);
    diagnostics.messageStatuses.push({
      node,
      messageId: status.messageId,
      chatId: status.chatId,
      state: status.state,
      showPadlock: status.showPadlock,
      error: status.error
    });
  } catch (error) {
    diagnostics.messageStatuses.push({
      node,
      messageId: send.messageId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

class DiagnosticConnectionMessagingAdapter implements ConnectionMessagingAdapter {
  private readonly inner: ConnectionMessagingAdapter;
  private readonly node: "A" | "B";
  private readonly diagnostics: E2EDiagnostics;

  constructor(
    inner: ConnectionMessagingAdapter,
    node: "A" | "B",
    diagnostics: E2EDiagnostics
  ) {
    this.inner = inner;
    this.node = node;
    this.diagnostics = diagnostics;
  }

  async sendConnectionRequest(input: SendConnectionRequestInput): Promise<SentConnectionRequest> {
    const sent = await this.inner.sendConnectionRequest(input);
    this.recordSend("teti.connection.request", input.toAddress, sent);
    return sent;
  }

  async sendConnectionAccept(input: SendConnectionAcceptInput): Promise<SentConnectionEvent> {
    const sent = await this.inner.sendConnectionAccept(input);
    this.recordSend("teti.connection.accept", input.toAddress, sent);
    return sent;
  }

  async sendConnectionReject(input: SendConnectionRejectInput): Promise<SentConnectionEvent> {
    const sent = await this.inner.sendConnectionReject(input);
    this.recordSend("teti.connection.reject", input.toAddress, sent);
    return sent;
  }

  receiveConnectionEvents(input: ReceiveConnectionRequestsInput): Promise<ReceivedConnectionEvent[]> {
    return this.inner.receiveConnectionEvents(input);
  }

  receiveConnectionRequests(input: ReceiveConnectionRequestsInput) {
    return this.inner.receiveConnectionRequests(input);
  }

  private recordSend(
    kind: string,
    toAddress: string,
    sent: SentConnectionRequest | SentConnectionEvent
  ): void {
    this.diagnostics.sends.push({
      node: this.node,
      kind,
      toAddress,
      messageId: sent.messageId,
      chatId: sent.chatId
    });
  }
}

function mockEnvironmentScan(): EnvironmentScan {
  const now = new Date().toISOString();

  return {
    platform: "macOS",
    aiTools: [
      {
        name: "Codex",
        detected: true
      }
    ],
    timestamp: now
  };
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      redactDeliveryDiagnostics({
        ok: false,
        classification: classifyDeliveryMatrixResult({
          sendSucceeded: Boolean(activeDiagnostics?.sends.length),
          receiveSucceeded: false
        }),
        root: activeRoot,
        diagnostics: activeDiagnostics,
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error)
        }
      }),
      null,
      2
    )
  );
  process.exitCode = 1;
});

interface DeliveryMatrixCliOptions {
  sameHost: boolean;
  pollSeconds: number;
  plainText: boolean;
  senderAccountPath?: string;
  receiverAccountPath?: string;
}

function parseCliArgs(args: string[]): DeliveryMatrixCliOptions {
  const options: DeliveryMatrixCliOptions = {
    sameHost: false,
    pollSeconds: 180,
    plainText: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--same-host") {
      options.sameHost = true;
      continue;
    }
    if (arg === "--plain-text") {
      options.plainText = true;
      continue;
    }
    if (arg === "--poll-seconds") {
      options.pollSeconds = positiveInteger(args[++index], "--poll-seconds");
      continue;
    }
    if (arg === "--sender-account-path") {
      options.senderAccountPath = requireValue(args[++index], "--sender-account-path");
      continue;
    }
    if (arg === "--receiver-account-path") {
      options.receiverAccountPath = requireValue(args[++index], "--receiver-account-path");
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function requireValue(value: string | undefined, flag: string): string {
  if (!value) {
    throw new Error(`${flag} requires a value.`);
  }

  return value;
}

function positiveInteger(value: string | undefined, flag: string): number {
  const parsed = Number.parseInt(requireValue(value, flag), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }

  return parsed;
}
