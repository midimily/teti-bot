# Chatmail OpenRPC Verification

Verification command:

```sh
/Users/macstudio/Documents/AICoRun/core/target/release/deltachat-rpc-server --openrpc
```

Result:

- The command executed successfully.
- The local server exposes OpenRPC `1.0.0`.
- Methods use `paramStructure: "by-position"`.
- The local wire method names are snake_case.

This corrects the earlier generated-client assumption that the wire method names were camelCase. Teti's TypeScript methods may remain camelCase, but JSON-RPC payloads sent to `deltachat-rpc-server` must use the OpenRPC method names below.

## Verified Methods

| Teti need | OpenRPC method | Params | Status |
| --- | --- | --- | --- |
| Create account | `add_account` | `[]` | Found |
| Get account info | `get_account_info` | `[accountId]` | Found |
| Remove account | `remove_account` | `[accountId]` | Found |
| Start IO | `start_io` | `[accountId]` | Found |
| Stop IO | `stop_io` | `[accountId]` | Found |
| Configure transport | `add_or_update_transport` | `[accountId, param]` | Found |
| Configure from QR | `add_transport_from_qr` | `[accountId, qr]` | Found |
| Export self vCard | `make_vcard` | `[accountId, contacts]` | Found |
| Event receive loop | `get_next_event_batch` | `[]` | Found |
| Contact lookup | `lookup_contact_id_by_addr` | `[accountId, addr]` | Found |
| Create chat | `create_chat_by_contact_id` | `[accountId, contactId]` | Found |
| Send text | `misc_send_text_message` | `[accountId, chatId, text]` | Found |
| Load message | `get_message` | `[accountId, msgId]` | Found |

## Adapter Impact

The runtime bridge and `JsonRpcChatmailClient` now send:

```json
{"jsonrpc":"2.0","id":1,"method":"add_account","params":[]}
{"jsonrpc":"2.0","id":2,"method":"get_account_info","params":[1]}
{"jsonrpc":"2.0","id":3,"method":"remove_account","params":[1]}
```

No private-key, database, or encryption APIs are used.

