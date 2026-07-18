import { createInterface } from "node:readline";
import { stdin, stdout, stderr } from "node:process";
import {
  LIFECYCLE_PROTOCOL_VERSION,
  type LifecycleResponse
} from "../src/lifecycle-bridge/protocol.ts";
import { handleLifecycleLine } from "./handler.ts";
import { createLifecycleError, redactSecretLikeText } from "./security.ts";
import { getDefaultCodexUsageService } from "./codex-usage/runtime.ts";

const inFlightRequestIds = new Set<string>();
const pendingRequests = new Set<Promise<void>>();
let inputClosed = false;
const codexUsageService = getDefaultCodexUsageService();
codexUsageService.start();

const reader = createInterface({
  input: stdin,
  crlfDelay: Infinity,
  terminal: false
});

reader.on("line", (line) => {
  const pending = handleLine(line);
  pendingRequests.add(pending);
  pending.finally(() => {
    pendingRequests.delete(pending);
    exitWhenDrained();
  });
});

reader.on("close", () => {
  inputClosed = true;
  codexUsageService.stop();
  exitWhenDrained();
});

process.on("uncaughtException", (error) => {
  stderr.write(`teti-lifecycle-sidecar uncaught: ${redactSecretLikeText(error.message)}\n`);
});

process.on("unhandledRejection", (reason) => {
  stderr.write(`teti-lifecycle-sidecar unhandled: ${redactSecretLikeText(String(reason))}\n`);
});

async function handleLine(line: string): Promise<void> {
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
    writeResponse(await handleLifecycleLine(line));
  } finally {
    if (id) {
      inFlightRequestIds.delete(id);
    }
  }
}

function writeResponse(response: LifecycleResponse): void {
  stdout.write(`${JSON.stringify(response)}\n`);
}

function readLineId(line: string): string | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    return typeof parsed.id === "string" ? parsed.id : null;
  } catch {
    return null;
  }
}

function exitWhenDrained(): void {
  if (inputClosed && pendingRequests.size === 0) {
    process.exit(0);
  }
}
