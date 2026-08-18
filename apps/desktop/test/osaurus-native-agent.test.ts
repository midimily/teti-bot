import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { projectCallablePassport } from "../../../core/passport/callable-projection.ts";
import type {
  ExecutionTransportHandle,
  OsaurusAgentExecutionSpec
} from "../../../core/callability/agent-core.ts";
import {
  OsaurusAgentTransport,
  type LoopbackRuntimeIdentityVerifier
} from "../lifecycle-sidecar/runtime/callable/transports/loopback-http.ts";
import {
  FileOsaurusNativeAgentPolicyAuditor,
  OSAURUS_NATIVE_CHILD,
  qualifyOsaurusNativeConnector,
  readOsaurusNativeChildConfiguration
} from "../../../integrations/agents/osaurus/native-agent.ts";
import type { OsaurusRuntimeIdentity } from "../../../integrations/agents/osaurus/runtime-identity.ts";
import type { OsaurusRuntimeTrustVerifier } from "../../../integrations/agents/osaurus/connector.ts";
import {
  TetiHostAgentKernel,
  createBoundedWorkspaceContext,
  formatBoundedWorkspaceInput
} from "../lifecycle-sidecar/runtime/callable/kernel.ts";

const AGENT_ID = "123E4567-E89B-42D3-A456-426614174000";
const MODEL = "OsaurusAI/Bonsai-27b-Ternary-JANG";
const UPDATED_AT = "2026-07-29T08:00:00.000Z";
const IDENTITY: OsaurusRuntimeIdentity = {
  instanceId: "11111111-1111-4111-8111-111111111111",
  endpoint: "http://127.0.0.1:1337",
  listenerPid: 4242,
  appPath: "/Applications/Osaurus.app",
  executablePath: "/Applications/Osaurus.app/Contents/MacOS/osaurus",
  bundleIdentifier: "com.dinoki.osaurus",
  teamIdentifier: "4W8QF9VR2F",
  codeDirectoryHash: "a".repeat(40),
  codeIdentityHash: `sha256:${"b".repeat(64)}`,
  appVersion: "0.22.2",
  observedAt: UPDATED_AT
};

test("native policy audit records provider defaults and invalidates a changed digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-osaurus-native-"));
  const agentsRoot = join(root, "agents");
  await mkdir(agentsRoot);
  const path = join(agentsRoot, `${AGENT_ID}.json`);
  try {
    await writeFile(path, JSON.stringify(agentRecord()), { mode: 0o600 });
    const auditor = new FileOsaurusNativeAgentPolicyAuditor(agentsRoot);
    const audit = await auditor.inspect(AGENT_ID.toLowerCase());
    assert.equal(audit.agentId, AGENT_ID);
    assert.equal(audit.effectiveModel, MODEL);
    assert.deepEqual(audit.providerAuthority, {
      tools: "disabled",
      memory: "disabled",
      hostWorkspace: "disabled",
      autonomousExec: "disabled"
    });

    await writeFile(path, JSON.stringify(agentRecord({
      toolsEnabled: true,
      memoryEnabled: true,
      autonomousExec: { enabled: true }
    })), { mode: 0o600 });
    const defaultsEnabled = await auditor.inspect(AGENT_ID);
    assert.deepEqual(defaultsEnabled.providerAuthority, {
      tools: "enabled",
      memory: "enabled",
      hostWorkspace: "disabled",
      autonomousExec: "enabled"
    });

    for (const unsafe of [
      { toolsEnabled: "yes" },
      { memoryEnabled: null },
      { autonomousExec: { enabled: "yes" } },
      { hostWorkspaceBookmark: "c2VjcmV0" },
      { hostWorkspacePath: "/private/project" }
    ]) {
      await writeFile(path, JSON.stringify(agentRecord(unsafe)), { mode: 0o600 });
      await assert.rejects(() => auditor.inspect(AGENT_ID), /authority is not safely constrained/);
    }
    await assert.rejects(() => auditor.verifyAgentAuthority({
      agentId: AGENT_ID,
      agentConfigurationDigest: audit.configurationDigest
    }), /identity verification failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("official Insights request retention is an explicit accepted Native Child risk", async () => {
  const audit = {
    agentId: AGENT_ID,
    name: "Teti Agent",
    effectiveModel: MODEL,
    updatedAt: UPDATED_AT,
    configurationDigest: `sha256:${"d".repeat(64)}`,
    providerAuthority: {
      tools: "disabled" as const,
      memory: "disabled" as const,
      hostWorkspace: "disabled" as const,
      autonomousExec: "disabled" as const
    }
  };
  const qualification = await qualifyOsaurusNativeConnector({
    agentId: AGENT_ID,
    trustVerifier: trustVerifier(),
    policyAuditor: {
      async inspect() { return structuredClone(audit); },
      async verifyAgentAuthority() {}
    },
    probeAgent: async () => apiAgent()
  });
  assert.ok(qualification.connector);
  assert.equal(qualification.readiness.state, "ready");
  assert.equal(qualification.readiness.reasonCode, "OSAURUS_INSIGHTS_BODY_RETENTION_ACCEPTED");
  assert.deepEqual(qualification.releaseBlockers, []);
  assert.deepEqual(qualification.acceptedRisks, ["OSAURUS_INSIGHTS_BODY_RETENTION_ACCEPTED"]);
});

test("an unverifiable Insights policy still blocks Native Child publication", async () => {
  const audit = {
    agentId: AGENT_ID,
    name: "Teti Agent",
    effectiveModel: MODEL,
    updatedAt: UPDATED_AT,
    configurationDigest: `sha256:${"d".repeat(64)}`,
    providerAuthority: {
      tools: "disabled" as const,
      memory: "disabled" as const,
      hostWorkspace: "disabled" as const,
      autonomousExec: "disabled" as const
    }
  };
  const qualification = await qualifyOsaurusNativeConnector({
    agentId: AGENT_ID,
    trustVerifier: trustVerifier(),
    policyAuditor: {
      async inspect() { return structuredClone(audit); },
      async verifyAgentAuthority() {}
    },
    probeAgent: async () => apiAgent(),
    inspectInsightsRetention: async () => "unknown"
  });
  assert.equal(qualification.connector, null);
  assert.equal(qualification.readiness.reasonCode, "OSAURUS_INSIGHTS_POLICY_UNVERIFIED");
  assert.deepEqual(qualification.acceptedRisks, []);
});

test("fixed local Agent configuration rejects unsupported fields and accepts an env override", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-osaurus-config-"));
  const path = join(root, "osaurus-native-child.json");
  try {
    await writeFile(path, JSON.stringify({ schemaVersion: 1, agentId: AGENT_ID }), { mode: 0o600 });
    assert.deepEqual(await readOsaurusNativeChildConfiguration(path), {
      schemaVersion: 1,
      agentId: AGENT_ID
    });
    assert.deepEqual(await readOsaurusNativeChildConfiguration(path, AGENT_ID.toLowerCase()), {
      schemaVersion: 1,
      agentId: AGENT_ID
    });
    await writeFile(path, JSON.stringify({ schemaVersion: 1, agentId: AGENT_ID, endpoint: "steal" }));
    await assert.rejects(() => readOsaurusNativeChildConfiguration(path), /config is invalid/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Host converts a Snapshot to bounded text context without exposing its local path", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-native-context-"));
  try {
    await writeFile(join(root, "README.md"), "workspace reference", "utf8");
    await writeFile(join(root, "ignored.bin"), Buffer.from([0, 1, 2, 3]));
    const context = await createBoundedWorkspaceContext(root);
    assert.match(context, /"relativePath":"README\.md"/);
    assert.match(context, /workspace reference/);
    assert.doesNotMatch(context, /ignored\.bin/);
    assert.doesNotMatch(context, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const input = formatBoundedWorkspaceInput(context, "current task");
    assert.match(input, /TETI_WORKSPACE_CONTEXT_V1/);
    assert.match(input, /\[CURRENT_TASK\]\ncurrent task/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Native Child is distinct from Runtime facade and re-audits before every execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-osaurus-qualified-"));
  const agentsRoot = join(root, "agents");
  await mkdir(agentsRoot);
  const path = join(agentsRoot, `${AGENT_ID}.json`);
  await writeFile(path, JSON.stringify(agentRecord()), { mode: 0o600 });
  const auditor = new FileOsaurusNativeAgentPolicyAuditor(agentsRoot);
  const options = {
    agentId: AGENT_ID,
    trustVerifier: trustVerifier(),
    policyAuditor: auditor,
    probeAgent: async () => apiAgent(),
    inspectInsightsRetention: async () => "disabled" as const
  };
  try {
    const qualification = await qualifyOsaurusNativeConnector(options);
    assert.ok(qualification.connector);
    assert.equal(qualification.connector.descriptor.origin, "native_agent");
    assert.equal(qualification.connector.descriptor.workspacePolicy, "bounded_context");
    assert.equal(qualification.connector.descriptor.transportKind, "osaurus_agent");
    assert.equal(qualification.connector.descriptor.executionCapabilities.supportsResume, false);
    assert.deepEqual(qualification.connector.computeOffer, {
      offerId: "local.agent.osaurus-native-text.v1",
      capability: "general-text-assistance",
      resourceClass: "native_agent",
      executionLocation: "receiver_local",
      inputModes: ["text"],
      outputModes: ["text"],
      concurrency: 1,
      approval: "allow_once"
    });

    const spec = await qualification.connector.createExecutionSpec({
      taskId: "native-agent-task",
      capabilityId: "general-text-assistance",
      workspacePath: null,
      workspaceContext: "{\"relativePath\":\"README.md\",\"content\":\"bounded\"}",
      images: [],
      executionEpoch: 1,
      checkpointRef: null
    });
    assert.equal(spec.kind, "osaurus_agent");
    assert.equal(spec.agentId, AGENT_ID);
    assert.deepEqual(spec.providerAuthority, {
      tools: "disabled",
      memory: "disabled",
      hostWorkspace: "disabled",
      autonomousExec: "disabled"
    });

    const host = new TetiHostAgentKernel({
      connectors: [qualification.connector],
      transports: [{
        kind: "osaurus_agent",
        start() { throw new Error("not started"); }
      }]
    });
    const passport = projectCallablePassport(host.getCallableAgents(), host.getComputeOffers());
    assert.equal(passport.agents[0]?.id, "osaurus-native-teti");
    assert.equal(passport.agents[0]?.name, "Osaurus Native Agent (Teti)");
    assert.equal(passport.computeOffers[0]?.resourceClass, "native_agent");
    assert.doesNotMatch(JSON.stringify(passport), /B5382D87|127\.0\.0\.1|Bonsai-27b|configurationDigest/);
    assert.equal(host.unregisterConnector(OSAURUS_NATIVE_CHILD.connectorId), true);
    assert.deepEqual(host.getCallableAgents(), []);
    assert.deepEqual(host.getComputeOffers(), []);
    await host.shutdown();

    await writeFile(path, JSON.stringify(agentRecord({ memoryEnabled: true })), { mode: 0o600 });
    await assert.rejects(() => qualification.connector!.createExecutionSpec({
      taskId: "native-agent-stale",
      capabilityId: "general-text-assistance",
      workspacePath: null,
      workspaceContext: null,
      images: [],
      executionEpoch: 1,
      checkpointRef: null
    }), /readiness changed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Osaurus Agent transport posts only to the fixed /agents/{id}/run route", async () => {
  let receivedUrl = "";
  let receivedBody: unknown;
  const server = createServer(async (request, response) => {
    receivedUrl = request.url ?? "";
    receivedBody = JSON.parse(await readRequest(request));
    writeSuccessfulSse(response, "native answer");
  });
  const port = await listen(server);
  try {
    let authorityChecks = 0;
    const transport = new OsaurusAgentTransport({
      identityVerifier: trustedIdentityVerifier(),
      authorityVerifier: {
        async verifyAgentAuthority(input) {
          authorityChecks += 1;
          assert.equal(input.agentId, AGENT_ID);
        }
      }
    });
    const handle = transport.start({ spec: nativeSpec(port), workspacePath: null });
    const output = captureStdout(handle);
    await handle.writeInput("bounded task context");
    assert.deepEqual(await handle.completion, { code: 0, signal: null });
    assert.equal(await output, "native answer");
    assert.equal(authorityChecks, 1);
    assert.equal(receivedUrl, `/agents/${AGENT_ID}/run`);
    assert.deepEqual(receivedBody, {
      messages: [{ role: "user", content: "bounded task context" }],
      stream: true
    });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("sidecar watches policy changes and Settings exposes one fixed Agent ID control", async () => {
  const [main, view, protocol, chineseCatalog] = await Promise.all([
    readFile(new URL("../lifecycle-sidecar/main.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/passport/view.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lifecycle-bridge/protocol.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/i18n/locales/zh-hans.ts", import.meta.url), "utf8")
  ]);
  assert.match(main, /waitForNativeAgentChange/);
  assert.match(main, /hostAgent\.unregisterConnector\(OSAURUS_NATIVE_CHILD\.connectorId\)/);
  assert.match(main, /nextDigest !== registeredDigest/);
  assert.match(view, /messages\.uuidLabel/);
  assert.match(view, /messages\.policy/);
  assert.match(chineseCatalog, /固定 Osaurus Agent UUID/);
  assert.match(chineseCatalog, /Teti 不修改 Tools、Osaurus Memory 与 Autonomous Exec/);
  assert.match(protocol, /"osaurus\.native\.get"/);
  assert.match(protocol, /"osaurus\.native\.set"/);
});

function agentRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT_ID,
    name: "Teti Agent",
    isBuiltIn: false,
    toolsEnabled: false,
    memoryEnabled: false,
    autonomousExec: { enabled: false },
    hostWorkspaceBookmark: null,
    hostWorkspacePath: null,
    defaultModel: MODEL,
    updatedAt: UPDATED_AT,
    ...overrides
  };
}

function apiAgent() {
  return {
    id: AGENT_ID,
    name: "Teti Agent",
    is_built_in: false,
    effective_model: MODEL,
    updated_at: UPDATED_AT
  };
}

function trustVerifier(): OsaurusRuntimeTrustVerifier {
  return {
    async discoverLatestTrustedRuntime() { return structuredClone(IDENTITY); },
    async discoverRuntime() { return { state: "trusted", identity: structuredClone(IDENTITY) }; },
    async verifyListener() {},
    async verifyConnectedSocket() {}
  };
}

function trustedIdentityVerifier(): LoopbackRuntimeIdentityVerifier {
  return { async verifyListener() {}, async verifyConnectedSocket() {} };
}

function nativeSpec(port: number): OsaurusAgentExecutionSpec {
  return {
    kind: "osaurus_agent",
    endpoint: `http://127.0.0.1:${port}`,
    requestId: "native-transport-test",
    runtimeInstanceId: IDENTITY.instanceId,
    agentId: AGENT_ID,
    effectiveModel: MODEL,
    listenerPid: 4242,
    codeIdentityHash: IDENTITY.codeIdentityHash,
    agentConfigurationDigest: `sha256:${"c".repeat(64)}`,
    providerAuthority: {
      tools: "disabled",
      memory: "disabled",
      hostWorkspace: "disabled",
      autonomousExec: "disabled"
    }
  };
}

function writeSuccessfulSse(response: ServerResponse, content: string): void {
  response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
  response.end([
    `data: ${JSON.stringify({
      id: "chatcmpl-native",
      object: "chat.completion.chunk",
      model: MODEL,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]
    })}`,
    "",
    `data: ${JSON.stringify({
      id: "chatcmpl-native",
      object: "chat.completion.chunk",
      model: MODEL,
      choices: [{ index: 0, delta: { content }, finish_reason: null }]
    })}`,
    "",
    `data: ${JSON.stringify({
      id: "chatcmpl-native",
      object: "chat.completion.chunk",
      model: MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
    })}`,
    "",
    "data: [DONE]",
    "",
    ""
  ].join("\n"));
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server address unavailable");
  return address.port;
}

async function readRequest(request: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function captureStdout(handle: ExecutionTransportHandle): Promise<string> {
  const chunks: Buffer[] = [];
  handle.stdout.on("data", (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  return new Promise((resolve) => {
    handle.stdout.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}
