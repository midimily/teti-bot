import type {
  CallableAdapter,
  CallableAdapterDecodedArtifact,
  CallableAdapterLaunchContext,
  CallableAdapterSafeErrorCode
} from "../../../core/callability/adapter.ts";

export const CODEX_IMAGE_CALLABLE_ADAPTER = {
  adapterId: "openai.codex.imagegen",
  agentId: "codex",
  adapterRevision: 1,
  capabilityIds: ["image-editing"],
  timeoutMs: 10 * 60 * 1_000,
  cancelGraceMs: 1_000,
  maxOutputBytes: 64 * 1024
} as const;

export interface CodexImageCallableAdapterOptions {
  nodeEntrypoint: string;
  runnerPath: string;
  codexEntrypoint: string;
  codexHome?: string;
}

interface CodexImageRunnerManifest {
  schemaVersion: 1;
  text: string;
  images: Array<{ path: string }>;
}

export class CodexImageCallableAdapter implements CallableAdapter {
  readonly descriptor = {
    contractVersion: 2 as const,
    adapterId: CODEX_IMAGE_CALLABLE_ADAPTER.adapterId,
    adapterRevision: CODEX_IMAGE_CALLABLE_ADAPTER.adapterRevision,
    agentId: CODEX_IMAGE_CALLABLE_ADAPTER.agentId,
    capabilityIds: [...CODEX_IMAGE_CALLABLE_ADAPTER.capabilityIds],
    inputModes: ["text", "image"] as const,
    outputModes: ["text", "image"] as const,
    timeoutMs: CODEX_IMAGE_CALLABLE_ADAPTER.timeoutMs,
    cancelGraceMs: CODEX_IMAGE_CALLABLE_ADAPTER.cancelGraceMs,
    maxOutputBytes: CODEX_IMAGE_CALLABLE_ADAPTER.maxOutputBytes
  };
  readonly entrypoint: string;
  private readonly runnerPath: string;
  private readonly codexEntrypoint: string;
  private readonly codexHome?: string;

  constructor(options: CodexImageCallableAdapterOptions) {
    this.entrypoint = options.nodeEntrypoint;
    this.runnerPath = options.runnerPath;
    this.codexEntrypoint = options.codexEntrypoint;
    this.codexHome = options.codexHome;
  }

  createLaunchSpec(context: Readonly<CallableAdapterLaunchContext>) {
    return {
      executable: this.entrypoint,
      args: [
        this.runnerPath,
        "--codex",
        this.codexEntrypoint,
        "--workspace",
        context.workspacePath,
        ...context.images.flatMap((image) => ["--image", image.path])
      ],
      environment: {
        NO_COLOR: "1",
        TERM: "dumb",
        ...(this.codexHome ? { CODEX_HOME: this.codexHome } : {})
      }
    };
  }

  decodeArtifact(stdout: string): CallableAdapterDecodedArtifact {
    const manifest = parseRunnerManifest(stdout);
    return { kind: "parts", text: manifest.text, images: manifest.images };
  }

  classifyFailure(stdout: string): CallableAdapterSafeErrorCode {
    switch (parseRunnerFailureCode(stdout)) {
      case "CODEX_IMAGE_RESULT_MISSING":
        return "ADAPTER_IMAGE_RESULT_MISSING";
      case "CODEX_IMAGE_RESULT_NOT_READY":
        return "ADAPTER_IMAGE_RESULT_NOT_READY";
      case "CODEX_IMAGE_RESULT_INVALID":
        return "ADAPTER_IMAGE_RESULT_INVALID";
      case "CODEX_IMAGE_SERVER_EXITED":
      case "CODEX_IMAGE_SERVER_FAILED":
        return "ADAPTER_IMAGE_SERVER_EXITED";
      case "CODEX_IMAGE_COMPLETION_TIMEOUT":
        return "ADAPTER_IMAGE_GENERATION_TIMEOUT";
      case "CODEX_IMAGE_REQUEST_FAILED":
        return "ADAPTER_UPSTREAM_FAILED";
      case "CODEX_IMAGE_PROTOCOL_LIMIT":
        return "ADAPTER_IMAGE_PROTOCOL_LIMIT";
      case "CODEX_IMAGE_PROTOCOL_INVALID":
      case "CODEX_IMAGE_STDERR_LIMIT":
      case "CODEX_IMAGE_INTERNAL_ERROR":
        return "ADAPTER_OUTPUT_INVALID";
      default:
        return "ADAPTER_EXIT_NONZERO";
    }
  }
}

export function parseRunnerManifest(stdout: string): CodexImageRunnerManifest {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error("CODEX_IMAGE_OUTPUT_INVALID");
  }
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || typeof value.text !== "string"
    || !value.text.trim()
    || !Array.isArray(value.images)
    || value.images.length === 0
    || value.images.length > 4) {
    throw new Error("CODEX_IMAGE_OUTPUT_INVALID");
  }
  const images = value.images.map((image) => {
    if (!isRecord(image)
      || Object.keys(image).some((key) => key !== "path")
      || typeof image.path !== "string"
      || !image.path.startsWith("/")
      || image.path.includes("\0")) {
      throw new Error("CODEX_IMAGE_OUTPUT_INVALID");
    }
    return { path: image.path };
  });
  if (Object.keys(value).some((key) => !["schemaVersion", "text", "images"].includes(key))) {
    throw new Error("CODEX_IMAGE_OUTPUT_INVALID");
  }
  return { schemaVersion: 1, text: value.text, images };
}

export function parseRunnerFailureCode(stdout: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || Object.keys(value).some((key) => !["schemaVersion", "error"].includes(key))
    || !isRecord(value.error)
    || Object.keys(value.error).some((key) => key !== "code")
    || typeof value.error.code !== "string"
    || !/^CODEX_IMAGE_[A-Z0-9_]{1,64}$/.test(value.error.code)) {
    return null;
  }
  return value.error.code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
