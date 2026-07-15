# Delta Chat Desktop Receive Path Analysis

Date: 2026-07-14

Reference source:

```text
/Users/macstudio/Documents/AICoRun/deltachat-desktop
```

## Summary

Delta Chat Desktop keeps a long-lived `deltachat-rpc-server` process and continuously consumes the core event stream. It does not treat receive as a single request/response operation. UI stores subscribe to typed events emitted by the JSON-RPC client, then fetch messages or message list items as needed.

## Important Files

| File | Purpose |
| --- | --- |
| `/Users/macstudio/Documents/AICoRun/deltachat-desktop/packages/target-electron/src/deltachat/controller.ts` | Starts the stdio RPC server, forwards JSON-RPC responses, detects event batches, and re-emits events into the client event emitter. |
| `/Users/macstudio/Documents/AICoRun/deltachat-desktop/packages/frontend/src/backend-com.ts` | Exposes `BackendRemote` and `onDCEvent(accountId, eventType, callback)`. |
| `/Users/macstudio/Documents/AICoRun/deltachat-desktop/packages/frontend/src/stores/messagelist.ts` | Handles `IncomingMsg` and `MsgsChanged`, fetches message list items, and fetches individual messages when needed. |
| `/Users/macstudio/Documents/AICoRun/deltachat-desktop/packages/frontend/src/system-integration/notifications.ts` | Handles `IncomingMsg` and calls `getMessage` / notification helpers. |
| `/Users/macstudio/Documents/AICoRun/deltachat-desktop/packages/frontend/src/backend/chat.ts` | Shows contact/chat creation patterns using `lookupContactIdByAddr`, `createContact`, and `createChatByContactId`. |
| `/Users/macstudio/Documents/AICoRun/deltachat-desktop/packages/frontend/src/hooks/dialog/useAddTransportDialog.ts` | Uses `addTransportFromQr(accountId, transportString)`. |

## Runtime Lifecycle

Desktop creates a `StdioServer` around `deltachat-rpc-server` in `DeltaChatController.init()`.

Key behavior:

- It resolves the server path with `getRPCServerPath()`.
- It starts the stdio server once and keeps it alive.
- If `syncAllAccounts` is enabled, it calls `startIoForAllAccounts()`.
- Individual frontend paths can call `startIo(accountId)` and `stopIo(accountId)`.

This confirms Teti should keep Node B's RPC process alive while waiting for receive events.

## Event Loop

The Electron controller inspects JSON-RPC responses. If a response result contains event objects, it treats it as a `getNextEventBatch` response and re-emits each event:

```text
getNextEventBatch
  -> result: Event[]
  -> emit event.kind globally
  -> emit event.kind on account context emitter
```

Desktop uses camelCase event fields:

```ts
{
  contextId,
  event: {
    kind,
    chatId,
    msgId
  }
}
```

The core OpenRPC method name is snake_case on the wire:

```text
get_next_event_batch([])
```

## Incoming Message Handling

Desktop handles `IncomingMsg` directly:

```text
IncomingMsg { chatId, msgId }
  -> getMessage(accountId, msgId) in notification paths
  -> getMessageListItems(accountId, chatId, false, true) in message list paths
```

The message body is read from:

```text
message.text
```

## MsgsChanged Fallback

Desktop also treats `MsgsChanged` as a possible new-message signal.

In `messagelist.ts`, Desktop notes that some "new" messages do not trigger `IncomingMsg`; they only trigger `MsgsChanged`. For those, Desktop refetches message list items and appends new messages.

For Teti, which does not maintain a UI message list, the equivalent minimal behavior is:

```text
MsgsChanged { chatId, msgId }
  -> get_message(accountId, msgId)
  -> parse Teti envelope from message.text
```

## Contact And Chat Creation

Desktop's chat helper follows:

```text
lookupContactIdByAddr(accountId, email)
  -> getChatIdByContactId(accountId, contactId)
```

When creating a chat by email:

```text
createContact(accountId, email, null)
  -> createChatByContactId(accountId, contactId)
```

For encrypted chatmail-to-chatmail delivery, Teti's public-vCard import path remains the right fit:

```text
import_vcard_contents(accountId, peerVcard)
  -> create_chat_by_contact_id(accountId, contactId)
  -> misc_send_text_message(accountId, chatId, text)
```

## Lessons For Teti

Teti should:

- keep the B-side runtime alive while waiting
- call `start_io` before receive polling
- poll the correct account ID and account path
- consume event batches repeatedly, not as a one-shot receive
- handle both `IncomingMsg` and `MsgsChanged`
- use `get_next_msgs` as a bot-oriented fallback when an event batch contains no message event
- parse `message.text`, not summaries or rendered UI content

Teti should not:

- use Desktop UI message list state
- read chatmail SQLite directly
- inspect private keys
- duplicate message encryption logic
