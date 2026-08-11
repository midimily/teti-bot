import type { LifecycleErrorCode, LifecycleErrorDto, LifecycleMethod } from "../src/lifecycle-bridge/protocol.ts";

export function createLifecycleError(
  code: LifecycleErrorCode,
  message: string,
  options: {
    recoverable?: boolean;
    retryTarget?: LifecycleMethod;
  } = {}
): LifecycleErrorDto {
  const error: LifecycleErrorDto = {
    code,
    message: redactSecretLikeText(message),
    recoverable: options.recoverable ?? isRecoverableCode(code)
  };

  if (options.retryTarget) {
    error.retryTarget = options.retryTarget;
  }

  return error;
}

export function sanitizeUnknownError(error: unknown, fallbackCode: LifecycleErrorCode): LifecycleErrorDto {
  const message = error instanceof Error ? error.message : String(error);
  const code = classifyError(message, fallbackCode);
  const result = createLifecycleError(code, publicMessageForCode(code), {
    recoverable: isRecoverableCode(code),
    retryTarget: retryTargetForCode(code)
  });
  const diagnosticCode = readDiagnosticCode(error);
  if (diagnosticCode) result.diagnosticCode = diagnosticCode;
  return result;
}

export function redactSecretLikeText(text: string): string {
  return text
    .replace(/password=[^\s]+/gi, "password=[redacted]")
    .replace(/token=[^\s]+/gi, "token=[redacted]")
    .replace(/secret=[^\s]+/gi, "secret=[redacted]")
    .replace(/credential[s]?=[^\s]+/gi, "credentials=[redacted]")
    .replace(/authorization:[^\n\r]+/gi, "authorization:[redacted]")
    .replace(/private[-_ ]?key[^\s]*/gi, "private-key[redacted]")
    .slice(0, 300);
}

function classifyError(message: string, fallbackCode: LifecycleErrorCode): LifecycleErrorCode {
  if (fallbackCode.startsWith("CONNECTION_")) {
    return fallbackCode;
  }
  if (fallbackCode === "TASK_TRANSPORT_FAILED") {
    return fallbackCode;
  }
  if (fallbackCode === "MEMORY_OPERATION_FAILED") {
    return fallbackCode;
  }
  if (/(network|fetch|register|ECONN|ENOTFOUND|timeout)/i.test(message)) {
    return "NETWORK_IDENTITY_FAILED";
  }
  if (/(name|required|empty)/i.test(message)) {
    return "INVALID_NAME";
  }
  if (/(already exists|duplicate)/i.test(message)) {
    return "ACCOUNT_ALREADY_EXISTS";
  }
  if (/(load|read|parse|unsupported|corrupt|account version)/i.test(message)) {
    return "ACCOUNT_LOAD_FAILED";
  }
  if (/(provision|chatmail|rpc|configure|identity)/i.test(message)) {
    return "ACCOUNT_CREATE_FAILED";
  }
  return fallbackCode;
}

function publicMessageForCode(code: LifecycleErrorCode): string {
  switch (code) {
    case "INVALID_NAME":
      return "Name your Teti to continue.";
    case "ACCOUNT_LOAD_FAILED":
      return "Teti could not check the local identity yet.";
    case "ACCOUNT_ALREADY_EXISTS":
      return "A Teti account already exists in this validation profile.";
    case "ACCOUNT_CREATE_FAILED":
      return "Teti could not finish setting up.";
    case "NETWORK_IDENTITY_FAILED":
      return "Teti could not finish connecting yet.";
    case "CONNECTION_RESOLVE_FAILED":
      return "Teti could not find that public identity.";
    case "CONNECTION_REQUEST_FAILED":
      return "Teti could not complete the connection request.";
    case "TASK_TRANSPORT_FAILED":
      return "Teti could not complete the Task transport request.";
    case "MEMORY_OPERATION_FAILED":
      return "Teti could not complete the local Child Memory operation.";
    case "REQUEST_TIMEOUT":
      return "Teti took too long to respond.";
    case "SIDECAR_UNAVAILABLE":
      return "Teti's local lifecycle service is unavailable.";
    default:
      return "Teti hit an internal setup problem.";
  }
}

function retryTargetForCode(code: LifecycleErrorCode): LifecycleMethod | undefined {
  switch (code) {
    case "ACCOUNT_CREATE_FAILED":
      return "account.create";
    case "NETWORK_IDENTITY_FAILED":
      return "network.identity.retry";
    case "CONNECTION_RESOLVE_FAILED":
      return "connection.resolve";
    case "CONNECTION_REQUEST_FAILED":
      return "connection.request";
    case "ACCOUNT_LOAD_FAILED":
    case "SIDECAR_UNAVAILABLE":
    case "REQUEST_TIMEOUT":
      return "lifecycle.health";
    default:
      return undefined;
  }
}

function isRecoverableCode(code: LifecycleErrorCode): boolean {
  return ![
    "UNSUPPORTED_PROTOCOL_VERSION",
    "MALFORMED_REQUEST",
    "UNKNOWN_METHOD",
    "OVERSIZED_REQUEST",
    "INTERNAL_ERROR"
  ].includes(code);
}

function readDiagnosticCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string"
    && /^(?:(?:CM|LOC|NETWORK|IDENTITY|RELATIONSHIP|RELAY|MAILBOX|INVITE|SERVER|PROTOCOL)_[A-Z0-9_]+|RATE_LIMITED)$/.test(code)
    ? code
    : undefined;
}
