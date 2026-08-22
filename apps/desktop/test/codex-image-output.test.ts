import assert from "node:assert/strict";
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";
import { build } from "esbuild";
import type { CallableAdapterTaskRequest } from "../../../core/callability/adapter.ts";
import {
  issueExecutionAuthority,
  type AgentConnector
} from "../../../core/callability/agent-core.ts";
import { CodexImageConnector } from "../../../integrations/agents/codex/image-adapter.ts";
import {
  CodexImageOutputError,
  persistCodexGeneratedImages
} from "../lifecycle-sidecar/runtime/callable/codex-image-output.ts";
import {
  parseCodexImageRunnerDiagnostic,
  type CodexImageRunnerDiagnostic
} from "../lifecycle-sidecar/runtime/callable/codex-image-diagnostics.ts";
import { TetiHostAgentKernel } from "../lifecycle-sidecar/runtime/callable/kernel.ts";
import { FileTaskAttachmentStore } from "../lifecycle-sidecar/runtime/tasks/attachments.ts";

const testRoot = dirname(fileURLToPath(import.meta.url));
const validImagePath = join(testRoot, "..", "assets", "teti-logo-default.png");
const runnerPath = join(
  testRoot,
  "..",
  "lifecycle-sidecar",
  "runtime",
  "callable",
  "codex-image-runner.ts"
);
const fakeServerFixture = join(testRoot, "fixtures", "fake-codex-image-app-server.mjs");
const macTest = process.platform === "darwin" ? test : test.skip;

test("Codex image output waits for a settling file and persists a verified private copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-codex-image-settling-"));
  try {
    const workspacePath = join(root, "workspace");
    const sourcePath = join(root, "generated.png");
    await mkdir(workspacePath, { recursive: true });
    const complete = await readFile(validImagePath);
    await writeFile(sourcePath, complete.subarray(0, Math.floor(complete.length / 2)));
    const completedWrite = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        writeFile(sourcePath, complete).then(() => resolve(), reject);
      }, 30);
    });

    const images = await persistCodexGeneratedImages({
      workspacePath,
      savedPaths: [sourcePath],
      maximumAttempts: 20,
      retryDelayMs: 5
    });
    await completedWrite;

    assert.equal(images.length, 1);
    assert.equal(images[0]!.path.startsWith(`${join(workspacePath, ".teti-image-output")}${sep}`), true);
    assert.deepEqual((await readFile(images[0]!.path)).subarray(0, 8), complete.subarray(0, 8));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex image output separates invalid files from files that never become ready", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-codex-image-invalid-"));
  try {
    const workspacePath = join(root, "workspace");
    const invalidPath = join(root, "invalid.png");
    await mkdir(workspacePath, { recursive: true });
    await writeFile(invalidPath, "not an image", "utf8");

    await assert.rejects(
      persistCodexGeneratedImages({
        workspacePath,
        savedPaths: [invalidPath],
        maximumAttempts: 2,
        retryDelayMs: 0
      }),
      (error) => error instanceof CodexImageOutputError
        && error.code === "CODEX_IMAGE_RESULT_INVALID"
    );
    await assert.rejects(
      persistCodexGeneratedImages({
        workspacePath,
        savedPaths: [join(root, "missing.png")],
        maximumAttempts: 2,
        retryDelayMs: 0
      }),
      (error) => error instanceof CodexImageOutputError
        && error.code === "CODEX_IMAGE_RESULT_NOT_READY"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

macTest("Codex image runner projects savedPath from a result larger than two MiB", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-codex-image-server-exit-"));
  try {
    const workspacePath = join(root, "workspace");
    const fakeCodexPath = join(root, "codex");
    await mkdir(workspacePath, { recursive: true });
    await copyFile(fakeServerFixture, fakeCodexPath);
    await chmod(fakeCodexPath, 0o755);

    const result = await run(process.execPath, [
      "--experimental-strip-types",
      runnerPath,
      "--codex",
      fakeCodexPath,
      "--workspace",
      workspacePath
    ], {
      ...process.env,
      TETI_FAKE_CODEX_IMAGE_PATH: validImagePath
    }, "create an image");

    assert.equal(result.code, 0, result.stderr);
    const manifest = JSON.parse(result.stdout) as {
      schemaVersion: number;
      text: string;
      images: Array<{ path: string }>;
    };
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.images.length, 1);
    assert.equal(result.stdout.includes("must-not-project"), false);
    assert.equal(Buffer.byteLength(result.stdout, "utf8") < 64 * 1024, true);
    assert.equal(
      manifest.images[0]!.path.startsWith(`${join(workspacePath, ".teti-image-output")}${sep}`),
      true
    );
    assert.equal((await readFile(manifest.images[0]!.path)).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    const diagnostics = runnerDiagnostics(result.stderr);
    assert.deepEqual(
      diagnostics.filter((entry) => entry.state === "completed").map((entry) => entry.stage),
      ["initialize", "thread/start", "turn/start", "image-result"]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

macTest("Codex image runner bounds every app-server handshake stage", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-codex-image-handshake-timeout-"));
  try {
    const workspacePath = join(root, "workspace");
    const fakeCodexPath = join(root, "codex");
    await mkdir(workspacePath, { recursive: true });
    await copyFile(fakeServerFixture, fakeCodexPath);
    await chmod(fakeCodexPath, 0o755);

    const result = await run(process.execPath, [
      "--experimental-strip-types",
      runnerPath,
      "--codex",
      fakeCodexPath,
      "--workspace",
      workspacePath
    ], {
      ...process.env,
      TETI_FAKE_CODEX_IMAGE_PATH: validImagePath,
      TETI_FAKE_CODEX_HANG_STAGE: "initialize",
      TETI_FAKE_CODEX_STDERR: "token=must-not-log C:\\Users\\jesse\\private.log",
      TETI_CODEX_IMAGE_REQUEST_TIMEOUT_MS: "25"
    }, "create an image");

    assert.equal(result.code, 2, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      schemaVersion: 1,
      error: { code: "CODEX_IMAGE_INITIALIZE_TIMEOUT" }
    });
    const failed = runnerDiagnostics(result.stderr).find((entry) => entry.state === "failed");
    assert.equal(failed?.stage, "initialize");
    assert.equal(failed?.failureCode, "CODEX_IMAGE_INITIALIZE_TIMEOUT");
    assert.equal(failed?.exitCode, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

macTest("Codex image runner fails fast when app-server exits cleanly before initialize", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-codex-image-clean-early-exit-"));
  try {
    const workspacePath = join(root, "workspace");
    const fakeCodexPath = join(root, "codex");
    await mkdir(workspacePath, { recursive: true });
    await copyFile(fakeServerFixture, fakeCodexPath);
    await chmod(fakeCodexPath, 0o755);

    const startedAt = Date.now();
    const result = await run(process.execPath, [
      "--experimental-strip-types",
      runnerPath,
      "--codex",
      fakeCodexPath,
      "--workspace",
      workspacePath
    ], {
      ...process.env,
      TETI_FAKE_CODEX_IMAGE_PATH: validImagePath,
      TETI_FAKE_CODEX_EXIT_STAGE: "initialize"
    }, "create an image");

    assert.equal(result.code, 2, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      schemaVersion: 1,
      error: { code: "CODEX_IMAGE_SERVER_EXITED" }
    });
    assert.ok(Date.now() - startedAt < 5_000);
    const failed = runnerDiagnostics(result.stderr).find((entry) => entry.state === "failed");
    assert.equal(failed?.stage, "initialize");
    assert.equal(failed?.exitCode, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

macTest("Codex image runner reports the dedicated safe code above eight MiB", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-codex-image-protocol-limit-"));
  try {
    const workspacePath = join(root, "workspace");
    const fakeCodexPath = join(root, "codex");
    await mkdir(workspacePath, { recursive: true });
    await copyFile(fakeServerFixture, fakeCodexPath);
    await chmod(fakeCodexPath, 0o755);

    const result = await run(process.execPath, [
      "--experimental-strip-types",
      runnerPath,
      "--codex",
      fakeCodexPath,
      "--workspace",
      workspacePath
    ], {
      ...process.env,
      TETI_FAKE_CODEX_IMAGE_PATH: validImagePath,
      TETI_FAKE_CODEX_RESULT_BYTES: String(8 * 1024 * 1024)
    }, "create an image");

    assert.equal(result.code, 2, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      schemaVersion: 1,
      error: { code: "CODEX_IMAGE_PROTOCOL_LIMIT" }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

macTest("real Codex image runner completes through Host Agent and Artifact Store", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-codex-image-full-pipeline-"));
  const workspaceRoot = join(root, "workspaces");
  const fakeCodexPath = join(root, "codex");
  const bundledRunnerPath = join(root, "codex-image-runner.mjs");
  await mkdir(workspaceRoot, { recursive: true });
  await copyFile(fakeServerFixture, fakeCodexPath);
  await chmod(fakeCodexPath, 0o755);
  await build({
    entryPoints: [runnerPath],
    outfile: bundledRunnerPath,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "silent"
  });

  const productionConnector = new CodexImageConnector({
    nodeEntrypoint: process.execPath,
    runnerPath: bundledRunnerPath,
    codexEntrypoint: fakeCodexPath
  });
  const connector: AgentConnector = {
    descriptor: productionConnector.descriptor,
    resourceBinding: productionConnector.resourceBinding,
    fixedProcessEntrypoint: productionConnector.fixedProcessEntrypoint,
    createExecutionSpec: async (context) => {
      const launch = productionConnector.createExecutionSpec(context);
      return {
        ...launch,
        environment: {
          ...launch.environment,
          TETI_FAKE_CODEX_IMAGE_PATH: validImagePath
        }
      };
    },
    decodeArtifact: (stdout) => productionConnector.decodeArtifact(stdout),
    classifyFailure: (stdout) => productionConnector.classifyFailure(stdout)
  };
  const artifactStore = new FileTaskAttachmentStore(join(root, "artifacts"));
  const diagnostics: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const hostAgent = new TetiHostAgentKernel({
    connectors: [connector],
    workspaceRoot,
    artifactImageStore: artifactStore,
    onDiagnostic: (event, fields) => diagnostics.push({ event, fields: structuredClone(fields) })
  });

  try {
    const taskId = "codex-image-full-pipeline";
    const request: CallableAdapterTaskRequest = {
      schemaVersion: 2,
      taskId,
      adapterId: "openai.codex.imagegen",
      agentId: "codex",
      capabilityId: "image-editing",
      input: { kind: "parts", text: "bounded image test" },
      createdAt: new Date().toISOString()
    };
    const result = await hostAgent.execute(request, issueExecutionAuthority(request));

    assert.equal(result.state, "completed");
    assert.equal(result.artifact?.kind, "parts");
    if (result.artifact?.kind !== "parts") throw new Error("Expected an image Artifact.");
    assert.equal(result.artifact.images.length, 1);
    assert.equal(JSON.stringify(result.artifact).includes("must-not-project"), false);
    const storedPath = await artifactStore.resolveImage({
      taskId,
      purpose: "artifact",
      part: result.artifact.images[0]!
    });
    assert.ok(storedPath);
    assert.equal((await readFile(storedPath)).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.deepEqual(
      diagnostics
        .filter((entry) => entry.event === "callable.image-runner"
          && entry.fields.state === "completed")
        .map((entry) => entry.fields.executionStage),
      ["initialize", "thread/start", "turn/start", "image-result"]
    );
  } finally {
    await hostAgent.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

function run(
  executable: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  stdin: string
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

function runnerDiagnostics(stderr: string): CodexImageRunnerDiagnostic[] {
  return stderr
    .split(/\r?\n/)
    .map(parseCodexImageRunnerDiagnostic)
    .filter((entry): entry is CodexImageRunnerDiagnostic => entry !== null);
}
