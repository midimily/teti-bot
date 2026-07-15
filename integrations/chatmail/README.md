# Teti Chatmail Adapter

This package is the integration boundary between Teti and chatmail/core.

Teti is responsible for AI identity, public profile, agent capability, and discovery. chatmail/core is responsible for account lifecycle, local identity, OpenPGP keys, encrypted messaging, local database storage, and mail relay communication through mail.seep.im.

## Why Teti Uses chatmail/core

chatmail/core already implements the foundation Teti needs for private communication:

- local account lifecycle
- local identity and account database
- OpenPGP key generation and storage
- Autocrypt and protected message handling
- encrypted message send/receive
- IMAP/SMTP relay communication

Teti should build on this foundation instead of creating a parallel messaging stack.

## Why Teti Does Not Implement Crypto

Teti must not implement its own cryptography, private key storage, encryption protocol, or message protocol. Private keys and message history belong in the local chatmail/core account database, controlled by chatmail/core.

This adapter never exposes:

- private keys
- chatmail credentials
- local database paths

## Adapter Responsibility

The adapter exposes a small Teti-facing interface:

- `createAccount()`
- `loadAccount()`
- `getIdentity()`
- `sendMessage()`
- `receiveMessages()`
- `deleteAccount()`

`MockChatmailAdapter` implements this interface in memory so Teti account lifecycle work can continue before the real RPC environment is wired up.

`RealChatmailAdapter` is the real integration shape. It delegates to a `ChatmailRpcClient`, which should speak to `deltachat-rpc-server` or `deltachat-jsonrpc`.

## Future JSON-RPC Integration Plan

The real adapter should use the existing chatmail/core JSON-RPC boundary:

1. Start or connect to `deltachat-rpc-server`.
2. Create an account through the account manager RPC.
3. Configure chatmail transport using `add_transport_from_qr(accountId, "dcaccount:mail.seep.im")` for automatic onboarding.
4. Start account I/O.
5. Send messages through contact/chat/message RPC APIs: `lookup_contact_id_by_addr`, `create_chat_by_contact_id`, then `misc_send_text_message`.
6. Receive messages through `get_next_event_batch`, `IncomingMsg`, then `get_message`.
7. Stop I/O and remove account through account manager RPC when deleting.

RPC wire method names follow the local OpenRPC specification and parameters are positional arrays. Public identity export uses `get_account_info(accountId)` plus `make_vcard(accountId, [1])`; fingerprint remains unset unless chatmail/core exposes a stable public-only RPC for it. Teti should not read chatmail SQLite tables directly to extract private or cryptographic state.

See also: `docs/chatmail-integration.md`.
