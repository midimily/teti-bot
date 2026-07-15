import { chmod, copyFile, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const resourcesRoot = join(desktopRoot, "src-tauri", "resources");
const sidecarOutput = join(resourcesRoot, "lifecycle-sidecar", "main.mjs");
const runtimeRoot = join(resourcesRoot, "runtime");
const rpcSource = join(
  repoRoot,
  ".tools",
  "deltachat-rpc-server",
  "aarch64-apple-darwin",
  "deltachat-rpc-server"
);

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("Teti Desktop runtime bundling currently requires Apple Silicon macOS.");
}
await stat(rpcSource).catch(() => {
  throw new Error("Repository-local deltachat-rpc-server is missing. Run npm run desktop:rpc:install first.");
});

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
  sourcemap: false,
  logLevel: "warning"
});

await copyExecutable(process.execPath, join(runtimeRoot, "node"));
await copyExecutable(rpcSource, join(runtimeRoot, "deltachat-rpc-server"));

console.log(`Bundled Teti lifecycle runtime in ${resourcesRoot}`);

async function copyExecutable(source: string, destination: string): Promise<void> {
  await copyFile(source, destination);
  await chmod(destination, 0o755);
}
