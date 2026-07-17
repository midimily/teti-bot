import type {
  TetiConnectionAccept,
  TetiConnectionEnvelope,
  TetiConnectionReject,
  TetiConnectionRequest
} from "../../core/connection/types.ts";
import {
  createConnectionAcceptEnvelope,
  createConnectionRequestEnvelope,
  createConnectionRejectEnvelope,
  parseConnectionEnvelope,
  serializeConnectionEnvelope,
  TetiConnectionProtocolError
} from "../../core/connection/protocol.ts";
import type { ChatmailAdapter, ChatmailReceiveDiagnostic } from "./types.ts";

export interface SendConnectionRequestInput {
  accountId: number;
  toAddress: string;
  toPublicKey?: string;
  request: TetiConnectionRequest;
}

export interface ReceiveConnectionRequestsInput {
  accountId: number;
  limit?: number;
  pollCount?: number;
  pollIntervalMs?: number;
  onDiagnostic?: (diagnostic: ConnectionReceiveDiagnostic) => void;
}

export type ConnectionReceiveDiagnostic =
  | ({ source: "chatmail" } & ChatmailReceiveDiagnostic)
  | {
      source: "connection";
      type: "parsedEnvelope";
      accountId: number;
      messageId: number;
      envelopeType: TetiConnectionEnvelope["type"];
    }
  | {
      source: "connection";
      type: "ignoredMessage";
      accountId: number;
      messageId: number;
      reason: string;
    };

export interface SentConnectionRequest {
  messageId: number;
  chatId?: number;
}

export interface SendConnectionAcceptInput {
  accountId: number;
  toAddress: string;
  toPublicKey?: string;
  accept: TetiConnectionAccept;
}

export interface SendConnectionRejectInput {
  accountId: number;
  toAddress: string;
  toPublicKey?: string;
  reject: TetiConnectionReject;
}

export interface SentConnectionEvent {
  messageId: number;
  chatId?: number;
}

export interface ReceivedConnectionRequest {
  messageId: number;
  chatId: number;
  fromAddress?: string;
  receivedAt?: string;
  request: TetiConnectionRequest;
  envelope: TetiConnectionEnvelope<TetiConnectionRequest>;
}

export type ReceivedConnectionEvent =
  | (ReceivedConnectionRequest & { type: "teti.connection.request" })
  | {
      type: "teti.connection.accept";
      messageId: number;
      chatId: number;
      fromAddress?: string;
      receivedAt?: string;
      accept: TetiConnectionAccept;
      envelope: TetiConnectionEnvelope<TetiConnectionAccept>;
    }
  | {
      type: "teti.connection.reject";
      messageId: number;
      chatId: number;
      fromAddress?: string;
      receivedAt?: string;
      reject: TetiConnectionReject;
      envelope: TetiConnectionEnvelope<TetiConnectionReject>;
    };

export interface ConnectionMessagingAdapter {
  sendConnectionRequest(input: SendConnectionRequestInput): Promise<SentConnectionRequest>;
  sendConnectionAccept(input: SendConnectionAcceptInput): Promise<SentConnectionEvent>;
  sendConnectionReject(input: SendConnectionRejectInput): Promise<SentConnectionEvent>;
  receiveConnectionEvents(
    input: ReceiveConnectionRequestsInput
  ): Promise<ReceivedConnectionEvent[]>;
  receiveConnectionRequests(
    input: ReceiveConnectionRequestsInput
  ): Promise<ReceivedConnectionRequest[]>;
}

export class ChatmailConnectionMessagingAdapter implements ConnectionMessagingAdapter {
  private readonly chatmailAdapter: ChatmailAdapter;

  constructor(chatmailAdapter: ChatmailAdapter) {
    this.chatmailAdapter = chatmailAdapter;
  }

  async sendConnectionRequest(input: SendConnectionRequestInput): Promise<SentConnectionRequest> {
    const envelope = createConnectionRequestEnvelope(input.request);
    const sent = await this.chatmailAdapter.sendMessage({
      accountId: input.accountId,
      peerAddress: input.toAddress,
      peerPublicKey: input.toPublicKey,
      text: serializeTetiConnectionMessage(envelope)
    });
    await this.chatmailAdapter.waitForDelivery?.({
      accountId: input.accountId,
      messageId: sent.messageId
    });
    return sent;
  }

  async sendConnectionAccept(input: SendConnectionAcceptInput): Promise<SentConnectionEvent> {
    const envelope = createConnectionAcceptEnvelope(input.accept);
    return this.chatmailAdapter.sendMessage({
      accountId: input.accountId,
      peerAddress: input.toAddress,
      peerPublicKey: input.toPublicKey,
      text: serializeTetiConnectionMessage(envelope)
    });
  }

  async sendConnectionReject(input: SendConnectionRejectInput): Promise<SentConnectionEvent> {
    const envelope = createConnectionRejectEnvelope(input.reject);
    return this.chatmailAdapter.sendMessage({
      accountId: input.accountId,
      peerAddress: input.toAddress,
      peerPublicKey: input.toPublicKey,
      text: serializeTetiConnectionMessage(envelope)
    });
  }

  async receiveConnectionEvents(
    input: ReceiveConnectionRequestsInput
  ): Promise<ReceivedConnectionEvent[]> {
    const events: ReceivedConnectionEvent[] = [];
    const pollCount = Math.max(1, Math.floor(input.pollCount ?? 1));
    const pollIntervalMs = Math.max(0, Math.floor(input.pollIntervalMs ?? 0));

    for (let attempt = 0; attempt < pollCount; attempt += 1) {
      const messages = await this.chatmailAdapter.receiveMessages({
        accountId: input.accountId,
        limit: input.limit,
        onDiagnostic: (diagnostic) => input.onDiagnostic?.({ source: "chatmail", ...diagnostic })
      });

      events.push(...this.parseConnectionMessages(input, messages));
      if (events.length > 0 || (input.limit && events.length >= input.limit)) {
        break;
      }

      if (attempt < pollCount - 1 && pollIntervalMs > 0) {
        await delay(pollIntervalMs);
      }
    }

    return events;
  }

  private parseConnectionMessages(
    input: ReceiveConnectionRequestsInput,
    messages: Awaited<ReturnType<ChatmailAdapter["receiveMessages"]>>
  ): ReceivedConnectionEvent[] {
    const events: ReceivedConnectionEvent[] = [];
    for (const message of messages) {
      if (!message.text) {
        input.onDiagnostic?.({
          source: "connection",
          type: "ignoredMessage",
          accountId: input.accountId,
          messageId: message.messageId,
          reason: "missing_text"
        });
        continue;
      }

      try {
        const envelope = parseTetiConnectionMessage(message.text);
        input.onDiagnostic?.({
          source: "connection",
          type: "parsedEnvelope",
          accountId: input.accountId,
          messageId: message.messageId,
          envelopeType: envelope.type
        });
        if (envelope.type === "teti.connection.request") {
          events.push({
            type: "teti.connection.request",
            messageId: message.messageId,
            chatId: message.chatId,
            fromAddress: message.fromAddress,
            receivedAt: message.receivedAt,
            request: envelope.payload as TetiConnectionRequest,
            envelope: envelope as TetiConnectionEnvelope<TetiConnectionRequest>
          });
        }

        if (envelope.type === "teti.connection.accept") {
          events.push({
            type: "teti.connection.accept",
            messageId: message.messageId,
            chatId: message.chatId,
            fromAddress: message.fromAddress,
            receivedAt: message.receivedAt,
            accept: envelope.payload as TetiConnectionAccept,
            envelope: envelope as TetiConnectionEnvelope<TetiConnectionAccept>
          });
        }

        if (envelope.type === "teti.connection.reject") {
          events.push({
            type: "teti.connection.reject",
            messageId: message.messageId,
            chatId: message.chatId,
            fromAddress: message.fromAddress,
            receivedAt: message.receivedAt,
            reject: envelope.payload as TetiConnectionReject,
            envelope: envelope as TetiConnectionEnvelope<TetiConnectionReject>
          });
        }
      } catch (error) {
        if (error instanceof TetiConnectionProtocolError) {
          input.onDiagnostic?.({
            source: "connection",
            type: "ignoredMessage",
            accountId: input.accountId,
            messageId: message.messageId,
            reason: "invalid_teti_envelope"
          });
          continue;
        }

        throw error;
      }
    }

    return events;
  }

  async receiveConnectionRequests(
    input: ReceiveConnectionRequestsInput
  ): Promise<ReceivedConnectionRequest[]> {
    return (await this.receiveConnectionEvents(input))
      .filter((event): event is ReceivedConnectionRequest & { type: "teti.connection.request" } => {
        return event.type === "teti.connection.request";
      })
      .map(({ type: _type, ...event }) => event);
  }
}

function serializeTetiConnectionMessage(envelope: TetiConnectionEnvelope): string {
  return JSON.stringify({
    teti: true,
    ...JSON.parse(serializeConnectionEnvelope(envelope))
  });
}

function parseTetiConnectionMessage(text: string): TetiConnectionEnvelope {
  return parseConnectionEnvelope(text);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
