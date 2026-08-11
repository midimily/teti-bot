# Teti Mac App Beta 0.3.7 — Relay Binding & Bootstrap

## Contract gate

- App version: `0.3.7`
- Teti Network service tested: `0.1.7`
- Protocol: `1`
- Minimum Contract Revision: `8`
- Required capability: `relayBindings=true` in addition to the Beta 0.3.6 capability set
- Canonical source: `teti-network/openapi/teti-network.v1.json`; the App does not import Hono types

## Runtime ownership and flow

New account:

1. Runtime reads `/v1/bootstrap` and requires Revision 8.
2. Runtime confirms the preferred Relay against `GET /v1/relays` by ID, domain, region, provisioning
   URI, active status, and new-account availability.
3. Only the confirmed `accountProvisioning.value` is passed to Delta Chat. There is no product
   fallback Relay constant.
4. Existing Identity registration creates the Network identity without deriving its Teti ID from
   the Chatmail mailbox.
5. Runtime performs signed `GET /v1/relay-bindings/self` and requires the active address and
   transport public key to exactly match the local Chatmail account.
6. The verified BindingSet, ETag, and timestamp are cached under the active Network environment.

Existing account:

1. Runtime loads the local Chatmail account and never provisions another one.
2. Identity authentication is established before RelayBinding reconciliation.
3. Exact active binding continues normally.
4. A missing binding can be adopted only with an explicit
   `TETI_NETWORK_RELAY_BINDING_ADOPTION_GRANT`; the exact mailbox, Relay and transport key are sent.
5. Any mismatch stops automatic reconciliation and surfaces a stable RelayBinding error. The App
   does not overwrite either side.

Relay migration commands are implemented below the UI boundary for contract bring-up. Create,
activate and revoke persist the exact body, target path, ETag and idempotency key until success.
Active A remains authoritative while B is migrating. Beta 0.3.7 does not add a migration UI or move
Chatmail history.

## Persistence and recovery

- `store-v2/network/production/relay-binding-v1.json`
- `store-v2/network/local_development/relay-binding-v1.json`
- Owner-only file permissions and atomic rename
- No password, private key, Chatmail token, message content or account QR is persisted
- Retry signs a fresh request while preserving exact command bytes and idempotency identity
- Environment switching cannot reuse another environment's RelayBinding cache or Network keys

## Error behavior

The client maps all 0.1.7 Relay errors into the existing App-facing Network taxonomy. Relay
unavailability remains distinct from Identity authentication failure. Binding conflicts and stale
revisions are non-retryable until authoritative self/catalog state is refreshed. Redis/SQLite or
Network failure preserves the local Chatmail account and cached active binding; it never triggers a
fallback provisioning attempt.

## Verification matrix

Unit/contract:

- Bootstrap/catalog exact selection and unavailable/mismatch rejection
- Dynamic account QR propagation into the Chatmail provisioner
- Signed RelayBinding self/create/adopt/activate/revoke parsing and error mapping
- Strong ETag/revision matching and address/domain consistency
- Existing-account exact match, explicit adoption grant, mismatch rejection
- Exact-command recovery across Runtime restart
- Teti ID and Chatmail local part remain independent

Local Network:

- Revision 8/capability/bootstrap/catalog contract
- Register creates an active binding; signed self exactly matches delivery address/key
- Existing 0.1.6 identities remain readable after Network migration
- Network restart preserves SQLite-owned binding state

Rollback is an App binary rollback only: Beta 0.3.6 ignores RelayBinding capability while Network
0.1.7 remains deployed. No local Chatmail account or Network identity is deleted by rollback.
