import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { constants } from "node:fs";

const manifestPath = "apps/desktop/src-tauri/Cargo.toml";
const windowsTarget = "x86_64-pc-windows-msvc";

if (process.platform === "win32") {
  if (process.arch !== "x64") throw new Error("Teti 0.4.1 supports Windows x64 only.");
  await run("npm", ["--prefix", "apps/desktop", "exec", "tauri", "build", "--", "--debug", "--no-bundle"]);
} else if (process.platform === "darwin") {
  const llvmRc = process.env.TETI_WINDOWS_LLVM_RC
    ?? "/opt/homebrew/opt/llvm/bin/llvm-rc";
  await access(llvmRc, constants.X_OK).catch(() => {
    throw new Error(
      `Windows cross-check requires llvm-rc at ${llvmRc}. Install Homebrew LLVM or set TETI_WINDOWS_LLVM_RC.`
    );
  });
  const crossCheckOverrides = {
    TAURI_CONFIG: JSON.stringify({
      app: {
        macOSPrivateApi: true
      },
      bundle: {
        // Cross-checking Rust on macOS must not require Windows PE
        // artifacts. A real Windows build keeps the target config's
        // verified Runtime resources.
        resources: []
      }
    })
  };
  await run(
    "cargo",
    ["check", "--manifest-path", manifestPath, "--target", windowsTarget, "--all-targets"],
    { RC_x86_64_pc_windows_msvc: llvmRc, ...crossCheckOverrides }
  );
} else {
  throw new Error("Run the Windows shell check on macOS or Windows x64.");
}

console.log(`Teti Windows Rust shell check passed for ${windowsTarget}.`);

async function run(
  command: string,
  args: string[],
  additionalEnv: Record<string, string> = {}
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: new URL("../../..", import.meta.url),
      env: { ...process.env, ...additionalEnv },
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Windows shell check failed (${signal ?? code ?? "unknown"}).`));
    });
  });
}
