import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isWindowsReleaseSigningEnabled } from "./windows-authenticode.ts";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tauriCli = join(desktopRoot, "node_modules", "@tauri-apps", "cli", "tauri.js");
const signCommand = join(desktopRoot, "scripts", "windows-sign-command.ts");
const requestedArgs = process.argv.slice(2);
const releaseFlavor = requestedArgs.includes("--release-flavor");
const tauriArgs = requestedArgs.filter((argument) => argument !== "--release-flavor");
const env: NodeJS.ProcessEnv = {
  ...process.env,
  ...(releaseFlavor ? { TETI_BUILD_TYPE: "release" } : {})
};

if (process.platform === "win32") {
  if (isWindowsReleaseSigningEnabled(env)) {
    // CLI config extensions are merged after the platform overlay. Keeping
    // the command paths absolute makes both the application and generated
    // NSIS uninstaller independent of the bundler's temporary working dir.
    tauriArgs.push("--config", JSON.stringify(absoluteWindowsSignCommand()));
  } else {
    tauriArgs.push("--no-sign");
  }
}

await run(process.execPath, [tauriCli, "build", ...tauriArgs], env);

function absoluteWindowsSignCommand(): Record<string, unknown> {
  return {
    bundle: {
      windows: {
        signCommand: {
          cmd: process.execPath,
          args: ["--experimental-strip-types", signCommand, "%1"]
        }
      }
    }
  };
}

async function run(file: string, args: string[], childEnv: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(file, args, {
      cwd: desktopRoot,
      env: childEnv,
      stdio: "inherit",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Tauri build failed (${signal ?? code ?? "unknown"}).`));
    });
  });
}
