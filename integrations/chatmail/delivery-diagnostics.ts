import type {
  ChatmailAdapter,
  ChatmailSentMessage,
  SendChatmailMessageInput
} from "./types.ts";

export const DIAGNOSTIC_PLAIN_TEXT_BODY = "hello from teti alpha delivery test";

export interface DiagnosticPlainTextInput {
  accountId: number;
  peerAddress: string;
  peerPublicKey?: string;
  peerDisplayName?: string;
  text?: string;
}

export interface RedactedDeliveryDiagnostic {
  [key: string]: unknown;
}

export interface DeliveryMatrixClassificationInput {
  sendSucceeded: boolean;
  receiveSucceeded: boolean;
}

export type DeliveryMatrixClassification =
  | "send_failed"
  | "send_succeeded_receive_failed"
  | "send_and_receive_succeeded";

export async function sendDiagnosticPlainTextMessage(
  adapter: ChatmailAdapter,
  input: DiagnosticPlainTextInput
): Promise<ChatmailSentMessage> {
  const message: SendChatmailMessageInput = {
    accountId: input.accountId,
    peerAddress: input.peerAddress,
    text: input.text ?? DIAGNOSTIC_PLAIN_TEXT_BODY
  };
  if (input.peerPublicKey) {
    message.peerPublicKey = input.peerPublicKey;
  }
  if (input.peerDisplayName) {
    message.peerDisplayName = input.peerDisplayName;
  }

  return adapter.sendMessage(message);
}

export function safeMessagePreview(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }

  if (text === DIAGNOSTIC_PLAIN_TEXT_BODY) {
    return text;
  }

  if (text.includes("\"teti\":true") || text.includes("\"type\":\"teti.")) {
    return text.slice(0, 160);
  }

  return undefined;
}

export function redactDeliveryDiagnostics<TValue>(value: TValue): TValue {
  return redactValue(value) as TValue;
}

export function classifyDeliveryMatrixResult(
  input: DeliveryMatrixClassificationInput
): DeliveryMatrixClassification {
  if (!input.sendSucceeded) {
    return "send_failed";
  }

  if (!input.receiveSucceeded) {
    return "send_succeeded_receive_failed";
  }

  return "send_and_receive_succeeded";
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const redacted: RedactedDeliveryDiagnostic = {};
  for (const [key, child] of Object.entries(value)) {
    if (isSecretKey(key)) {
      redacted[key] = "[REDACTED]";
      continue;
    }

    if (key === "text" || key === "messageText" || key === "body") {
      redacted[key] = safeMessagePreview(typeof child === "string" ? child : undefined) ?? "[REDACTED]";
      continue;
    }

    redacted[key] = redactValue(child);
  }

  return redacted;
}

function isSecretKey(key: string): boolean {
  return /password|private|credential|secret|token|database|dbPath|filesystemPath/i.test(key);
}
