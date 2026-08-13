import { spawn } from "node:child_process";
import { resolveTetiBuildType } from "./build-flavor.ts";

const requestedTimestamp = process.env.TETI_BUILD_TIMESTAMP ?? new Date().toISOString();
if (!Number.isFinite(Date.parse(requestedTimestamp))) {
  throw new Error("TETI_BUILD_TIMESTAMP must be an ISO timestamp.");
}
const buildTimestamp = new Date(requestedTimestamp).toISOString();
const buildType = resolveTetiBuildType();
const env = { ...process.env, TETI_BUILD_TIMESTAMP: buildTimestamp, TETI_BUILD_TYPE: buildType };

await runNpm(["run", "runtime:bundle"]);
await runNpm(["exec", "vite", "build"]);

console.log(`Built Teti Desktop ${buildType} flavor with timestamp ${buildTimestamp}`);

async function runNpm(args: string[]): Promise<void> {
  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath ? process.execPath : "npm";
  const commandArgs = npmExecPath ? [npmExecPath, ...args] : args;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, commandArgs, { env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Build command failed (${signal ?? code ?? "unknown"}).`));
    });
  });
}
