# Teti Mac App Beta 0.3.8 — Cloudflare-free Local Finalization

## Contract baseline

Beta 0.3.8 is validated against teti-network 0.1.8 with Protocol 1 and minimum Contract Revision 8.
Compatibility is decided only by protocol, minimum revision, and the seven required capabilities:
Public Directory, Public Profile, Identity, Client Authentication, Presence, Relationships, and
Relay Bindings. The App records the service version for diagnostics but does not require it to equal
0.1.8. Invite remains unsupported.

## Runtime boundary

```text
Desktop UI
  -> lifecycle bridge
  -> Teti Runtime
  -> NetworkClient
  -> TETI_NETWORK_BASE_URL

Presence                         -> Network -> Redis
Identity/Profile/Relationship/
RelayBinding/Release/Public Read -> Network -> SQLite
Messages and peer envelopes      -> Chatmail relay
```

The renderer consumes Runtime snapshots and sends explicit user intent. It does not construct an
HTTP client, sign Network requests, schedule Presence, or access backend storage semantics.
`HttpTetiNetworkClient` is constructed only in the lifecycle-sidecar Runtime composition root.

## Removed legacy surface

- The legacy Worker service, deployment configuration, admin scripts, and KV audit scripts.
- The Registry HTTP client and its DTO/status/error vocabulary.
- The legacy Worker adapter and compatibility tests.
- Direct account deletion against the old admin API.
- Lifecycle methods that registered or heartbeated the old discovery service.
- Root package scripts that built, tested, or maintained the Worker.

Local logout/reset now deletes local App/Chatmail state only. Persistent Network identity deletion
is intentionally not claimed by this version.

## Local-data compatibility

Existing local account and Chatmail stores are preserved. Production and local-development Network
credentials, Profile mutation state, Relationship command/reconciliation state, and RelayBinding
cache remain isolated under their environment-specific directories. Old unscoped Network credential
and pending-command files are deleted during profile bootstrap so Runtime cannot bind them to the
wrong environment; Runtime then performs normal authenticated recovery.

## Automated gates

- `npm run test:cloudflare-free` scans production source and dependencies using the 0.1.8 handoff
  rule set and verifies that removed legacy paths do not exist.
- The gate also proves formal Network routes stay under `services/network` and the concrete HTTP
  client is instantiated only by Runtime composition.
- Unit tests cover clean profile creation, upgrade-local-data preservation, environment isolation,
  error normalization, contract compatibility, and all Runtime-owned Network services.
- `npm run test:network:local` runs black-box App integration against local teti-network, including
  Public Read, Identity/Auth, Presence, Profile, and two isolated Relationship Runtime profiles.

## Failure expectations

- Network unavailable: Runtime keeps local state and retries according to each service policy.
- Redis unavailable: Presence/auth/rate-limit operations surface normalized dependency errors;
  persistent local and SQLite-backed state is not re-created.
- SQLite unavailable: readiness-dependent persistent operations fail explicitly; bootstrap remains
  consumable according to the Network contract.
- Chatmail unavailable: Network identity and Relationship authority remain intact; message delivery
  retries separately.
- Protocol/revision/capability mismatch: Runtime reports `PROTOCOL_UNSUPPORTED` and does not attempt
  unsupported business operations.

## Exit criteria

Beta 0.3.8 is locally complete only when the static gate, TypeScript/Rust checks, full unit suite,
local Network integration suite, and macOS `.app` build all pass. No Worker is required to start,
register, publish Presence/Profile, discover peers, reconcile Relationships, resolve RelayBinding,
or exchange Chatmail messages.
