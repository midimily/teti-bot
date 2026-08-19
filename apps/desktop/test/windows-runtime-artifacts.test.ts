import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  assertPortableExecutable,
  resolveWindowsRuntimePaths,
  stagePinnedWindowsRpc,
  verifyWindowsRuntime,
  WINDOWS_RUNTIME_POLICY
} from "../scripts/windows-runtime.ts";

test("Windows Runtime policy pins Node, DeltaChat source, and an explicit DLL allowlist", () => {
  assert.equal(WINDOWS_RUNTIME_POLICY.node.version, "22.22.3");
  assert.equal(WINDOWS_RUNTIME_POLICY.node.sha256.length, 64);
  assert.equal(WINDOWS_RUNTIME_POLICY.deltaChat.revision.length, 40);
  assert.deepEqual(WINDOWS_RUNTIME_POLICY.allowedDlls, []);
});

test("Windows Runtime exit gate stays executable by Node 22 strip-types", async () => {
  const source = await readFile(
    new URL("../scripts/validate-windows-runtime.ts", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(
    source,
    /constructor\s*\(\s*(?:private|public|protected|readonly)\b/,
    "Node 22 strip-types does not support TypeScript parameter properties"
  );
});

test("portable executable validation accepts x64 PE and rejects other input", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-windows-pe-"));
  const valid = join(root, "valid.exe");
  const invalid = join(root, "invalid.exe");
  try {
    await writeFile(valid, fakeX64Pe());
    await writeFile(invalid, "not a PE", "utf8");
    await assert.doesNotReject(() => assertPortableExecutable(valid, "x86_64", "fixture"));
    await assert.rejects(
      () => assertPortableExecutable(invalid, "x86_64", "fixture"),
      /not a Windows PE/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows Runtime verification rejects hash drift and non-allowlisted DLLs", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-windows-runtime-"));
  const paths = resolveWindowsRuntimePaths(root);
  const sourceRpc = join(root, "built-rpc.exe");
  try {
    await mkdir(dirname(paths.node), { recursive: true });
    await writeFile(paths.node, fakeX64Pe());
    await writeFile(sourceRpc, fakeX64Pe());
    await stagePinnedWindowsRpc(
      root,
      sourceRpc,
      WINDOWS_RUNTIME_POLICY.deltaChat.revision
    );
    await writeFile(join(dirname(paths.rpc), "surprise.dll"), "unexpected", "utf8");

    const report = await verifyWindowsRuntime(root);

    assert.equal(report.ok, false);
    assert.match(report.errors.join(" "), /SHA-256/);
    assert.match(report.errors.join(" "), /non-allowlisted DLLs: surprise.dll/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function fakeX64Pe(): Buffer {
  const value = Buffer.alloc(256);
  value.write("MZ", 0, "ascii");
  value.writeUInt32LE(0x80, 0x3c);
  value.write("PE\0\0", 0x80, "ascii");
  value.writeUInt16LE(0x8664, 0x84);
  return value;
}
