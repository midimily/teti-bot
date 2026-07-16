import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appPath = join(desktopRoot, "src-tauri", "target", "release", "bundle", "macos", "Teti.app");

if (process.platform !== "darwin") {
  console.log("Skipping macOS app signing on a non-macOS host.");
  process.exit(0);
}

await stat(appPath);
const nestedExecutables = [
  join(appPath, "Contents", "Resources", "runtime", "node"),
  join(appPath, "Contents", "Resources", "runtime", "deltachat-rpc-server"),
  join(appPath, "Contents", "MacOS", "teti-desktop")
];

for (const executable of nestedExecutables) {
  await execFileAsync("codesign", ["--force", "--sign", "-", "--timestamp=none", executable]);
}
await execFileAsync("codesign", ["--force", "--sign", "-", "--timestamp=none", appPath]);
await execFileAsync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);

console.log(`Ad-hoc signed and verified ${appPath}`);
