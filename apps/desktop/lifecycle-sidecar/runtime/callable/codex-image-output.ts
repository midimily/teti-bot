import { isAbsolute, join } from "node:path";
import { FileTaskAttachmentStore } from "../tasks/attachments.ts";

export type CodexImageOutputFailureCode =
  | "CODEX_IMAGE_RESULT_MISSING"
  | "CODEX_IMAGE_RESULT_NOT_READY"
  | "CODEX_IMAGE_RESULT_INVALID";

export class CodexImageOutputError extends Error {
  readonly code: CodexImageOutputFailureCode;

  constructor(code: CodexImageOutputFailureCode) {
    super(code);
    this.name = "CodexImageOutputError";
    this.code = code;
  }
}

export interface PersistCodexGeneratedImagesInput {
  workspacePath: string;
  savedPaths: readonly string[];
  maximumAttempts?: number;
  retryDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

const DEFAULT_MAXIMUM_ATTEMPTS = 40;
const DEFAULT_RETRY_DELAY_MS = 250;
const MAXIMUM_IMAGE_RESULTS = 4;

/**
 * A Codex image notification is only a pointer to a candidate file. The file
 * can still be settling when the notification arrives, so Teti repeatedly
 * reads, sanitizes, and atomically writes it into the task workspace. Only the
 * private verified copy is eligible for the Kernel Artifact contract.
 */
export async function persistCodexGeneratedImages(
  input: PersistCodexGeneratedImagesInput
): Promise<Array<{ path: string }>> {
  const savedPaths = [...new Set(input.savedPaths)]
    .filter((path) => typeof path === "string" && isAbsolute(path) && !path.includes("\0"))
    .slice(0, MAXIMUM_IMAGE_RESULTS);
  if (savedPaths.length === 0) {
    throw new CodexImageOutputError("CODEX_IMAGE_RESULT_MISSING");
  }
  const maximumAttempts = boundedInteger(
    input.maximumAttempts ?? DEFAULT_MAXIMUM_ATTEMPTS,
    1,
    120
  );
  const retryDelayMs = boundedInteger(
    input.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
    0,
    1_000
  );
  const sleep = input.sleep ?? delay;
  const store = new FileTaskAttachmentStore(join(input.workspacePath, ".teti-image-output"));
  const persisted: Array<{ path: string }> = [];
  let lastError: unknown;

  for (const [index, sourcePath] of savedPaths.entries()) {
    try {
      const image = await persistOne({
        store,
        taskId: `codex-image-${index + 1}`,
        sourcePath,
        maximumAttempts,
        retryDelayMs,
        sleep
      });
      persisted.push({ path: image.path });
    } catch (error) {
      lastError = error;
    }
  }

  if (persisted.length > 0) return persisted;
  throw new CodexImageOutputError(classifySettlingFailure(lastError));
}

async function persistOne(input: {
  store: FileTaskAttachmentStore;
  taskId: string;
  sourcePath: string;
  maximumAttempts: number;
  retryDelayMs: number;
  sleep(milliseconds: number): Promise<void>;
}) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= input.maximumAttempts; attempt += 1) {
    try {
      return await input.store.ingestGeneratedImage(input.taskId, input.sourcePath);
    } catch (error) {
      lastError = error;
      if (attempt < input.maximumAttempts) await input.sleep(input.retryDelayMs);
    }
  }
  throw lastError;
}

function classifySettlingFailure(error: unknown): CodexImageOutputFailureCode {
  const message = error instanceof Error ? error.message : "";
  return message === "TASK_IMAGE_INVALID" || message === "TASK_IMAGE_TYPE_UNSUPPORTED"
    ? "CODEX_IMAGE_RESULT_INVALID"
    : "CODEX_IMAGE_RESULT_NOT_READY";
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new CodexImageOutputError("CODEX_IMAGE_RESULT_INVALID");
  }
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
