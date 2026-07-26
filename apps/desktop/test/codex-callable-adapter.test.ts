import assert from "node:assert/strict";
import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { CallableAdapterTaskRequest } from "../../../core/callability/adapter.ts";
import {
  CODEX_CONTROLLED_EXEC_ARGS,
  CodexCallableAdapter,
  probeCodexLogin,
  qualifyCodexCallableAdapter,
  resolveCodexEntrypoint
} from "../../../integrations/agents/codex/adapter.ts";
import { CallableAdapterKernel } from "../lifecycle-sidecar/runtime/callable/kernel.ts";

const sourceFixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-codex-cli.mjs"
);

test("Codex Adapter uses a fixed non-interactive, ephemeral, read-only JSONL entrypoint", () => {
  const adapter = new CodexCallableAdapter({
    entrypoint: "/Applications/ChatGPT.app/Contents/Resources/codex",
    codexHome: "/safe/local/codex-home"
  });
  const launch = adapter.createLaunchSpec({
    taskId: "task-001",
    capabilityId: "code-analysis",
    workspacePath: "/private/tmp/isolated",
    images: []
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

  const imageLaunch = adapter.createLaunchSpec({
    taskId: "task-image",
    capabilityId: "code-analysis",
    workspacePath: "/private/tmp/isolated",
    images: [{
      attachmentId: "image-1",
      mimeType: "image/png",
      path: "/private/tmp/isolated/input-image-1.png"
    }]
  });
  assert.deepEqual(imageLaunch.args.slice(-4), [
    "--image",
    "/private/tmp/isolated/input-image-1.png",
    "--",
    "-"
  ]);
});

test("Codex qualification fails closed for missing executable or login", async () => {
  const missing = await qualifyCodexCallableAdapter({
    resolveEntrypoint: async () => null,
    now: fixedNow
  });
  assert.equal(missing.readiness.state, "not_detected");
  assert.equal(missing.adapter, null);

  const signedOut = await qualifyCodexCallableAdapter({
    resolveEntrypoint: async () => "/usr/local/bin/codex",
    probeLogin: async () => "needs_login",
    now: fixedNow
  });
  assert.equal(signedOut.readiness.state, "needs_login");
  assert.equal(signedOut.readiness.reasonCode, "CODEX_LOGIN_REQUIRED");
  assert.equal(signedOut.adapter, null);
});

test("Codex qualification registers a ready Adapter without reading auth material", async () => {
  let probedPath = "";
  const qualified = await qualifyCodexCallableAdapter({
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
  assert.equal(qualified.adapter?.entrypoint, "/usr/local/bin/codex");
  assert.deepEqual(
    qualified.adapter?.createLaunchSpec({
      taskId: "task",
      capabilityId: "code-analysis",
      workspacePath: "/tmp/task",
      images: []
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
    const qualified = await qualifyCodexCallableAdapter({
      pathOverride: fixture.path,
      environment: { PATH: process.env.PATH },
      homeDirectory: fixture.root
    });
    assert.equal(qualified.readiness.state, "ready");
    assert.ok(qualified.adapter);

    const kernel = new CallableAdapterKernel({ adapters: [qualified.adapter!] });
    const result = await kernel.execute(task());
    assert.equal(result.state, "completed");
    assert.equal(result.artifact?.text, "codex:Review this explicit snippet.");
    assert.equal(result.artifact?.text.includes("must-not-project"), false);
    await kernel.shutdown();
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
