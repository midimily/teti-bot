import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { CallableAdapterTaskRequest } from "../../../core/callability/adapter.ts";
import {
  HostChildAgentContractError,
  issueExecutionAuthority,
  validateAgentConnector,
  type AgentConnector,
  type AgentConnectorContext
} from "../../../core/callability/agent-core.ts";
import {
  TetiHostAgentError,
  TetiHostAgentKernel
} from "../lifecycle-sidecar/runtime/callable/kernel.ts";
import { FakeTransport } from "../lifecycle-sidecar/runtime/callable/transports/fake.ts";
import { LoopbackHttpTransport } from "../lifecycle-sidecar/runtime/callable/transports/loopback-http.ts";

const fixedDate = new Date("2026-07-28T00:00:00.000Z");

test("FakeTransport proves Host authorization and stdin delivery without a process", async () => {
  let context: AgentConnectorContext | null = null;
  const connector = fakeConnector((value) => { context = structuredClone(value); });
  const transport = new FakeTransport(new Map([
    ["echo", (input: string) => ({ stdout: `fake:${input}` })]
  ]));
  const hostAgent = new TetiHostAgentKernel({
    connectors: [connector],
    transports: [transport],
    now: () => fixedDate
  });
  const request = task("fake-transport-task");
  const authority = issueExecutionAuthority(request, { now: fixedDate });
  const result = await hostAgent.execute(request, authority);

  assert.equal(result.state, "completed");
  assert.equal(result.artifact?.text, "fake:hello host");
  assert.deepEqual(Object.keys(context!).sort(), [
    "capabilityId",
    "images",
    "taskId",
    "workspacePath"
  ]);
  assert.equal("authority" in context!, false);
  assert.equal("passport" in context!, false);
  assert.equal("peer" in context!, false);
  await hostAgent.shutdown();
});

test("ExecutionAuthority is exact-input-bound, expiring, and single-use", async () => {
  const transport = new FakeTransport(new Map([
    ["echo", (input: string) => ({ stdout: input })]
  ]));
  const hostAgent = new TetiHostAgentKernel({
    connectors: [fakeConnector()],
    transports: [transport],
    now: () => fixedDate
  });
  const first = task("authority-first");
  const authorityId = "authority-shared-id";
  await hostAgent.execute(first, issueExecutionAuthority(first, {
    authorityId,
    now: fixedDate
  }));

  const second = task("authority-second");
  await assert.rejects(
    () => hostAgent.execute(second, issueExecutionAuthority(second, {
      authorityId,
      now: fixedDate
    })),
    (error: unknown) => error instanceof TetiHostAgentError
      && error.code === "EXECUTION_AUTHORITY_CONSUMED"
  );

  const expired = task("authority-expired");
  await assert.rejects(
    () => hostAgent.execute(expired, issueExecutionAuthority(expired, {
      issuedAt: "2026-07-27T23:55:00.000Z",
      expiresAt: "2026-07-27T23:57:00.000Z"
    })),
    (error: unknown) => error instanceof HostChildAgentContractError
      && error.code === "EXECUTION_AUTHORITY_EXPIRY"
  );

  const changed = task("authority-changed");
  const changedAuthority = issueExecutionAuthority(changed, { now: fixedDate });
  changed.input.text = "changed after approval";
  await assert.rejects(
    () => hostAgent.execute(changed, changedAuthority),
    (error: unknown) => error instanceof HostChildAgentContractError
      && error.code === "EXECUTION_AUTHORITY_INPUT"
  );
  await hostAgent.shutdown();
});

test("Connector and Passport projections contain no collaboration identity or transport details", async () => {
  const connector = fakeConnector();
  assert.doesNotThrow(() => validateAgentConnector(connector));
  const hostAgent = new TetiHostAgentKernel({
    connectors: [connector],
    transports: [new FakeTransport(new Map([["echo", () => ({ stdout: "ok" })]]))]
  });
  const publicProjection = JSON.stringify(hostAgent.getCallableAgents());
  for (const forbidden of [
    "transportKind",
    "fixedProcessEntrypoint",
    "executable",
    "workspacePath",
    "passport",
    "chatmail",
    "peerTetiId"
  ]) {
    assert.equal(publicProjection.includes(forbidden), false, forbidden);
  }

  const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const connectorSources = await Promise.all([
    readFile(join(repositoryRoot, "integrations", "agents", "codex", "adapter.ts"), "utf8"),
    readFile(join(repositoryRoot, "integrations", "agents", "codex", "image-adapter.ts"), "utf8"),
    readFile(join(repositoryRoot, "integrations", "agents", "codebuddy", "qualification.ts"), "utf8")
  ]);
  const forbiddenImport = /from\s+["'][^"']*(?:passport|chatmail|connection)[^"']*["']/i;
  connectorSources.forEach((source) => assert.equal(forbiddenImport.test(source), false));
  await hostAgent.shutdown();
});

test("LoopbackHttpTransport is reserved and cannot perform network execution in 0.2.1", () => {
  const transport = new LoopbackHttpTransport();
  assert.throws(() => transport.start({
    spec: {
      kind: "loopback_http",
      endpoint: "http://127.0.0.1:1234",
      requestId: "reserved-request"
    },
    workspacePath: "/private/tmp/reserved"
  }), /reserved and disabled/);
});

function fakeConnector(capture?: (context: AgentConnectorContext) => void): AgentConnector {
  return {
    descriptor: {
      contractVersion: 1,
      connectorId: "test.fake.connector",
      connectorRevision: 1,
      childAgentId: "fake-child",
      capabilityIds: ["code-analysis"],
      inputModes: ["text"],
      outputModes: ["text"],
      transportKind: "fake",
      timeoutMs: 2_000,
      cancelGraceMs: 20,
      maxOutputBytes: 4 * 1_024
    },
    resourceBinding: {
      schemaVersion: 1,
      bindingId: "fake.binding.code-analysis",
      childAgentId: "fake-child",
      connectorId: "test.fake.connector",
      transportKind: "fake",
      capabilityIds: ["code-analysis"]
    },
    createExecutionSpec(context) {
      capture?.(context);
      return { kind: "fake", scenarioId: "echo" };
    }
  };
}

function task(taskId: string): CallableAdapterTaskRequest {
  return {
    schemaVersion: 2,
    taskId,
    adapterId: "test.fake.connector",
    agentId: "fake-child",
    capabilityId: "code-analysis",
    input: { kind: "text", text: "hello host" },
    createdAt: fixedDate.toISOString()
  };
}
