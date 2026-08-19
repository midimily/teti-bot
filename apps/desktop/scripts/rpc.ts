import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { repoLocalRpcServerPath, REPO_LOCAL_RPC_TARGET } from "../../../integrations/chatmail/runtime-config.ts";
import { inspectChatmailRpcRuntime } from "../../../integrations/chatmail/runtime-diagnostics.ts";
import {
  stagePinnedWindowsRpc,
  WINDOWS_RUNTIME_POLICY
} from "./windows-runtime.ts";
import { WINDOWS_BUILD_MACHINE_POLICY } from "./windows-build-machine-policy.ts";

const CHATMAIL_CORE_REPO = WINDOWS_BUILD_MACHINE_POLICY.deltaChat.repository;
const CHATMAIL_CORE_REVISION = WINDOWS_BUILD_MACHINE_POLICY.deltaChat.revision;
const EXPECTED_VERSION = WINDOWS_BUILD_MACHINE_POLICY.deltaChat.version;
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const toolsRoot = join(repoRoot, ".tools");
const coreCheckoutPath = resolveCoreCheckoutPath();

const command = process.argv[2];

try {
  switch (command) {
    case "path":
      console.log(repoLocalRpcServerPath());
      break;
    case "install":
      await installCommand();
      break;
    case "verify":
      await verifyCommand(process.argv.slice(3));
      break;
    default:
      usage();
      process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function installCommand(): Promise<void> {
  assertSupportedHost();
  await mkdir(toolsRoot, { recursive: true });

  if (!(await exists(join(coreCheckoutPath, ".git")))) {
    await rm(coreCheckoutPath, { recursive: true, force: true });
    await mkdir(coreCheckoutPath, { recursive: true });
    await run("git", ["init"], { cwd: coreCheckoutPath });
    await run("git", ["remote", "add", "origin", CHATMAIL_CORE_REPO], { cwd: coreCheckoutPath });
  }

  await run("git", ["remote", "set-url", "origin", CHATMAIL_CORE_REPO], { cwd: coreCheckoutPath });
  await run("git", ["config", "core.autocrlf", "false"], { cwd: coreCheckoutPath });
  await run("git", ["config", "core.eol", "lf"], { cwd: coreCheckoutPath });
  const pinnedCommitAvailable = await commandSucceeds(
    "git",
    ["cat-file", "-e", `${CHATMAIL_CORE_REVISION}^{commit}`],
    { cwd: coreCheckoutPath }
  );
  if (!pinnedCommitAvailable) {
    await runWithRetries("git", [
      "-c", "http.version=HTTP/1.1",
      "fetch", "--depth=1", "--filter=blob:none", "--no-tags", "origin", CHATMAIL_CORE_REVISION
    ], { cwd: coreCheckoutPath });
  }
  await run("git", ["checkout", "--detach", "--force", CHATMAIL_CORE_REVISION], { cwd: coreCheckoutPath });
  await run("git", ["clean", "-ffdqx"], { cwd: coreCheckoutPath });
  await run("git", ["checkout-index", "--all", "--force"], { cwd: coreCheckoutPath });
  await assertPinnedCargoLock();
  await run("cargo", [
    `+${WINDOWS_BUILD_MACHINE_POLICY.rust.version}`,
    "build",
    "--locked",
    "--release",
    "-p",
    WINDOWS_BUILD_MACHINE_POLICY.deltaChat.cargoPackage,
    "--features",
    WINDOWS_BUILD_MACHINE_POLICY.deltaChat.cargoFeatures.join(",")
  ], {
    cwd: coreCheckoutPath
  });

  const executable = process.platform === "win32"
    ? "deltachat-rpc-server.exe"
    : "deltachat-rpc-server";
  const source = join(coreCheckoutPath, "target", "release", executable);
  const destination = repoLocalRpcServerPath();
  if (process.platform === "win32") {
    await stagePinnedWindowsRpc(repoRoot, source, CHATMAIL_CORE_REVISION);
  } else {
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination);
    await chmod(destination, 0o755);
  }

  await verifyPath(destination);
}

async function verifyCommand(args: string[]): Promise<void> {
  const explicitPath = readPathArg(args);
  await verifyPath(explicitPath ?? process.env.TETI_DELTACHAT_RPC_PATH ?? repoLocalRpcServerPath());
}

async function verifyPath(path: string): Promise<void> {
  const report = await inspectChatmailRpcRuntime({
    rpcServerPath: path,
    accountsPath: join(toolsRoot, "rpc-verify-accounts")
  });

  const ok =
    report.errors.length === 0 &&
    report.executable &&
    report.version === EXPECTED_VERSION &&
    report.targetCompatible &&
    report.jsonRpcHealth &&
    report.cleanShutdown;

  console.log(
    JSON.stringify(
      {
        ok,
        expectedVersion: EXPECTED_VERSION,
        expectedTarget: REPO_LOCAL_RPC_TARGET,
        report
      },
      null,
      2
    )
  );

  if (!ok) {
    process.exitCode = 1;
  }
}

function assertSupportedHost(): void {
  const supported = (process.platform === "darwin" && process.arch === "arm64")
    || (process.platform === "win32" && process.arch === "x64");
  if (!supported) {
    throw new Error("desktop:rpc:install supports Apple Silicon macOS and Windows x64.");
  }
  if (process.platform === "win32"
    && WINDOWS_RUNTIME_POLICY.deltaChat.revision !== CHATMAIL_CORE_REVISION) {
    throw new Error("Windows Runtime and RPC installer revisions are inconsistent.");
  }
}

function resolveCoreCheckoutPath(): string {
  const configured = process.env.TETI_CHATMAIL_CORE_CHECKOUT?.trim();
  if (!configured) return join(toolsRoot, "chatmail-core");
  if (!isAbsolute(configured)) {
    throw new Error("TETI_CHATMAIL_CORE_CHECKOUT must be an absolute path.");
  }
  const resolved = resolve(configured);
  const managedBuildMachineCheckout = resolve(
    WINDOWS_BUILD_MACHINE_POLICY.installRoot,
    "sources",
    "chatmail-core"
  );
  if (process.platform !== "win32"
    || resolved.toLowerCase() !== managedBuildMachineCheckout.toLowerCase()) {
    throw new Error(
      `TETI_CHATMAIL_CORE_CHECKOUT must be the managed build-machine checkout: ${managedBuildMachineCheckout}`
    );
  }
  return resolved;
}

async function assertPinnedCargoLock(): Promise<void> {
  const path = join(coreCheckoutPath, "Cargo.lock");
  const source = await readFile(path, "utf8");
  if (/\r(?!\n)/.test(source)) {
    throw new Error("DeltaChat Cargo.lock contains unsupported lone CR line endings.");
  }
  const actual = createHash("sha256").update(source.replaceAll("\r\n", "\n"), "utf8").digest("hex");
  if (actual !== WINDOWS_BUILD_MACHINE_POLICY.deltaChat.cargoLockSha256) {
    throw new Error("DeltaChat Cargo.lock does not match the pinned build-machine policy.");
  }
}

function readPathArg(args: string[]): string | undefined {
  const index = args.indexOf("--path");
  return index >= 0 ? args[index + 1] : undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function run(commandName: string, args: string[], options: { cwd?: string } = {}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(commandName, args, {
      cwd: options.cwd ?? repoRoot,
      env: {
        ...process.env,
        CARGO_INCREMENTAL: "0",
        SOURCE_DATE_EPOCH: String(WINDOWS_BUILD_MACHINE_POLICY.deltaChat.sourceDateEpoch)
      },
      stdio: "inherit"
    });
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${commandName} ${args.join(" ")} exited with code ${code ?? "null"}.`));
      }
    });
    child.once("error", reject);
  });
}

async function runWithRetries(
  commandName: string,
  args: string[],
  options: { cwd?: string } = {},
  attempts = 3
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await run(commandName, args, options);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      const delayMs = attempt * 2_000;
      console.warn(`${commandName} network operation failed; retrying in ${delayMs}ms (${attempt}/${attempts}).`);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
    }
  }
  throw lastError;
}

async function commandSucceeds(
  commandName: string,
  args: string[],
  options: { cwd?: string } = {}
): Promise<boolean> {
  return await new Promise<boolean>((resolvePromise) => {
    const child = spawn(commandName, args, {
      cwd: options.cwd ?? repoRoot,
      env: process.env,
      stdio: "ignore",
      windowsHide: true
    });
    child.once("error", () => resolvePromise(false));
    child.once("exit", (code) => resolvePromise(code === 0));
  });
}

function usage(): void {
  console.error("Usage: node --experimental-strip-types scripts/rpc.ts <path|install|verify> [--path /path/to/deltachat-rpc-server]");
}
