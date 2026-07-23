import { createInterface } from "node:readline";
import { stdin, stdout, stderr } from "node:process";
import {
  LIFECYCLE_PROTOCOL_VERSION,
  type LifecycleResponse
} from "../src/lifecycle-bridge/protocol.ts";
import {
  defaultLifecycleSidecarDependencies,
  handleLifecycleLine,
  type LifecycleSidecarDependencies
} from "./handler.ts";
import { createLifecycleError, redactSecretLikeText } from "./security.ts";
import { getDefaultCodexUsageService } from "./codex-usage/runtime.ts";
import { TetiRuntime } from "./runtime/service.ts";
import { createRuntimeOwnedLifecycleDependencies } from "./runtime/lifecycle-adapter.ts";
import { SafeProcessWriter } from "./runtime/safe-output.ts";
import {
  acquireTetiRuntimeProfileLock,
  type TetiRuntimeProfileLock
} from "./runtime/profile-lock.ts";
import { ensureProfileDirectories, resolveTetiProfile } from "./profile.ts";
import {
  closeDefaultPeerConnectionService,
  getDefaultPassportSharingStore
} from "./connections.ts";
import { writeRuntimeDiagnostic } from "./diagnostics.ts";

const PROCESS_SHUTDOWN_HARD_LIMIT_MS = 4_000;
const inFlightRequestIds = new Set<string>();
let runtime: TetiRuntime | undefined;
let lifecycleDependencies: LifecycleSidecarDependencies | undefined;
let profileLock: TetiRuntimeProfileLock | undefined;
let shutdownPromise: Promise<void> | undefined;
const safeStdout = new SafeProcessWriter(stdout, () => { void beginShutdown(0); });
const safeStderr = new SafeProcessWriter(stderr, () => { void beginShutdown(0); });

process.on("uncaughtException", (error) => {
  safeStderr.write(`teti-lifecycle-sidecar uncaught: ${redactSecretLikeText(error.message)}\n`);
  void beginShutdown(1);
});

process.on("unhandledRejection", (reason) => {
  safeStderr.write(`teti-lifecycle-sidecar unhandled: ${redactSecretLikeText(String(reason))}\n`);
  void beginShutdown(1);
});

process.once("SIGTERM", () => { void beginShutdown(0); });
process.once("SIGINT", () => { void beginShutdown(0); });

try {
  await startSidecar();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  safeStderr.write(`teti-lifecycle-sidecar startup failed: ${redactSecretLikeText(message)}\n`);
  await beginShutdown(1);
}

async function startSidecar(): Promise<void> {
  const profile = await resolveTetiProfile();
  await ensureProfileDirectories(profile);
  profileLock = await acquireTetiRuntimeProfileLock(profile);
  const codexUsageService = getDefaultCodexUsageService();
  runtime = new TetiRuntime({
    dependencies: {
      loadTetiAccount: defaultLifecycleSidecarDependencies.loadTetiAccount,
      heartbeatDiscovery: defaultLifecycleSidecarDependencies.heartbeatDiscovery,
      getPeerConnectionService: defaultLifecycleSidecarDependencies.getPeerConnectionService,
      passportSharingStore: await getDefaultPassportSharingStore(),
      codexUsageService,
      dispose: closeDefaultPeerConnectionService
    },
    onJobError: ({ jobId, error }) => {
      const message = error instanceof Error ? error.message : String(error);
      writeRuntimeDiagnostic("runtime.job", {
        job: jobId,
        result: "failed",
        code: readErrorCode(error),
        message: redactSecretLikeText(message)
      });
    },
    onRegistryStatusChange: ({ status, attempt, nextRetryMs }) => {
      writeRuntimeDiagnostic("registry.sync", {
        state: status.state,
        code: status.errorCode,
        retryable: status.retryable,
        attempt,
        nextRetryMs
      });
    }
  });
  lifecycleDependencies = createRuntimeOwnedLifecycleDependencies(
    defaultLifecycleSidecarDependencies,
    runtime
  );
  runtime.start();

  const reader = createInterface({
    input: stdin,
    crlfDelay: Infinity,
    terminal: false
  });
  reader.on("line", (line) => { void handleLine(line); });
  reader.once("close", () => { void beginShutdown(0); });
}

function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

async function handleLine(line: string): Promise<void> {
  if (!lifecycleDependencies || shutdownPromise) return;
  const id = readLineId(line);
  if (id && inFlightRequestIds.has(id)) {
    writeResponse({
      version: LIFECYCLE_PROTOCOL_VERSION,
      id,
      ok: false,
      error: createLifecycleError("DUPLICATE_REQUEST", "Lifecycle request id is already in flight.", {
        recoverable: false
      })
    });
    return;
  }

  if (id) {
    inFlightRequestIds.add(id);
  }

  try {
    writeResponse(await handleLifecycleLine(line, lifecycleDependencies));
  } finally {
    if (id) {
      inFlightRequestIds.delete(id);
    }
  }
}

function writeResponse(response: LifecycleResponse): void {
  if (!safeStdout.write(`${JSON.stringify(response)}\n`)) {
    void beginShutdown(0);
  }
}

function readLineId(line: string): string | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    return typeof parsed.id === "string" ? parsed.id : null;
  } catch {
    return null;
  }
}

function beginShutdown(exitCode: number): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    const hardExit = setTimeout(() => process.exit(exitCode), PROCESS_SHUTDOWN_HARD_LIMIT_MS);
    const result = await runtime?.stop();
    if (result?.timedOut) {
      safeStderr.write("teti-runtime shutdown reached its bounded timeout.\n");
    }
    await profileLock?.release().catch(() => undefined);
    clearTimeout(hardExit);
    process.exit(exitCode);
  })();
  return shutdownPromise;
}
