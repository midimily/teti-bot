export const CODEX_IMAGE_RUNNER_DIAGNOSTIC_PREFIX = "teti-codex-image-runner:";

export const CODEX_IMAGE_RUNNER_STAGES = [
  "initialize",
  "thread/start",
  "turn/start",
  "image-result"
] as const;

export type CodexImageRunnerStage = typeof CODEX_IMAGE_RUNNER_STAGES[number];
export type CodexImageRunnerStageState = "started" | "completed" | "failed";

export interface CodexImageRunnerDiagnostic {
  schemaVersion: 1;
  stage: CodexImageRunnerStage;
  state: CodexImageRunnerStageState;
  elapsedMs: number;
  exitCode: number | null;
  failureCode?: string;
  stderrTail?: string;
}

export function encodeCodexImageRunnerDiagnostic(
  diagnostic: CodexImageRunnerDiagnostic
): string {
  return `${CODEX_IMAGE_RUNNER_DIAGNOSTIC_PREFIX}${JSON.stringify(diagnostic)}`;
}

export function parseCodexImageRunnerDiagnostic(
  line: string
): CodexImageRunnerDiagnostic | null {
  if (!line.startsWith(CODEX_IMAGE_RUNNER_DIAGNOSTIC_PREFIX)) return null;
  let value: unknown;
  try {
    value = JSON.parse(line.slice(CODEX_IMAGE_RUNNER_DIAGNOSTIC_PREFIX.length));
  } catch {
    return null;
  }
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || !CODEX_IMAGE_RUNNER_STAGES.includes(value.stage as CodexImageRunnerStage)
    || !["started", "completed", "failed"].includes(String(value.state))
    || !Number.isSafeInteger(value.elapsedMs)
    || Number(value.elapsedMs) < 0
    || (value.exitCode !== null && !Number.isSafeInteger(value.exitCode))
    || (value.failureCode !== undefined
      && (typeof value.failureCode !== "string"
        || !/^CODEX_IMAGE_[A-Z0-9_]{1,64}$/.test(value.failureCode)))
    || (value.stderrTail !== undefined
      && (typeof value.stderrTail !== "string" || value.stderrTail.length > 2_048))) {
    return null;
  }
  return {
    schemaVersion: 1,
    stage: value.stage as CodexImageRunnerStage,
    state: value.state as CodexImageRunnerStageState,
    elapsedMs: Number(value.elapsedMs),
    exitCode: value.exitCode as number | null,
    ...(typeof value.failureCode === "string" ? { failureCode: value.failureCode } : {}),
    ...(typeof value.stderrTail === "string" ? { stderrTail: value.stderrTail } : {})
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
