import { spawn } from "node:child_process";
import { chmod, cp, mkdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { repoLocalRpcServerPath, REPO_LOCAL_RPC_TARGET } from "../../../integrations/chatmail/runtime-config.ts";
import { inspectChatmailRpcRuntime } from "../../../integrations/chatmail/runtime-diagnostics.ts";
import {
  stagePinnedWindowsRpc,
  WINDOWS_RUNTIME_POLICY
} from "./windows-runtime.ts";

const CHATMAIL_CORE_REPO = "https://github.com/chatmail/core";
const CHATMAIL_CORE_REVISION = "823b0741df82e3ec0f61285d52bf91ae19b1963e";
const EXPECTED_VERSION = "2.54.0-dev";
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const toolsRoot = join(repoRoot, ".tools");
const coreCheckoutPath = join(toolsRoot, "chatmail-core");

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

  if (!(await exists(coreCheckoutPath))) {
    await run("git", ["clone", CHATMAIL_CORE_REPO, coreCheckoutPath]);
  }

  await run("git", ["fetch", "origin", CHATMAIL_CORE_REVISION], { cwd: coreCheckoutPath });
  await run("git", ["checkout", "--detach", CHATMAIL_CORE_REVISION], { cwd: coreCheckoutPath });
  await run("cargo", ["build", "--release", "-p", "deltachat-rpc-server", "--features", "vendored"], {
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

function usage(): void {
  console.error("Usage: node --experimental-strip-types scripts/rpc.ts <path|install|verify> [--path /path/to/deltachat-rpc-server]");
}
