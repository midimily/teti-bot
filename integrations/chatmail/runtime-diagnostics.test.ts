import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectChatmailRpcRuntime, resolveExecutablePath } from "./runtime-diagnostics.ts";

test("runtime diagnostics reports missing RPC executable", async () => {
  const accountsPath = await mkdtemp(join(tmpdir(), "teti-rpc-diag-missing-"));
  try {
    const report = await inspectChatmailRpcRuntime({
      rpcServerPath: join(accountsPath, "missing-deltachat-rpc-server"),
      accountsPath
    });

    assert.equal(report.exists, false);
    assert.equal(report.executable, false);
    assert.equal(report.jsonRpcHealth, false);
    assert.match(report.errors.join(" "), /not found/);
  } finally {
    await rm(accountsPath, { recursive: true, force: true });
  }
});

test("runtime diagnostics reports non-executable RPC file", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-rpc-diag-nonexec-"));
  const binary = join(root, "deltachat-rpc-server");
  try {
    await writeFile(binary, "not executable\n", "utf8");
    const report = await inspectChatmailRpcRuntime({
      rpcServerPath: binary,
      accountsPath: join(root, "accounts")
    });

    assert.equal(report.exists, true);
    assert.equal(report.executable, false);
    assert.equal(report.jsonRpcHealth, false);
    assert.match(report.errors.join(" "), /not executable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime diagnostics can perform non-destructive JSON-RPC health", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-rpc-diag-health-"));
  const binary = join(root, "fake-rpc-server.js");
  try {
    await writeFile(
      binary,
      [
        "#!/usr/bin/env node",
        "if (process.argv.includes('--version')) { console.log('fake-rpc 1.0.0'); process.exit(0); }",
        "process.stdin.setEncoding('utf8');",
        "let buffer = '';",
        "process.stdin.on('data', (chunk) => {",
        "  buffer += chunk;",
        "  let index = buffer.indexOf('\\n');",
        "  while (index !== -1) {",
        "    const line = buffer.slice(0, index);",
        "    buffer = buffer.slice(index + 1);",
        "    if (line.trim()) {",
        "      const req = JSON.parse(line);",
        "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { deltachat_core_version: 'test' } }) + '\\n');",
        "    }",
        "    index = buffer.indexOf('\\n');",
        "  }",
        "});"
      ].join("\n"),
      "utf8"
    );
    await chmod(binary, 0o755);

    const report = await inspectChatmailRpcRuntime({
      rpcServerPath: binary,
      accountsPath: join(root, "accounts")
    });

    assert.equal(report.exists, true);
    assert.equal(report.executable, true);
    assert.equal(report.version, "fake-rpc 1.0.0");
    assert.equal(report.accountsPathWritable, true);
    assert.equal(report.jsonRpcHealth, true);
    assert.deepEqual(report.systemInfoKeys, ["deltachat_core_version"]);
    assert.equal(report.cleanShutdown, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("RPC executable resolution honors PATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-rpc-path-"));
  const binary = join(root, "deltachat-rpc-server");
  try {
    await writeFile(binary, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(binary, 0o755);

    assert.equal(await resolveExecutablePath("deltachat-rpc-server", { PATH: root }), binary);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
