import { join } from "node:path";
import { inspectChatmailRelay } from "../../../integrations/chatmail/relay-diagnostics.ts";
import { inspectChatmailRpcRuntime } from "../../../integrations/chatmail/runtime-diagnostics.ts";
import { validateRealValidationRelayConfig } from "../../../integrations/chatmail/relay-config.ts";
import {
  cleanValidationProfile,
  createValidationProfile,
  ensureProfileDirectories,
  resolveTetiProfile,
  TETI_ALLOW_REAL_PROVISIONING,
  TETI_PROFILE_DIR,
  TETI_PROVISIONING_MODE,
  validateRealProvisioningProfile,
  writeProfileStatus
} from "../lifecycle-sidecar/profile.ts";
import { readCreationMarker } from "../lifecycle-sidecar/marker.ts";
import { handleLifecycleRequest } from "../lifecycle-sidecar/handler.ts";

const command = process.argv[2];
const args = parseArgs(process.argv.slice(3));

try {
  switch (command) {
    case "create":
      await createCommand(args);
      break;
    case "status":
      await statusCommand(args);
      break;
    case "preflight":
      await preflightCommand(args);
      break;
    case "clean":
      await cleanCommand(args);
      break;
    default:
      usage();
      process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function createCommand(args: Record<string, string | boolean>): Promise<void> {
  const path = stringArg(args, "path") ?? defaultProfilePath(String(args.name ?? "alpha-01"));
  const profile = await createValidationProfile(path);
  console.log(JSON.stringify(await writeProfileStatus(profile), null, 2));
}

async function statusCommand(args: Record<string, string | boolean>): Promise<void> {
  const profile = await profileFromArgs(args);
  console.log(JSON.stringify(await writeProfileStatus(profile), null, 2));
}

async function preflightCommand(args: Record<string, string | boolean>): Promise<void> {
  const profile = await profileFromArgs(args);
  await ensureProfileDirectories(profile);
  const report = await validateRealProvisioningProfile(process.env);
  const health = await handleLifecycleRequest({
    version: 1,
    id: "preflight-health",
    method: "lifecycle.health",
    params: {}
  });
  const status = await handleLifecycleRequest({
    version: 1,
    id: "preflight-status",
    method: "account.status",
    params: {}
  });
  const marker = await readCreationMarker(profile);
  const rpc = await inspectChatmailRpcRuntime({
    accountsPath: profile.chatmailAccountsPath
  });
  const relay = validateRealValidationRelayConfig(process.env);
  const relayNetwork = await inspectChatmailRelay(relay.config);
  const activeMarker = marker?.stage === "provisioning";
  const accountMissing = lifecycleStatusIsMissing(status);

  const result = {
    ok:
      report.ok &&
      health.ok &&
      status.ok &&
      accountMissing &&
      rpc.errors.length === 0 &&
      relay.ok &&
      relayNetwork.errors.length === 0 &&
      !activeMarker,
    profile: await writeProfileStatus(profile),
    guards: {
      realMode: process.env[TETI_PROVISIONING_MODE] === "real",
      allowRealProvisioning: process.env[TETI_ALLOW_REAL_PROVISIONING] === "1",
      profileProvided: Boolean(process.env[TETI_PROFILE_DIR]),
      profileIsValidationProfile: profile.isValidationProfile,
      accountMissing,
      noActiveProvisioningMarker: !activeMarker
    },
    lifecycleHealth: health,
    accountStatus: status,
    chatmailRuntime: {
      requestedPath: rpc.requestedPath,
      resolvedPath: rpc.resolvedPath,
      exists: rpc.exists,
      executable: rpc.executable,
      version: rpc.version,
      fileOutput: rpc.fileOutput,
      architecture: rpc.architecture,
      appleSiliconCompatible: rpc.appleSiliconCompatible,
      accountsPath: rpc.accountsPath,
      accountsPathWritable: rpc.accountsPathWritable,
      jsonRpcHealth: rpc.jsonRpcHealth,
      systemInfoKeys: rpc.systemInfoKeys,
      cleanShutdown: rpc.cleanShutdown,
      stderrLines: rpc.stderrLines.slice(0, 5)
    },
    relay,
    relayNetwork,
    marker,
    errors: [
      ...report.errors,
      ...(accountMissing
        ? []
        : [{ code: "ACCOUNT_ALREADY_EXISTS", message: "Validation profile already contains a Teti account.", recoverable: false }]),
      ...rpc.errors.map((message) => ({ code: "ACCOUNT_CREATE_FAILED", message, recoverable: false })),
      ...relayNetwork.errors.map((message) => ({ code: "ACCOUNT_CREATE_FAILED", message, recoverable: false }))
    ]
  };

  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exitCode = 1;
  }
}

async function cleanCommand(args: Record<string, string | boolean>): Promise<void> {
  const profile = await profileFromArgs(args);
  await cleanValidationProfile(profile);
  console.log(
    JSON.stringify(
      {
        ok: true,
        cleanedProfile: profile.root,
        localOnly: true,
        remoteChatmailDeleted: false,
        remoteDiscoveryDeleted: false
      },
      null,
      2
    )
  );
}

async function profileFromArgs(args: Record<string, string | boolean>) {
  const path = stringArg(args, "path");
  if (path) {
    process.env[TETI_PROFILE_DIR] = path;
  }
  return resolveTetiProfile(process.env);
}

function stringArg(args: Record<string, string | boolean>, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" ? value : undefined;
}

function defaultProfilePath(name: string): string {
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
  const normalized = safeName.startsWith("teti-real-provisioning-")
    ? safeName
    : `teti-real-provisioning-${safeName}`;
  return join("/private/tmp", normalized);
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      continue;
    }
    const key = item.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      parsed[key] = next;
      index += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function lifecycleStatusIsMissing(response: Awaited<ReturnType<typeof handleLifecycleRequest>>): boolean {
  if (!response.ok || !response.result || typeof response.result !== "object") {
    return false;
  }
  return (response.result as { exists?: unknown }).exists === false;
}

function usage(): void {
  console.error(
    "Usage: node --experimental-strip-types apps/desktop/scripts/profile.ts <create|status|preflight|clean> --path /private/tmp/teti-real-provisioning-alpha-01"
  );
}
