import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertWindowsX64Host,
  resolveWindowsSigningConfiguration
} from "./windows-authenticode.ts";
import { writeWindowsReleaseManifest } from "./windows-release.ts";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const command = process.argv[2] ?? "build";
if (!new Set(["build", "inventory"]).has(command)) {
  throw new Error("Usage: windows-release-cli.ts <build|inventory>");
}

assertWindowsX64Host();
const signing = resolveWindowsSigningConfiguration();
const signTool = await stat(signing.signToolPath).catch(() => undefined);
if (!signTool?.isFile()) throw new Error("Configured signtool.exe does not exist.");
const generatedAt = resolveReleaseTimestamp();

if (command === "build") {
  const tauri = join(desktopRoot, "node_modules", "@tauri-apps", "cli", "tauri.js");
  await run(process.execPath, [tauri, "build", "--bundles", "nsis"], {
    ...process.env,
    TETI_BUILD_TYPE: "release",
    TETI_BUILD_TIMESTAMP: generatedAt,
    TETI_WINDOWS_SIGNING_MODE: "release"
  });
}

const output = await writeWindowsReleaseManifest(desktopRoot, repoRoot, generatedAt);
console.log(`Verified ${output.manifest.artifacts.length} signed PE artifacts.`);
console.log(`Release manifest: ${output.manifestPath}`);
console.log(`SHA-256 inventory: ${output.checksumsPath}`);

function resolveReleaseTimestamp(): string {
  const input = process.env.TETI_BUILD_TIMESTAMP ?? new Date().toISOString();
  const date = new Date(input);
  if (!Number.isFinite(date.valueOf())) throw new Error("TETI_BUILD_TIMESTAMP must be an ISO date.");
  return date.toISOString();
}

async function run(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(file, args, { cwd: desktopRoot, env, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Windows release build failed (${signal ?? code ?? "unknown"}).`));
    });
  });
}
