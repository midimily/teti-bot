# Chatmail Integration

## How Teti Talks to chatmail

Teti talks to chatmail/core through the Chatmail Adapter layer:

```text
Teti Account Manager
  -> ChatmailAdapter
  -> RealChatmailAdapter
  -> JsonRpcChatmailClient
  -> deltachat-rpc-server
  -> chatmail/core
  -> mail.seep.im
```

The adapter interface remains stable for the Teti account lifecycle:

- `createAccount()`
- `loadAccount()`
- `getIdentity()`
- `getPublicIdentity()`
- `sendMessage()`
- `receiveMessages()`
- `deleteAccount()`

`MockChatmailAdapter` is still available for local lifecycle tests. `RealChatmailAdapter` is the production integration shape.

## Real JSON-RPC Contract

`deltachat-rpc-server` speaks JSON-RPC over JSON Lines on stdio. Its RPC surface is generated from chatmail/core's `CommandApi` with positional arguments.

The local OpenRPC specification exposes snake_case wire method names and positional `params` arrays:

| Teti operation | chatmail/core RPC | Params |
| --- | --- | --- |
| Create account container | `add_account` | `[]` |
| Get account info | `get_account_info` | `[accountId]` |
| Legacy manual transport configuration | `add_or_update_transport` | `[accountId, { addr, password }]` |
| Configure from QR | `add_transport_from_qr` | `[accountId, qr]` |
| Start IO | `start_io` | `[accountId]` |
| Stop IO | `stop_io` | `[accountId]` |
| Export public vCard | `make_vcard` | `[accountId, [1]]` |
| Remove account | `remove_account` | `[accountId]` |

The TypeScript adapter can expose camelCase class methods, but the JSON-RPC method sent over stdio must match OpenRPC. Do not send named parameter objects.

## Why the RPC Boundary Exists

The RPC boundary keeps Teti from copying or reimplementing chatmail/core internals.

chatmail/core owns:

- account creation and deletion
- transport configuration
- local identity
- OpenPGP key generation
- encryption and decryption
- Autocrypt handling
- message send/receive
- local message database

Teti consumes these capabilities through JSON-RPC. This keeps the responsibilities separate and lets chatmail/core evolve without Teti depending on private Rust modules or SQLite tables.

## Where Private Keys Live

Private keys live inside chatmail/core-managed local account storage.

Teti must never expose or persist:

- private keys
- chatmail passwords
- chatmail credentials
- local database paths
- encryption material

The only identity material Teti may consume is public identity data returned by the adapter:

```ts
{
  address: string,
  publicKey?: string,
  fingerprint?: string
}
```

`getPublicIdentity()` uses public RPC surfaces only:

1. `get_account_info` for the configured address.
2. `make_vcard` for the self vCard and public key.

There is no stable structured fingerprint RPC in the inspected chatmail/core source. If a fingerprint is unavailable, Teti returns `undefined` and does not calculate or expose private key material.

## Real Onboarding Flow

Future onboarding should work like this:

1. Teti starts or connects to `deltachat-rpc-server`.
2. Teti constructs `RealChatmailAdapter` with `JsonRpcChatmailClient`.
3. `createTetiAccount()` calls `ChatmailAdapter.createAccount()`.
4. The adapter calls `add_account`.
5. The default auto-onboarding path configures chatmail transport through `add_transport_from_qr(accountId, "dcaccount:mail.seep.im")`.
6. chatmail/core creates and stores keys when needed.
7. Teti requests public identity material through `getPublicIdentity()`.
8. Teti stores local Teti metadata in `~/.teti/account.json`.
9. Teti registers the public identity card with the Cloudflare Discovery Registry.

## Messaging Mapping

Real connection messaging is implemented through chatmail/core RPC. Teti does not send directly by address and does not encrypt anything itself.

Send flow:

```text
remote public key available?
  -> import_vcard_contents
  -> create_chat_by_contact_id
  -> misc_send_text_message

otherwise:
  -> lookup_contact_id_by_addr
  -> create_contact if missing
  -> create_chat_by_contact_id
  -> misc_send_text_message
```

The public-key path is required for chatmail accounts that reject unencrypted outgoing messages. `create_contact` creates an address contact that chatmail/core documents as unencrypted, so Teti only uses that path as a compatibility fallback.

Receive flow:

```text
get_next_event_batch
  -> IncomingMsg
  -> get_message
```

Connection envelopes are JSON text payloads carried inside chatmail messages:

```json
{
  "teti": true,
  "type": "teti.connection.request",
  "version": 1,
  "payload": {}
}
```

Malformed or non-Teti messages are ignored by the connection messaging adapter.

## Current Limitations

Real server execution is covered by the Alpha E2E script, but full two-node confirmation currently needs relay/runtime diagnosis:

- A can create an encrypted outgoing connection request.
- A's message reaches `OutDelivered` with `showPadlock: true`.
- B's IMAP sync did not receive the message during the latest validation window.

This means the Teti bridge is no longer blocked at missing RPC methods; the remaining blocker is delivery/receive behavior across `mail.seep.im` for freshly auto-provisioned accounts.

## Responsibility Split

Chatmail answers:

> How can Teti communicate securely?

Teti answers:

> Who is this AI identity and what capabilities does it have?

Cloudflare Registry answers:

> Which Teti identities exist?

These responsibilities must not be merged.
