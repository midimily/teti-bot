# Teti Alpha 1.0 Receive Blocker Analysis

Date: 2026-07-14

## Previous Blocker

The last real two-node run showed:

```text
A identity birth: PASS
B identity birth: PASS
Registry registration: PASS
Discovery: PASS
A encrypted send: PASS
A message state: OutDelivered
A showPadlock: true
B IncomingMsg observed: no
```

The send-side bridge was no longer blocked. The remaining uncertainty was whether B failed because of Teti's receive loop, Desktop-style event handling differences, or relay/IMAP delivery.

## Current Teti Receive Path Before Fix

Files:

- `/Users/macstudio/Documents/MidiMily/teti-bot/integrations/chatmail/rpc-client.ts`
- `/Users/macstudio/Documents/MidiMily/teti-bot/integrations/chatmail/connection-messaging.ts`
- `/Users/macstudio/Documents/MidiMily/teti-bot/core/connection/manager.ts`
- `/Users/macstudio/Documents/MidiMily/teti-bot/scripts/teti-alpha1-real-message-e2e.ts`

The previous receive implementation:

```text
receiveConnectionEvents()
  -> receiveMessages()
  -> get_next_event_batch([])
  -> only handle IncomingMsg
  -> get_message(accountId, msgId)
  -> parse message.text
```

Known good parts:

- B runtime is started with the correct isolated accounts path.
- B calls `start_io`.
- B keeps the runtime process alive during the receive window.
- Teti uses the right `get_message(accountId, msgId)` positional parameter shape.
- Teti extracts `message.text`, matching Desktop notification/message paths.

Gaps compared with Desktop:

- Teti only accepted `IncomingMsg`.
- Desktop also treats `MsgsChanged` as a new-message signal in some cases.
- Teti's connection receive call was effectively one batch per outer loop.
- A `get_next_event_batch` timeout surfaced as an error instead of falling back to bot-style message polling.
- E2E diagnostics did not preserve B-side event batches or fetched message IDs.

## Fixes Implemented

### 1. Handle `MsgsChanged`

`JsonRpcChatmailClient.receiveMessages()` now treats both event kinds as message candidates:

```text
IncomingMsg { msgId }
MsgsChanged { msgId }
```

Both call:

```text
get_message(accountId, msgId)
```

### 2. Add `get_next_msgs` Fallback

When an event batch contains no message event, Teti calls:

```text
get_next_msgs(accountId)
```

Each returned message ID is fetched with `get_message`. This mirrors the bot-oriented fallback documented in chatmail/core while still preferring `IncomingMsg` events.

### 3. Add Repeated Connection Receive Polling

`ChatmailConnectionMessagingAdapter.receiveConnectionEvents()` now accepts:

```ts
{
  pollCount?: number,
  pollIntervalMs?: number
}
```

The default remains one poll to preserve existing behavior. The E2E script uses multiple polls per wait iteration.

### 4. Add Safe Diagnostics

The receive path can emit structured diagnostics:

- event batch kinds and IDs
- event batch timeout messages
- `get_next_msgs` message IDs
- fetched message ID/chat ID/from address/hasText
- parsed Teti envelope type
- ignored invalid/missing-text messages

Diagnostics do not include:

- message text
- private keys
- passwords
- credentials
- local database contents

### 5. Add Message Status Probe

The RPC client now exposes:

```ts
getMessageStatus(accountId, messageId)
```

It returns only:

```ts
{
  messageId,
  chatId,
  state,
  showPadlock,
  error
}
```

This supports E2E reporting for A-side and B-side sends without exposing payloads.

## Tests Added

New coverage includes:

- repeated connection receive polling
- Desktop-confirmed `MsgsChanged` incoming event shape
- `get_next_msgs` fallback when an event batch has no message event
- envelope extraction after repeated polling
- diagnostics avoiding raw message text

## Remaining Real-World Question

The 2026-07-14 real E2E run still did not reach `PendingApproval`, but the failure is now better isolated.

Observed:

```text
B start_io: ok
B event stream: active
B IMAP: connected
B IMAP idle: reached
A send: messageId 13 / chatId 12
A message status: OutPending -> OutDelivered
A showPadlock: true
B next message ids: only device message 11
B parsed Teti envelopes: none
```

This distinguishes:

- B-side message event for A's request: not observed
- B-side event stream health: ok
- B-side IMAP login/idle: ok
- B fetched messages: only `device@localhost` message 11
- B fetched a Teti envelope: no
- A delivered to SMTP: yes, state 26

## Current Suspected Blocker

The receive parser is no longer the main suspect. The evidence points to relay/IMAP delivery for freshly auto-provisioned accounts:

```text
A can enqueue and deliver an encrypted message.
B can start IO and sync INBOX.
B INBOX does not contain A's message during the validation window.
```

The next useful checks are:

- verify whether Delta Chat Desktop can send a normal message to the same B address
- inspect relay-side delivery logs if available
- test a longer account readiness delay between B provisioning and A sending
- test whether B must perform an outbound action before receiving from a newly created peer
- compare mail.seep.im behavior for two accounts created through Desktop versus the Teti runtime script

No Teti crypto or protocol redesign is indicated by this result.
