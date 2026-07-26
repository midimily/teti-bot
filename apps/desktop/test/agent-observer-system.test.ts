import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMacAgentObserverSystem } from "../lifecycle-sidecar/runtime/agents/system.ts";

test("system observer resolves executables but never returns their path in an observation value", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-agent-observer-"));
  const executable = join(root, "safe-agent");
  try {
    await writeExecutable(executable, "#!/bin/sh\nprintf 'Safe Agent 1.2.3\\n'\n");
    const system = createMacAgentObserverSystem({ PATH: root });
    const resolved = await system.findExecutable(["safe-agent"]);
    assert.equal(resolved?.canonicalPath, await realpath(executable));
    assert.equal(await system.runVersionProbe(resolved!.canonicalPath, {
      type: "fixed_args",
      args: ["--version"],
      timeoutMs: 2_000,
      maxOutputBytes: 1_024
    }), "Safe Agent 1.2.3");
    assert.equal(
      (await system.findExecutablePath([executable], ["safe-agent"]))?.canonicalPath,
      await realpath(executable)
    );
    assert.equal(await system.findExecutablePath([executable], ["another-agent"]), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("version probes enforce timeout, output bounds, and secret/path sanitization", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-agent-observer-"));
  try {
    const looping = join(root, "looping-agent");
    const privateOutput = join(root, "private-agent");
    await writeExecutable(looping, "#!/bin/sh\nwhile :; do :; done\n");
    await writeExecutable(privateOutput, "#!/bin/sh\nprintf 'token 1 /Users/private/project\\n'\n");
    const system = createMacAgentObserverSystem({ PATH: root });
    const probe = {
      type: "fixed_args" as const,
      args: ["--version"] as const,
      timeoutMs: 100,
      maxOutputBytes: 128
    };

    await assert.rejects(
      () => system.runVersionProbe(looping, probe),
      (error: unknown) => errorCode(error) === "VERSION_PROBE_TIMEOUT"
    );
    await assert.rejects(
      () => system.runVersionProbe("/usr/bin/yes", {
        ...probe,
        timeoutMs: 2_000
      }),
      (error: unknown) => errorCode(error) === "VERSION_OUTPUT_LIMIT"
    );
    assert.equal(await system.runVersionProbe(privateOutput, {
      ...probe,
      timeoutMs: 2_000
    }), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content, { encoding: "utf8", mode: 0o700 });
  await chmod(path, 0o700);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}
