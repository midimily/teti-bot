import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  isSafeAbsoluteLocalPath
} from "../../../core/application/local-path.ts";
import {
  validateCallableAdapterLaunchSpec
} from "../../../core/callability/adapter.ts";
import { validateWorkspaceSnapshot } from "../../../core/workspace/validation.ts";
import {
  codexEntrypointCandidates
} from "../../../integrations/agents/codex/adapter.ts";
import { parseRunnerManifest } from "../../../integrations/agents/codex/image-adapter.ts";
import {
  lifecyclePlatformCapabilities
} from "../lifecycle-sidecar/desktop-platform.ts";
import {
  loadAgentDetectorCatalog
} from "../lifecycle-sidecar/runtime/agents/config.ts";
import {
  cloneBuiltinAgentDetectors
} from "../lifecycle-sidecar/runtime/agents/defaults.ts";
import {
  parseWindowsTasklist
} from "../lifecycle-sidecar/runtime/agents/system.ts";
import {
  ProcessTransport,
  windowsTaskkillCommand
} from "../lifecycle-sidecar/runtime/callable/transports/process.ts";

test("Windows Agent catalog uses Windows detectors and omits unsupported Osaurus capabilities", async () => {
  const builtins = cloneBuiltinAgentDetectors("windows");
  assert.equal(builtins.some((definition) => definition.id === "osaurus"), false);
  assert.equal(
    builtins.flatMap((definition) => definition.installDetectors)
      .some((detector) => detector.type === "app_bundle"),
    false
  );
  const codex = builtins.find((definition) => definition.id === "codex");
  assert.ok(codex?.installDetectors.some((detector) =>
    detector.type === "executable_path"
    && detector.paths.some((path) => path.endsWith("codex.exe"))
  ));

  const capabilities = lifecyclePlatformCapabilities("windows");
  assert.equal(capabilities.osaurusRuntime, false);
  assert.equal(capabilities.osaurusNativeAgent, false);
  assert.equal(capabilities.processTreeCancellation, "taskkill-tree");

  const catalog = await loadAgentDetectorCatalog({
    path: "unused",
    platform: "windows",
    async readText() {
      return JSON.stringify({
        schemaVersion: 1,
        agents: [{
          id: "codex",
          enabled: true,
          pathOverride: "C:\\Program Files\\OpenAI\\codex.exe"
        }]
      });
    }
  });
  assert.equal(catalog.errors.length, 0);
  assert.deepEqual(catalog.definitions.find((definition) => definition.id === "codex")
    ?.installDetectors[0], {
      type: "executable_path",
      paths: ["C:\\Program Files\\OpenAI\\codex.exe"],
      expectedNames: ["codex"]
    });
});

test("Windows observer parses localized tasklist rows without exposing command lines", () => {
  const output = [
    '"codex.exe","4242","Console","1","12,000 K"',
    '"Cursor.exe","5310","Console","1","90,000 K"',
    "INFO: No tasks are running which match the specified criteria."
  ].join("\r\n");
  assert.deepEqual(parseWindowsTasklist(output), ["codex", "Cursor"]);
});

test("Windows Codex candidates and launch contract accept only a fixed native executable", () => {
  const candidates = codexEntrypointCandidates({
    PATH: "C:\\Tools;D:\\OpenAI",
    LOCALAPPDATA: "C:\\Users\\Teti\\AppData\\Local"
  }, "C:\\Users\\Teti", "windows");
  assert.ok(candidates.includes("C:\\Tools\\codex.exe"));
  assert.ok(candidates.includes(
    "C:\\Users\\Teti\\AppData\\Local\\Programs\\ChatGPT\\resources\\codex.exe"
  ));
  assert.doesNotThrow(() => validateCallableAdapterLaunchSpec({
    executable: "C:\\Tools\\codex.exe",
    args: ["exec", "--json"]
  }, "C:\\Tools\\codex.exe", "windows"));
  assert.throws(() => validateCallableAdapterLaunchSpec({
    executable: "C:\\Tools\\codex.cmd",
    args: []
  }, "C:\\Tools\\codex.exe", "windows"));
});

test("Task, Workspace, image, and Artifact boundaries reject Windows path escapes", () => {
  assert.equal(isSafeAbsoluteLocalPath("C:\\Teti\\Workspace\\image.png", "windows"), true);
  for (const unsafe of [
    "C:relative\\image.png",
    "\\\\server\\share\\image.png",
    "\\\\?\\C:\\Teti\\image.png",
    "C:\\Teti\\..\\private.png",
    "/Users/teti/image.png"
  ]) {
    assert.equal(isSafeAbsoluteLocalPath(unsafe, "windows"), false, unsafe);
  }

  assert.doesNotThrow(() => validateWorkspaceSnapshot({
    schemaVersion: 1,
    snapshotId: "snapshot:windows",
    workspaceId: "workspace:windows",
    workspaceRevision: 1,
    access: ["read"],
    snapshotPath: "C:\\Teti\\Profiles\\p1\\workspaces\\snapshot",
    createdAt: "2026-08-19T00:00:00.000Z"
  }, "windows"));
  assert.deepEqual(parseRunnerManifest(JSON.stringify({
    schemaVersion: 1,
    text: "done",
    images: [{ path: "C:\\Teti\\Profiles\\p1\\artifacts\\result.png" }]
  }), "windows").images, [
    { path: "C:\\Teti\\Profiles\\p1\\artifacts\\result.png" }
  ]);
  assert.throws(() => parseRunnerManifest(JSON.stringify({
    schemaVersion: 1,
    text: "done",
    images: [{ path: "\\\\server\\share\\result.png" }]
  }), "windows"), /CODEX_IMAGE_OUTPUT_INVALID/);
});

test("Windows cancellation always targets the full descendant tree with a fixed system tool", () => {
  assert.deepEqual(windowsTaskkillCommand(4242, false, { SystemRoot: "C:\\Windows" }), {
    executable: "C:\\Windows\\System32\\taskkill.exe",
    args: ["/PID", "4242", "/T"]
  });
  assert.deepEqual(windowsTaskkillCommand(4242, true, { SystemRoot: "C:\\Windows" }), {
    executable: "C:\\Windows\\System32\\taskkill.exe",
    args: ["/PID", "4242", "/T", "/F"]
  });
  assert.throws(
    () => windowsTaskkillCommand(4242, true, { SystemRoot: "\\\\server\\Windows" }),
    (error: unknown) => errorCode(error) === "PROCESS_TREE_TERMINATION_FAILED"
  );
});

test("Process Transport routes Windows cancellation through the tree terminator", async () => {
  const calls: Array<{ pid: number; force: boolean }> = [];
  const transport = new ProcessTransport({
    platform: "win32",
    environment: process.env,
    async windowsTreeKiller(pid, force) {
      calls.push({ pid, force });
      process.kill(pid, force ? "SIGKILL" : "SIGTERM");
    }
  });
  const execution = transport.start({
    spec: {
      kind: "process",
      executable: process.execPath,
      args: ["-e", "setInterval(() => undefined, 1000)"],
      environment: {}
    },
    workspacePath: tmpdir()
  });
  assert.ok(execution.pid);
  await execution.terminate(500);
  assert.deepEqual(calls, [{ pid: execution.pid!, force: false }]);
});

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}
