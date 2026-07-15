# Chatmail Runtime Bridge

Teti talks to `chatmail/core` by launching `deltachat-rpc-server` as a local child process and speaking JSON-RPC over stdin/stdout.

```text
Teti Account Manager
  -> RealChatmailAdapter
  -> JsonRpcChatmailClient
  -> StdioJsonRpcTransport
  -> deltachat-rpc-server
  -> chatmail/core
```

## Runtime Launch

Use:

```ts
import { createRuntimeChatmailRpcClient } from "../integrations/chatmail/create-runtime-client.ts";

const client = createRuntimeChatmailRpcClient();
```

The returned client implements `ChatmailRpcClient` and also exposes:

```ts
await client.close();
```

Applications should call `close()` during shutdown so the local `deltachat-rpc-server` process exits cleanly.

## Environment Configuration

Runtime configuration is environment-based and is not stored in Teti account metadata.

| Variable | Purpose |
| --- | --- |
| `TETI_DELTACHAT_RPC_PATH` | Absolute or PATH-resolved path to `deltachat-rpc-server`. Defaults to `deltachat-rpc-server`. |
| `TETI_CHATMAIL_ACCOUNTS_PATH` | Directory managed by chatmail/core for account databases and identity state. Defaults to `~/.teti/chatmail-accounts`. |

When spawning the process, Teti passes `TETI_CHATMAIL_ACCOUNTS_PATH` to chatmail/core as `DC_ACCOUNTS_PATH`.

## Stdio Protocol

`deltachat-rpc-server` speaks JSON Lines:

- one JSON-RPC request per stdin line
- one JSON-RPC response per stdout line
- stderr is logging only

Example:

```json
{"jsonrpc":"2.0","id":1,"method":"add_account","params":[]}
{"jsonrpc":"2.0","id":2,"method":"get_account_info","params":[1]}
```

`StdioJsonRpcTransport` is responsible for:

- spawning the child process
- serializing requests to JSON Lines
- buffering stdout until full lines arrive
- parsing JSON-RPC responses
- correlating responses by `id`
- rejecting pending requests if the process exits
- forwarding stderr lines to an optional logger
- closing the process with SIGTERM and a SIGKILL fallback

## Security Boundary

The runtime bridge does not:

- read private keys
- export private keys
- inspect chatmail SQLite databases
- implement encryption
- duplicate chatmail/core cryptography

Private identity and encrypted message state remain owned by chatmail/core. Teti only receives public account information and public identity material through JSON-RPC.

