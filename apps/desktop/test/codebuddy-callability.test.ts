import assert from "node:assert/strict";
import { chmod, copyFile, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { CallableAdapterTaskRequest } from "../../../core/callability/adapter.ts";
import { issueExecutionAuthority } from "../../../core/callability/agent-core.ts";
import {
  CODEBUDDY_CONTROLLED_HEADLESS_ARGS,
  CodeBuddyConnector,
  probeCodeBuddyLogin,
  qualifyCodeBuddyConnector,
  resolveCodeBuddyCodeEntrypoint
} from "../../../integrations/agents/codebuddy/qualification.ts";
import { TetiHostAgentKernel } from "../lifecycle-sidecar/runtime/callable/kernel.ts";

const sourceFixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-codebuddy-cli.mjs"
);

test("CodeBuddy CN Desktop stays detected but non-callable without CodeBuddy Code CLI", async () => {
  const qualification = await qualifyCodeBuddyConnector({
    detectDesktop: async () => true,
    resolveCliEntrypoint: async () => null,
    now: fixedNow
  });

  assert.equal(qualification.readiness.state, "detected");
  assert.equal(
    qualification.readiness.reasonCode,
    "CODEBUDDY_CODE_CLI_NOT_INSTALLED"
  );
  assert.equal(qualification.connector, null);
});

test("CodeBuddy CLI without login fails closed as needs_login", async () => {
  const qualification = await qualifyCodeBuddyConnector({
    detectDesktop: async () => true,
    resolveCliEntrypoint: async () => "/opt/homebrew/bin/codebuddy",
    probeLogin: async () => "needs_login",
    now: fixedNow
  });

  assert.equal(qualification.readiness.state, "needs_login");
  assert.equal(qualification.readiness.reasonCode, "CODEBUDDY_LOGIN_REQUIRED");
  assert.deepEqual(qualification.evidence, {
    desktopDetected: true,
    officialCliDetected: true
  });
  assert.equal(qualification.connector, null);
});

test("CodeBuddy qualification registers only after its controlled login probe passes", async () => {
  const qualification = await qualifyCodeBuddyConnector({
    detectDesktop: async () => false,
    resolveCliEntrypoint: async () => "/opt/homebrew/bin/codebuddy",
    probeLogin: async () => "ready",
    now: fixedNow
  });

  assert.equal(qualification.readiness.state, "ready");
  assert.equal(qualification.readiness.reasonCode, undefined);
  assert.ok(qualification.connector);
  assert.equal(qualification.connector.fixedProcessEntrypoint, "/opt/homebrew/bin/codebuddy");
});

test("CodeBuddy Connector fixes stdin-only, no-tools, no-Hook, no-MCP, ephemeral execution", () => {
  const connector = new CodeBuddyConnector("/opt/homebrew/bin/codebuddy");
  const launch = connector.createExecutionSpec({
    taskId: "task-private",
    capabilityId: "code-analysis",
    workspacePath: "/private/tmp/private-workspace",
    images: [],
    executionEpoch: 1,
    checkpointRef: null
  });

  assert.deepEqual(launch.args, [...CODEBUDDY_CONTROLLED_HEADLESS_ARGS]);
  assert.equal(launch.args.includes("--dangerously-skip-permissions"), false);
  assert.equal(launch.args.includes("bypassPermissions"), false);
  assert.equal(launch.args.includes("--tools"), true);
  assert.equal(launch.args[launch.args.indexOf("--tools") + 1], "");
  assert.equal(launch.args.includes("--strict-mcp-config"), true);
  assert.equal(launch.args.includes("--no-session-persistence"), true);
  assert.equal(launch.args.some((value) => value.includes("task-private")), false);
  assert.equal(launch.args.some((value) => value.includes("private-workspace")), false);
  const settings = JSON.parse(launch.args[launch.args.indexOf("--settings") + 1]);
  assert.equal(settings.disableAllHooks, true);
  assert.equal(settings.allowUntrustedFrontmatterHooks, false);
});

test("CodeBuddy qualification reports not_detected only when neither surface exists", async () => {
  const qualification = await qualifyCodeBuddyConnector({
    detectDesktop: async () => false,
    resolveCliEntrypoint: async () => null,
    now: fixedNow
  });

  assert.equal(qualification.readiness.state, "not_detected");
  assert.equal(qualification.readiness.reasonCode, "CODEBUDDY_NOT_DETECTED");
  assert.equal(qualification.connector, null);
});

test("CodeBuddy entrypoint resolver accepts official CLI names and rejects buddycn editor launcher", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-codebuddy-entrypoint-"));
  try {
    const codebuddy = join(root, "codebuddy");
    const buddycn = join(root, "buddycn");
    await Promise.all([writeExecutable(codebuddy), writeExecutable(buddycn)]);

    assert.equal(
      await resolveCodeBuddyCodeEntrypoint({ pathOverride: codebuddy }),
      await realpath(codebuddy)
    );
    assert.equal(await resolveCodeBuddyCodeEntrypoint({ pathOverride: buddycn }), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fake CodeBuddy proves login probe, stdin task, JSONL decode, and Kernel execution", async () => {
  const fixture = await createExecutableFakeCodeBuddy();
  try {
    assert.equal(await probeCodeBuddyLogin(fixture.path, {
      environment: { PATH: process.env.PATH },
      homeDirectory: fixture.root
    }), "ready");
    const qualification = await qualifyCodeBuddyConnector({
      pathOverride: fixture.path,
      detectDesktop: async () => false,
      environment: { PATH: process.env.PATH },
      homeDirectory: fixture.root
    });
    assert.equal(qualification.readiness.state, "ready");
    assert.ok(qualification.connector);

    const hostAgent = new TetiHostAgentKernel({ connectors: [qualification.connector!] });
    const request = task();
    const result = await hostAgent.execute(request, issueExecutionAuthority(request));
    assert.equal(result.state, "completed");
    assert.equal(result.artifact?.text, "codebuddy:Review this explicit snippet.");
    await hostAgent.shutdown();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function createExecutableFakeCodeBuddy(): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), "teti-fake-codebuddy-"));
  const path = join(root, "codebuddy");
  await copyFile(sourceFixture, path);
  await chmod(path, 0o755);
  return { root, path };
}

async function writeExecutable(path: string): Promise<void> {
  await writeFile(path, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(path, 0o755);
}

function task(): CallableAdapterTaskRequest {
  return {
    schemaVersion: 1,
    taskId: "codebuddy-task-001",
    adapterId: "tencent.codebuddy.code",
    agentId: "codebuddy",
    capabilityId: "code-analysis",
    input: { kind: "text", text: "Review this explicit snippet." },
    createdAt: new Date().toISOString()
  };
}

function fixedNow(): Date {
  return new Date("2026-07-26T00:00:00.000Z");
}
