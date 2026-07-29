import assert from "node:assert/strict";
import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { CallableAdapterTaskRequest } from "../../../core/callability/adapter.ts";
import { issueExecutionAuthority } from "../../../core/callability/agent-core.ts";
import {
  CODEX_CONTROLLED_EXEC_ARGS,
  CodexConnector,
  probeCodexLogin,
  qualifyCodexConnector,
  resolveCodexEntrypoint
} from "../../../integrations/agents/codex/adapter.ts";
import {
  CodexImageConnector,
  parseRunnerFailureCode,
  parseRunnerManifest
} from "../../../integrations/agents/codex/image-adapter.ts";
import { TetiHostAgentKernel } from "../lifecycle-sidecar/runtime/callable/kernel.ts";

const sourceFixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-codex-cli.mjs"
);

test("Codex Connector uses a fixed non-interactive, ephemeral, read-only JSONL entrypoint", () => {
  const connector = new CodexConnector({
    entrypoint: "/Applications/ChatGPT.app/Contents/Resources/codex",
    codexHome: "/safe/local/codex-home"
  });
  const launch = connector.createExecutionSpec({
    taskId: "task-001",
    capabilityId: "code-analysis",
    workspacePath: "/private/tmp/isolated",
    images: [],
    executionEpoch: 1,
    checkpointRef: null
  });

  assert.deepEqual(launch.args, [...CODEX_CONTROLLED_EXEC_ARGS, "--", "-"]);
  assert.equal(launch.args.at(-1), "-");
  assert.equal(launch.args.includes("read-only"), true);
  assert.equal(launch.args.includes("--json"), true);
  assert.equal(launch.args.includes("--ephemeral"), true);
  assert.equal(launch.args.includes("shell_tool"), true);
  assert.equal(launch.args.includes("unified_exec"), true);
  assert.equal(launch.args.some((argument) => argument.includes("task-001")), false);
  assert.equal(launch.args.some((argument) => argument.includes("isolated")), false);
  assert.deepEqual(launch.environment, {
    NO_COLOR: "1",
    TERM: "dumb",
    CODEX_HOME: "/safe/local/codex-home"
  });

  const imageLaunch = connector.createExecutionSpec({
    taskId: "task-image",
    capabilityId: "code-analysis",
    workspacePath: "/private/tmp/isolated",
    images: [{
      attachmentId: "image-1",
      mimeType: "image/png",
      path: "/private/tmp/isolated/input-image-1.png"
    }],
    executionEpoch: 1,
    checkpointRef: null
  });
  assert.deepEqual(imageLaunch.args.slice(-4), [
    "--image",
    "/private/tmp/isolated/input-image-1.png",
    "--",
    "-"
  ]);
});

test("Codex image Connector fixes the app-server runner and accepts only image manifests", () => {
  const connector = new CodexImageConnector({
    nodeEntrypoint: "/Teti.app/Contents/Resources/runtime/node",
    runnerPath: "/Teti.app/Contents/Resources/lifecycle-sidecar/codex-image-runner.mjs",
    codexEntrypoint: "/Applications/ChatGPT.app/Contents/Resources/codex",
    codexHome: "/safe/local/codex-home"
  });
  const launch = connector.createExecutionSpec({
    taskId: "task-image",
    capabilityId: "image-editing",
    workspacePath: "/private/tmp/teti-image-task",
    images: [{
      attachmentId: "image-1",
      mimeType: "image/png",
      path: "/private/tmp/teti-image-task/input-image-1.png"
    }],
    executionEpoch: 1,
    checkpointRef: null
  });

  assert.deepEqual(launch.args, [
    "/Teti.app/Contents/Resources/lifecycle-sidecar/codex-image-runner.mjs",
    "--codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "--workspace",
    "/private/tmp/teti-image-task",
    "--image",
    "/private/tmp/teti-image-task/input-image-1.png"
  ]);
  assert.deepEqual(launch.environment, {
    NO_COLOR: "1",
    TERM: "dumb",
    CODEX_HOME: "/safe/local/codex-home"
  });
  assert.deepEqual(parseRunnerManifest(JSON.stringify({
    schemaVersion: 1,
    text: "图片编辑已完成。",
    images: [{ path: "/private/tmp/teti-image-task/output-image-1.img" }]
  })), {
    schemaVersion: 1,
    text: "图片编辑已完成。",
    images: [{ path: "/private/tmp/teti-image-task/output-image-1.img" }]
  });
  assert.throws(() => parseRunnerManifest(JSON.stringify({
    schemaVersion: 1,
    text: "只有文字，不应算图片结果。",
    images: []
  })), /CODEX_IMAGE_OUTPUT_INVALID/);
  assert.throws(() => parseRunnerManifest(JSON.stringify({
    schemaVersion: 1,
    text: "路径越界。",
    images: [{ path: "relative-output.png" }]
  })), /CODEX_IMAGE_OUTPUT_INVALID/);
  assert.equal(connector.classifyFailure(JSON.stringify({
    schemaVersion: 1,
    error: { code: "CODEX_IMAGE_RESULT_NOT_READY" }
  })), "ADAPTER_IMAGE_RESULT_NOT_READY");
  assert.equal(connector.classifyFailure(JSON.stringify({
    schemaVersion: 1,
    error: { code: "CODEX_IMAGE_RESULT_INVALID" }
  })), "ADAPTER_IMAGE_RESULT_INVALID");
  assert.equal(connector.classifyFailure(JSON.stringify({
    schemaVersion: 1,
    error: { code: "CODEX_IMAGE_SERVER_EXITED" }
  })), "ADAPTER_IMAGE_SERVER_EXITED");
  assert.equal(connector.classifyFailure(JSON.stringify({
    schemaVersion: 1,
    error: { code: "CODEX_IMAGE_PROTOCOL_LIMIT" }
  })), "ADAPTER_IMAGE_PROTOCOL_LIMIT");
  assert.equal(connector.classifyFailure("not-json"), "ADAPTER_EXIT_NONZERO");
  assert.equal(parseRunnerFailureCode(JSON.stringify({
    schemaVersion: 1,
    error: { code: "CODEX_IMAGE_RESULT_INVALID", detail: "must-not-cross-boundary" }
  })), null);
});

test("Codex qualification fails closed for missing executable or login", async () => {
  const missing = await qualifyCodexConnector({
    resolveEntrypoint: async () => null,
    now: fixedNow
  });
  assert.equal(missing.readiness.state, "not_detected");
  assert.equal(missing.connector, null);

  const signedOut = await qualifyCodexConnector({
    resolveEntrypoint: async () => "/usr/local/bin/codex",
    probeLogin: async () => "needs_login",
    now: fixedNow
  });
  assert.equal(signedOut.readiness.state, "needs_login");
  assert.equal(signedOut.readiness.reasonCode, "CODEX_LOGIN_REQUIRED");
  assert.equal(signedOut.connector, null);
});

test("Codex qualification registers a ready Connector without reading auth material", async () => {
  let probedPath = "";
  const qualified = await qualifyCodexConnector({
    resolveEntrypoint: async () => "/usr/local/bin/codex",
    probeLogin: async (entrypoint) => {
      probedPath = entrypoint;
      return "ready";
    },
    environment: { CODEX_HOME: "/custom/codex-home" },
    now: fixedNow
  });

  assert.equal(probedPath, "/usr/local/bin/codex");
  assert.equal(qualified.readiness.state, "ready");
  assert.equal(qualified.connector?.fixedProcessEntrypoint, "/usr/local/bin/codex");
  assert.deepEqual(
    qualified.connector?.createExecutionSpec({
      taskId: "task",
      capabilityId: "code-analysis",
      workspacePath: "/tmp/task",
      images: [],
      executionEpoch: 1,
      checkpointRef: null
    }).environment,
    { NO_COLOR: "1", TERM: "dumb", CODEX_HOME: "/custom/codex-home" }
  );
});

test("explicit Codex path override refuses an executable with a different filename", async () => {
  assert.equal(await resolveCodexEntrypoint({ pathOverride: process.execPath }), null);
});

test("fake Codex CLI proves login reuse, stdin delivery, JSONL decoding, and Artifact filtering", async () => {
  const fixture = await createExecutableFakeCodex();
  try {
    assert.equal(await probeCodexLogin(fixture.path, {
      environment: { PATH: process.env.PATH },
      homeDirectory: fixture.root
    }), "ready");
    const qualified = await qualifyCodexConnector({
      pathOverride: fixture.path,
      environment: { PATH: process.env.PATH },
      homeDirectory: fixture.root
    });
    assert.equal(qualified.readiness.state, "ready");
    assert.ok(qualified.connector);

    const hostAgent = new TetiHostAgentKernel({ connectors: [qualified.connector!] });
    const request = task();
    const result = await hostAgent.execute(request, issueExecutionAuthority(request));
    assert.equal(result.state, "completed");
    assert.equal(result.artifact?.text, "codex:Review this explicit snippet.");
    assert.equal(result.artifact?.text.includes("must-not-project"), false);
    await hostAgent.shutdown();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function createExecutableFakeCodex(): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), "teti-fake-codex-"));
  const path = join(root, "codex");
  await copyFile(sourceFixture, path);
  await chmod(path, 0o755);
  return { root, path };
}

function task(): CallableAdapterTaskRequest {
  return {
    schemaVersion: 1,
    taskId: "codex-task-001",
    adapterId: "openai.codex.exec",
    agentId: "codex",
    capabilityId: "code-analysis",
    input: { kind: "text", text: "Review this explicit snippet." },
    createdAt: new Date().toISOString()
  };
}

function fixedNow(): Date {
  return new Date("2026-07-26T00:00:00.000Z");
}
