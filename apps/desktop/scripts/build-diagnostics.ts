import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../../..", import.meta.url).pathname;
const desktopRoot = join(root, "apps", "desktop");
const rpcPath = join(root, ".tools", "chatmail-core", "target", "release", "deltachat-rpc-server");

const diagnostics = {
  host: command("sw_vers", []),
  xcode: command("xcodebuild", ["-version"]),
  sdkVersion: command("xcrun", ["--sdk", "macosx", "--show-sdk-version"]),
  deploymentTarget: process.env.MACOSX_DEPLOYMENT_TARGET ?? "15.0",
  architecture: process.arch,
  tauriVersion: command(join(desktopRoot, "node_modules", ".bin", "tauri"), ["--version"]),
  rustcVersion: command("rustc", ["--version"]),
  cargoVersion: command("cargo", ["--version"]),
  rpcVersion: existsSync(rpcPath) ? command(rpcPath, ["--version"]) : "not installed",
  rpcPath
};

console.log(JSON.stringify(diagnostics, null, 2));

function command(binary: string, args: string[]): string {
  const result = spawnSync(binary, args, {
    cwd: desktopRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      MACOSX_DEPLOYMENT_TARGET: process.env.MACOSX_DEPLOYMENT_TARGET ?? "15.0"
    }
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.error) {
    return output || `unavailable: ${result.error.message}`;
  }
  return output;
}
