import { chmod, copyFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { resolveTetiBuildType } from "./build-flavor.ts";
import {
  copyAllowlistedWindowsDlls,
  resolveWindowsRuntimePaths,
  verifyWindowsRuntime
} from "./windows-runtime.ts";
import {
  isWindowsReleaseSigningEnabled,
  signWindowsPeFile
} from "./windows-authenticode.ts";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const resourcesRoot = join(desktopRoot, "src-tauri", "resources");
const sidecarOutput = join(resourcesRoot, "lifecycle-sidecar", "main.mjs");
const codexImageRunnerOutput = join(resourcesRoot, "lifecycle-sidecar", "codex-image-runner.mjs");
const runtimeRoot = join(resourcesRoot, "runtime");
const packageVersion = await readPackageVersion();
const buildTimestamp = resolveBuildTimestamp();
const buildType = resolveTetiBuildType();
const buildDefines = {
  __TETI_APP_VERSION__: JSON.stringify(packageVersion),
  __TETI_BUILD_TIMESTAMP__: JSON.stringify(buildTimestamp),
  __TETI_BUILD_TYPE__: JSON.stringify(buildType)
};
const runtimeSource = await resolveRuntimeSource();

await rm(resourcesRoot, { recursive: true, force: true });
await mkdir(dirname(sidecarOutput), { recursive: true });
await mkdir(runtimeRoot, { recursive: true });

await build({
  entryPoints: [join(desktopRoot, "lifecycle-sidecar", "main.ts")],
  outfile: sidecarOutput,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  define: buildDefines,
  sourcemap: false,
  logLevel: "warning"
});

await build({
  entryPoints: [join(
    desktopRoot,
    "lifecycle-sidecar",
    "runtime",
    "callable",
    "codex-image-runner.ts"
  )],
  outfile: codexImageRunnerOutput,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  define: buildDefines,
  sourcemap: false,
  logLevel: "warning"
});

await copyExecutable(runtimeSource.node, join(runtimeRoot, runtimeSource.nodeFileName));
await copyExecutable(runtimeSource.rpc, join(runtimeRoot, runtimeSource.rpcFileName));
if (process.platform === "win32") {
  await copyAllowlistedWindowsDlls(repoRoot, runtimeRoot);
  if (isWindowsReleaseSigningEnabled()) {
    const peArtifacts = (await readdir(runtimeRoot))
      .filter((name) => /\.(?:exe|dll)$/i.test(name))
      .sort((left, right) => left.localeCompare(right));
    for (const artifact of peArtifacts) await signWindowsPeFile(join(runtimeRoot, artifact));
  }
}

console.log(`Bundled Teti ${runtimeSource.target} lifecycle Runtime in ${resourcesRoot}`);

async function copyExecutable(source: string, destination: string): Promise<void> {
  await copyFile(source, destination);
  if (process.platform !== "win32") await chmod(destination, 0o755);
}

async function resolveRuntimeSource(): Promise<{
  target: "macos-arm64" | "windows-x64";
  node: string;
  nodeFileName: string;
  rpc: string;
  rpcFileName: string;
}> {
  if (process.platform === "darwin" && process.arch === "arm64") {
    const rpc = join(
      repoRoot,
      ".tools",
      "deltachat-rpc-server",
      "aarch64-apple-darwin",
      "deltachat-rpc-server"
    );
    await stat(rpc).catch(() => {
      throw new Error("Repository-local deltachat-rpc-server is missing. Run npm run desktop:rpc:install first.");
    });
    return {
      target: "macos-arm64",
      node: process.execPath,
      nodeFileName: "node",
      rpc,
      rpcFileName: "deltachat-rpc-server"
    };
  }

  if (process.platform === "win32" && process.arch === "x64") {
    const verification = await verifyWindowsRuntime(repoRoot);
    if (!verification.ok) {
      throw new Error(`Windows Runtime verification failed:\n${verification.errors.join("\n")}`);
    }
    const paths = resolveWindowsRuntimePaths(repoRoot);
    return {
      target: "windows-x64",
      node: paths.node,
      nodeFileName: "node.exe",
      rpc: paths.rpc,
      rpcFileName: "deltachat-rpc-server.exe"
    };
  }

  throw new Error("Teti Desktop Runtime bundling supports Apple Silicon macOS and Windows x64.");
}

async function readPackageVersion(): Promise<string> {
  const value = JSON.parse(await readFile(join(desktopRoot, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (typeof value.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.version)) {
    throw new Error("Desktop package version must use semantic versioning.");
  }
  return value.version;
}

function resolveBuildTimestamp(): string {
  const input = process.env.TETI_BUILD_TIMESTAMP ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(input))) throw new Error("TETI_BUILD_TIMESTAMP must be an ISO timestamp.");
  return new Date(input).toISOString();
}
