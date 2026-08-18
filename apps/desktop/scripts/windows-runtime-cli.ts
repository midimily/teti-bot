import { fileURLToPath } from "node:url";
import {
  installPinnedWindowsNode,
  stagePinnedWindowsRpc,
  verifyWindowsRuntime,
  WINDOWS_RUNTIME_POLICY
} from "./windows-runtime.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const command = process.argv[2];

try {
  if (command === "install-node") {
    const path = await installPinnedWindowsNode(repoRoot);
    console.log(`Installed pinned Windows Node ${WINDOWS_RUNTIME_POLICY.node.version} at ${path}`);
  } else if (command === "stage-rpc") {
    const source = readArgument("--path");
    const revision = readArgument("--revision");
    if (!source || !revision) throw new Error("stage-rpc requires --path and --revision.");
    const path = await stagePinnedWindowsRpc(repoRoot, source, revision);
    console.log(`Staged pinned Windows DeltaChat RPC at ${path}`);
  } else if (command === "verify") {
    const report = await verifyWindowsRuntime(repoRoot);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } else {
    throw new Error("Usage: windows-runtime-cli.ts <install-node|stage-rpc|verify> [--path FILE --revision SHA]");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function readArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
