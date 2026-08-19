import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { basename, dirname } from "node:path";
import test from "node:test";
import { createAgentObserverSystem } from "../lifecycle-sidecar/runtime/agents/system.ts";

const hostPlatform = process.platform === "win32" ? "windows" : "macos";
const executableName = basename(process.execPath);
const executableSearchName = process.platform === "win32"
  ? executableName.replace(/\.exe$/i, "")
  : executableName;
const observerEnvironment = {
  ...process.env,
  PATH: dirname(process.execPath),
  ...(process.platform === "win32" ? { PATHEXT: ".EXE" } : {})
};

test("system observer resolves executables but never returns their path in an observation value", async () => {
  const system = createAgentObserverSystem(hostPlatform, observerEnvironment);
  const canonicalExecutable = await realpath(process.execPath);
  const resolved = await system.findExecutable([executableSearchName]);
  assert.equal(resolved?.canonicalPath, canonicalExecutable);
  assert.match(await system.runVersionProbe(resolved!.canonicalPath, {
    type: "fixed_args",
    args: ["--version"],
    timeoutMs: 2_000,
    maxOutputBytes: 1_024
  }) ?? "", /^v?\d+\.\d+\.\d+/);
  assert.equal(
    (await system.findExecutablePath([process.execPath], [executableName]))?.canonicalPath,
    canonicalExecutable
  );
  assert.equal(await system.findExecutablePath([process.execPath], ["another-agent"]), null);
});

test("version probes enforce timeout, output bounds, and secret/path sanitization", async () => {
  const system = createAgentObserverSystem(hostPlatform, observerEnvironment);
  const probe = {
    type: "fixed_args" as const,
    args: ["-e", "setInterval(() => undefined, 1_000)"] as const,
    timeoutMs: 100,
    maxOutputBytes: 128
  };

  await assert.rejects(
    () => system.runVersionProbe(process.execPath, probe),
    (error: unknown) => errorCode(error) === "VERSION_PROBE_TIMEOUT"
  );
  await assert.rejects(
    () => system.runVersionProbe(process.execPath, {
      ...probe,
      args: ["-e", "process.stdout.write('x'.repeat(8 * 1024))"],
      timeoutMs: 10_000
    }),
    (error: unknown) => errorCode(error) === "VERSION_OUTPUT_LIMIT"
  );
  assert.equal(await system.runVersionProbe(process.execPath, {
    ...probe,
    args: ["-e", "process.stdout.write('token 1 /Users/private/project\\n')"],
    timeoutMs: 10_000
  }), null);
});

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}
