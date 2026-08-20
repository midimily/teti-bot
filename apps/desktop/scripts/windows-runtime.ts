import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { WINDOWS_BUILD_MACHINE_POLICY } from "./windows-build-machine-policy.ts";

const execFileAsync = promisify(execFile);

export const WINDOWS_RUNTIME_POLICY = Object.freeze({
  schemaVersion: 1 as const,
  platform: "windows" as const,
  architecture: "x64" as const,
  rustTarget: WINDOWS_BUILD_MACHINE_POLICY.rust.target,
  node: Object.freeze({
    version: WINDOWS_BUILD_MACHINE_POLICY.node.version,
    fileName: WINDOWS_BUILD_MACHINE_POLICY.node.runtimeFileName,
    url: WINDOWS_BUILD_MACHINE_POLICY.node.runtimeUrl,
    sha256: WINDOWS_BUILD_MACHINE_POLICY.node.runtimeSha256
  }),
  deltaChat: Object.freeze({
    revision: WINDOWS_BUILD_MACHINE_POLICY.deltaChat.revision,
    version: WINDOWS_BUILD_MACHINE_POLICY.deltaChat.version,
    fileName: WINDOWS_BUILD_MACHINE_POLICY.deltaChat.fileName
  }),
  // The pinned vendored build is a single portable executable. Keep this
  // allowlist explicit: an unexpected adjacent DLL must stop packaging.
  allowedDlls: Object.freeze([] as string[])
});

export interface WindowsRuntimePaths {
  node: string;
  rpc: string;
  rpcProvenance: string;
}

export interface WindowsRpcProvenance {
  schemaVersion: 1;
  sourceRevision: string;
  target: string;
  version: string;
  sha256: string;
}

export interface WindowsRuntimeVerification {
  ok: boolean;
  target: string;
  nodeVersion: string;
  rpcVersion: string;
  nodeSha256?: string;
  rpcSha256?: string;
  allowlistedDlls: string[];
  errors: string[];
}

export function resolveWindowsRuntimePaths(repoRoot: string): WindowsRuntimePaths {
  const nodeRoot = join(repoRoot, ".tools", "node", "win-x64", WINDOWS_RUNTIME_POLICY.node.version);
  const rpcRoot = join(
    repoRoot,
    ".tools",
    "deltachat-rpc-server",
    WINDOWS_RUNTIME_POLICY.rustTarget
  );
  return {
    node: join(nodeRoot, WINDOWS_RUNTIME_POLICY.node.fileName),
    rpc: join(rpcRoot, WINDOWS_RUNTIME_POLICY.deltaChat.fileName),
    rpcProvenance: join(rpcRoot, "provenance.json")
  };
}

export async function installPinnedWindowsNode(repoRoot: string): Promise<string> {
  const paths = resolveWindowsRuntimePaths(repoRoot);
  await mkdir(dirname(paths.node), { recursive: true });
  const temporary = `${paths.node}.download`;
  await rm(temporary, { force: true });

  const response = await fetch(WINDOWS_RUNTIME_POLICY.node.url, { redirect: "error" });
  if (!response.ok || !response.body) {
    throw new Error(`Unable to download pinned Windows Node (${response.status}).`);
  }
  await writeFile(temporary, new Uint8Array(await response.arrayBuffer()), { flag: "wx" });
  try {
    await assertSha256(temporary, WINDOWS_RUNTIME_POLICY.node.sha256, "Windows node.exe");
    await assertPortableExecutable(temporary, "x86_64", "Windows node.exe");
    await rm(paths.node, { force: true });
    await rename(temporary, paths.node);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return paths.node;
}

export async function stagePinnedWindowsRpc(
  repoRoot: string,
  source: string,
  sourceRevision: string
): Promise<string> {
  if (sourceRevision !== WINDOWS_RUNTIME_POLICY.deltaChat.revision) {
    throw new Error("Windows RPC source revision does not match the pinned runtime policy.");
  }
  await assertPortableExecutable(source, "x86_64", "Windows deltachat-rpc-server.exe");
  const paths = resolveWindowsRuntimePaths(repoRoot);
  await mkdir(dirname(paths.rpc), { recursive: true });
  await copyFileWithWindowsRetry(source, paths.rpc);
  const sha256 = await sha256File(paths.rpc);
  const provenance: WindowsRpcProvenance = {
    schemaVersion: 1,
    sourceRevision,
    target: WINDOWS_RUNTIME_POLICY.rustTarget,
    version: WINDOWS_RUNTIME_POLICY.deltaChat.version,
    sha256
  };
  await writeFile(paths.rpcProvenance, `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
  return paths.rpc;
}

export async function verifyWindowsRuntime(repoRoot: string): Promise<WindowsRuntimeVerification> {
  const paths = resolveWindowsRuntimePaths(repoRoot);
  const errors: string[] = [];
  const report: WindowsRuntimeVerification = {
    ok: false,
    target: WINDOWS_RUNTIME_POLICY.rustTarget,
    nodeVersion: WINDOWS_RUNTIME_POLICY.node.version,
    rpcVersion: WINDOWS_RUNTIME_POLICY.deltaChat.version,
    allowlistedDlls: [...WINDOWS_RUNTIME_POLICY.allowedDlls],
    errors
  };

  report.nodeSha256 = await verifyFile(paths.node, "Windows node.exe", errors);
  if (report.nodeSha256 && report.nodeSha256 !== WINDOWS_RUNTIME_POLICY.node.sha256) {
    errors.push("Windows node.exe SHA-256 does not match the pinned Node release.");
  }
  await collectPortableExecutableError(paths.node, "Windows node.exe", errors);

  report.rpcSha256 = await verifyFile(paths.rpc, "Windows deltachat-rpc-server.exe", errors);
  await collectPortableExecutableError(paths.rpc, "Windows deltachat-rpc-server.exe", errors);
  const provenance = await readRpcProvenance(paths.rpcProvenance, errors);
  if (provenance) {
    if (provenance.sourceRevision !== WINDOWS_RUNTIME_POLICY.deltaChat.revision) {
      errors.push("Windows RPC provenance has the wrong source revision.");
    }
    if (provenance.target !== WINDOWS_RUNTIME_POLICY.rustTarget) {
      errors.push("Windows RPC provenance has the wrong Rust target.");
    }
    if (provenance.version !== WINDOWS_RUNTIME_POLICY.deltaChat.version) {
      errors.push("Windows RPC provenance has the wrong version.");
    }
    if (report.rpcSha256 && provenance.sha256 !== report.rpcSha256) {
      errors.push("Windows RPC SHA-256 does not match its provenance.");
    }
  }

  const adjacentDlls = await listAdjacentDlls(dirname(paths.rpc));
  const unexpectedDlls = adjacentDlls.filter(
    (name) => !WINDOWS_RUNTIME_POLICY.allowedDlls.includes(name)
  );
  const missingDlls = WINDOWS_RUNTIME_POLICY.allowedDlls.filter(
    (name) => !adjacentDlls.includes(name)
  );
  if (unexpectedDlls.length > 0) {
    errors.push(`Windows Runtime contains non-allowlisted DLLs: ${unexpectedDlls.join(", ")}.`);
  }
  if (missingDlls.length > 0) {
    errors.push(`Windows Runtime is missing allowlisted DLLs: ${missingDlls.join(", ")}.`);
  }

  if (process.platform === "win32") {
    await verifyExecutableVersion(paths.node, ["--version"], `v${WINDOWS_RUNTIME_POLICY.node.version}`, "Node", errors);
    await verifyExecutableVersion(
      paths.rpc,
      ["--version"],
      WINDOWS_RUNTIME_POLICY.deltaChat.version,
      "DeltaChat RPC",
      errors
    );
  }

  report.ok = errors.length === 0;
  return report;
}

export async function copyAllowlistedWindowsDlls(repoRoot: string, destination: string): Promise<void> {
  const { rpc } = resolveWindowsRuntimePaths(repoRoot);
  await mkdir(destination, { recursive: true });
  for (const fileName of WINDOWS_RUNTIME_POLICY.allowedDlls) {
    await copyFile(join(dirname(rpc), fileName), join(destination, fileName));
  }
}

async function verifyFile(path: string, label: string, errors: string[]): Promise<string | undefined> {
  try {
    const value = await stat(path);
    if (!value.isFile()) throw new Error("not a file");
    return await sha256File(path);
  } catch {
    errors.push(`${label} is missing.`);
    return undefined;
  }
}

async function collectPortableExecutableError(path: string, label: string, errors: string[]): Promise<void> {
  try {
    await assertPortableExecutable(path, "x86_64", label);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
}

async function readRpcProvenance(
  path: string,
  errors: string[]
): Promise<WindowsRpcProvenance | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<WindowsRpcProvenance>;
    if (value.schemaVersion !== 1
      || typeof value.sourceRevision !== "string"
      || typeof value.target !== "string"
      || typeof value.version !== "string"
      || typeof value.sha256 !== "string") {
      throw new Error("invalid provenance");
    }
    return value as WindowsRpcProvenance;
  } catch {
    errors.push("Windows RPC provenance is missing or invalid.");
    return undefined;
  }
}

async function listAdjacentDlls(root: string): Promise<string[]> {
  try {
    return (await readdir(root))
      .filter((name) => name.toLowerCase().endsWith(".dll"))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

async function verifyExecutableVersion(
  path: string,
  args: string[],
  expected: string,
  label: string,
  errors: string[]
): Promise<void> {
  try {
    const { stdout, stderr } = await execFileAsync(path, args, { timeout: 5_000 });
    const actual = String(stdout || stderr).trim();
    if (actual !== expected) errors.push(`${label} reported ${actual || "an empty version"}; expected ${expected}.`);
  } catch (error) {
    errors.push(`${label} version check failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function assertPortableExecutable(
  path: string,
  expectedArchitecture: "x86_64",
  label: string
): Promise<void> {
  const bytes = await readFile(path);
  if (bytes.length < 64 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
    throw new Error(`${label} is not a Windows PE executable.`);
  }
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset + 6 > bytes.length || bytes.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") {
    throw new Error(`${label} has an invalid Windows PE header.`);
  }
  const machine = bytes.readUInt16LE(peOffset + 4);
  if (expectedArchitecture === "x86_64" && machine !== 0x8664) {
    throw new Error(`${label} is not an x86_64 Windows executable.`);
  }
}

async function assertSha256(path: string, expected: string, label: string): Promise<void> {
  const actual = await sha256File(path);
  if (actual !== expected) throw new Error(`${label} SHA-256 verification failed.`);
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function copyFileWithWindowsRetry(source: string, destination: string): Promise<void> {
  const attempts = process.platform === "win32" ? 12 : 1;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await copyFile(source, destination);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt === attempts || !new Set(["EBUSY", "EPERM", "EACCES"]).has(code ?? "")) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(attempt * 250, 1_500)));
    }
  }
  throw lastError;
}
