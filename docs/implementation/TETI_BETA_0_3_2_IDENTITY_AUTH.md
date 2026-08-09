# Teti Beta 0.3.2 — Identity & ClientInstance Authentication

Application version: `0.3.2`
Network handoff: service `0.1.2`, protocol `1`, minimum contract revision `3`

## Contract boundary

The App consumes the canonical OpenAPI/JSON contract through `services/network`. It imports no Hono
route or RPC types. Required capabilities are `identity`, `clientAuthentication`,
`publicDirectory`, and `publicProfile`.

Supported identity routes:

- `POST /v1/identity/register`
- `POST /v1/identity/adopt`
- `GET /v1/identity/self`
- `POST /v1/client-instances/enroll`
- `POST /v1/client-instances/{clientInstanceId}/revoke`

## Ownership and key separation

```text
Desktop UI
  -> Lifecycle bridge
  -> Teti Runtime
  -> TetiNetworkIdentityService
  -> NetworkClient
  -> teti-network 0.1.2
       SQLite: Identity / ClientInstance / Delivery
       Redis: nonce / replay / auth epoch

Chatmail remains the message transport and is not provisioned by adoption.
```

Three key classes are kept separate:

1. Identity Root Ed25519 key authorizes first clients and enrollment.
2. ClientInstance Ed25519 key signs HTTP requests.
3. Chatmail/OpenPGP public key remains delivery metadata only.

`account.json` stores only public Network binding metadata. Identity Root and ClientInstance private
seeds are stored in `store-v2/credentials/teti-network-identity-v1.json`, atomically written with
owner-only directory (`0700`) and file (`0600`) permissions.

## Registration and adoption

Newly created local accounts carry `mode=register`. Network generates the durable Teti ID; the App
then updates only the local `id` and Network binding. The existing Chatmail account ID, address,
OpenPGP key, fingerprint, and profile remain unchanged.

Accounts created before this metadata exists use `mode=adopt`. Adoption preserves the existing
canonical Teti ID and Chatmail identity. Production/gray adoption requires
`TETI_NETWORK_ADOPTION_GRANT`; loopback development uses the Network development-first-claim mode.

Before the first write, Runtime persists both signing keypairs, the exact UTF-8 JSON body, and the
idempotency key. A retry reuses the exact body bytes and idempotency key while generating a fresh
request UUID, timestamp, nonce, and HTTP signature. After a response, credentials are bound before
`account.json` is updated. If the second write fails, signed `/self` completes recovery after restart.

An active account with a missing credential file fails closed. It never silently creates a new root
or attempts to reclaim the identity.

## Runtime and UI behavior

Runtime owns identity synchronization on startup, after account creation, and explicit retry. The
existing lifecycle `discovery.retry` command is retained as a UI compatibility surface, but it calls
Runtime identity synchronization rather than a Worker adapter. Existing registry-shaped UI status
is temporarily used for minimal `registered`, `unreachable`, `rejected`, and `conflict` feedback.

No renderer code has access to the Network base URL, private seeds, adoption grant, signing input,
nonce, or raw Network error response.

## Failure mapping

The typed client maps stable App-facing codes including `NETWORK_UNAVAILABLE`, `NETWORK_TIMEOUT`,
`NETWORK_UNAUTHORIZED`, `NETWORK_CLIENT_REVOKED`, `NETWORK_CONFLICT`,
`IDENTITY_ALREADY_EXISTS`, `REQUEST_REPLAYED`, `IDEMPOTENCY_CONFLICT`, `RATE_LIMITED`,
`SERVER_UNAVAILABLE`, and `PROTOCOL_UNSUPPORTED`. HTTP status and backend dependency details are
diagnostic metadata, not UI control flow.

## Verification

- Official Contract Revision 3 signing vectors reproduced byte-for-byte.
- Every published negative mutation rejected.
- Unit tests cover clean registration, existing-account adoption, signed self, crash retry,
  missing credentials, key separation, permissions, replay/revocation/error mapping.
- Local integration runs serially against `http://127.0.0.1:8788` and exercises real SQLite/Redis:
  adoption, registration, restart recovery, enrollment, nonce replay, revocation, revoked-client
  rejection, and duplicate registration conflict.
- Desktop typecheck, complete unit suite, production build, and Rust checks remain required exit
  gates.

## Rollback boundary

Rollback is configuration/code-only before production: stop the 0.3.2 App and return to the 0.3.1
branch while retaining local Chatmail state. Do not delete Chatmail accounts or credentials to roll
back. The 0.3.2 local Network test database contains test identities and may be recreated only by the
Network project's documented development reset procedure.

## Deferred

Presence, relationship mutation, Invite, profile write, RelayBinding bootstrap, WebSocket/push,
Chatmail transport changes, and final Worker source removal are outside 0.3.2.
