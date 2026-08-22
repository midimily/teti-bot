import type {
  CallableAdapterDecodedArtifact,
  CallableAdapterSafeErrorCode
} from "../../../core/callability/adapter.ts";
import type {
  AgentConnector,
  AgentConnectorContext
} from "../../../core/callability/agent-core.ts";
import { isSafeAbsoluteLocalPath } from "../../../core/application/local-path.ts";
import type { LocalPathPlatform } from "../../../core/application/local-path.ts";

export const CODEX_IMAGE_CONNECTOR = {
  connectorId: "openai.codex.imagegen",
  childAgentId: "codex",
  connectorRevision: 3,
  capabilityIds: ["image-editing"],
  timeoutMs: 10 * 60 * 1_000,
  cancelGraceMs: 1_000,
  maxOutputBytes: 64 * 1024
} as const;

export interface CodexImageConnectorOptions {
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

export class CodexImageConnector implements AgentConnector {
  readonly descriptor = {
    contractVersion: 2 as const,
    connectorId: CODEX_IMAGE_CONNECTOR.connectorId,
    connectorRevision: CODEX_IMAGE_CONNECTOR.connectorRevision,
    childAgentId: CODEX_IMAGE_CONNECTOR.childAgentId,
    capabilityIds: [...CODEX_IMAGE_CONNECTOR.capabilityIds],
    inputModes: ["text", "image"] as const,
    outputModes: ["text", "image"] as const,
    transportKind: "process" as const,
    executionCapabilities: {
      supportsProgress: false,
      supportsPause: false,
      supportsResume: false,
      supportsCheckpoint: false,
      supportsCancel: true
    },
    executionSemantics: "external_side_effects_possible" as const,
    timeoutMs: CODEX_IMAGE_CONNECTOR.timeoutMs,
    cancelGraceMs: CODEX_IMAGE_CONNECTOR.cancelGraceMs,
    maxOutputBytes: CODEX_IMAGE_CONNECTOR.maxOutputBytes
  };
  readonly resourceBinding = {
    schemaVersion: 1 as const,
    bindingId: "codex.process.image-editing",
    childAgentId: CODEX_IMAGE_CONNECTOR.childAgentId,
    connectorId: CODEX_IMAGE_CONNECTOR.connectorId,
    transportKind: "process" as const,
    capabilityIds: [...CODEX_IMAGE_CONNECTOR.capabilityIds]
  };
  readonly fixedProcessEntrypoint: string;
  private readonly runnerPath: string;
  private readonly codexEntrypoint: string;
  private readonly codexHome?: string;

  constructor(options: CodexImageConnectorOptions) {
    this.fixedProcessEntrypoint = options.nodeEntrypoint;
    this.runnerPath = options.runnerPath;
    this.codexEntrypoint = options.codexEntrypoint;
    this.codexHome = options.codexHome;
  }

  createExecutionSpec(context: Readonly<AgentConnectorContext>) {
    if (!context.workspacePath) {
      throw new Error("Codex image Connector requires a Host Workspace Snapshot.");
    }
    return {
      kind: "process" as const,
      executable: this.fixedProcessEntrypoint,
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
      case "CODEX_IMAGE_INITIALIZE_TIMEOUT":
      case "CODEX_IMAGE_THREAD_START_TIMEOUT":
      case "CODEX_IMAGE_TURN_START_TIMEOUT":
        return "ADAPTER_UPSTREAM_FAILED";
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

export function parseRunnerManifest(
  stdout: string,
  platform?: LocalPathPlatform
): CodexImageRunnerManifest {
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
      || !isSafeAbsoluteLocalPath(image.path, platform)) {
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
