import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { repoLocalRpcServerPath } from "../../../integrations/chatmail/runtime-config.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function main(): Promise<void> {
  assertAppleSilicon();
  await run("sw_vers", []);
  await run("xcode-select", ["-p"]);
  await run("node", ["--version"]);
  await run("npm", ["--version"]);
  await run("rustc", ["--version"]);
  await run("cargo", ["--version"]);

  if (!existsSync(repoLocalRpcServerPath())) {
    console.log("Repository-local deltachat-rpc-server is missing; installing from pinned chatmail/core revision.");
    await run("npm", ["run", "desktop:rpc:install"]);
  }

  await run("npm", ["run", "desktop:rpc:verify"]);
  await run("npm", ["run", "desktop:typecheck"]);
  await run("npm", ["run", "desktop:test"]);
  await run("cargo", ["fmt", "--manifest-path", "apps/desktop/src-tauri/Cargo.toml", "--", "--check"]);
  await run("cargo", ["check", "--manifest-path", "apps/desktop/src-tauri/Cargo.toml"]);
  await run("cargo", ["test", "--manifest-path", "apps/desktop/src-tauri/Cargo.toml"]);
  await run("npm", ["run", "desktop:tauri-build"]);

  console.log(
    [
      "",
      "Bootstrap completed without creating a real account.",
      "",
      "Next non-destructive preflight:",
      "TETI_PROFILE_DIR=/private/tmp/teti-mail-seep-real-alpha-02 \\",
      `TETI_DELTACHAT_RPC_PATH=${repoLocalRpcServerPath()} \\`,
      "TETI_CHATMAIL_RELAY_DOMAIN=mail.seep.im \\",
      "TETI_PROVISIONING_MODE=real \\",
      "TETI_ALLOW_REAL_PROVISIONING=1 \\",
      "npm run desktop:profile:preflight -- --path /private/tmp/teti-mail-seep-real-alpha-02",
      "",
      "Real UI launch, after explicit approval:",
      "TETI_PROFILE_DIR=/private/tmp/teti-mail-seep-real-alpha-02 \\",
      `TETI_DELTACHAT_RPC_PATH=${repoLocalRpcServerPath()} \\`,
      "TETI_CHATMAIL_RELAY_DOMAIN=mail.seep.im \\",
      "npm run desktop:real-validation"
    ].join("\n")
  );
}

function assertAppleSilicon(): void {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("desktop:bootstrap:mac currently supports Apple Silicon macOS only.");
  }
}

async function run(commandName: string, args: string[]): Promise<void> {
  console.log(`$ ${[commandName, ...args].join(" ")}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(commandName, args, {
      cwd: repoRoot,
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
