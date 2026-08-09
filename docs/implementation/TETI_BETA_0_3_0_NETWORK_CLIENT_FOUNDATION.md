# Teti Beta 0.3.0 — Network Client Foundation

Status: local implementation and Network integration complete

Application version: `0.3.0`

Network handoff:

```text
serviceVersion = 0.1.0
protocolVersion = 1
minimumContractRevision = 1
requiredCapabilities = []
testedNetworkCommit = UNCOMMITTED_WORKTREE
```

The uncommitted Network handoff is valid for local integration only. A reviewed Network commit SHA
is required before a reproducible production release.

## Boundary

Beta 0.3.0 introduces the stable client seam without migrating Registry, release policy, Presence,
Profile, Relationship, Invite, or Relay behavior:

```text
Teti Runtime
  -> TetiNetworkClient
  -> GET /v1/bootstrap
  -> version/capability compatibility check
```

The Renderer never imports or calls `NetworkClient`. The lifecycle sidecar enables the preflight
only when `TETI_NETWORK_BASE_URL` is explicitly set. With no explicit URL, all existing Beta 0.2
business behavior remains unchanged while the foundation stays dormant.

Existing Registry and release-policy defaults are now explicitly named `LegacyWorkerAdapter` and
`LegacyWorkerReleasePolicyAdapter`. They delegate to the characterized Worker transports without
normalization or retry changes. Product composition no longer instantiates `RegistryDiscoveryClient`
directly; direct construction remains only in legacy transport tests and migration/E2E scripts.

## Contract consumption

The client is handwritten from the canonical OpenAPI 3.1 handoff. It does not import Hono
`AppType`, server Zod schemas, or internal Network TypeScript types.

It validates:

- protocol and contract response headers;
- server-generated UUID request ID;
- header/body version consistency;
- the eight known capability booleans;
- service identity and version;
- server time;
- JSON content type and Error Envelope;
- compatibility with protocol 1 and minimum contract revision 1.

Unknown response fields and future capabilities are ignored. Missing or malformed required fields
fail as `NETWORK_INVALID_RESPONSE`.

## Runtime ownership

When explicitly configured, Runtime owns a `network-contract` job. It runs independently of account
or Chatmail state, records a private diagnostic status, and applies Runtime-level retry delays of 5,
15, 30, 60, and 300 seconds only to retryable availability failures. An incompatible protocol uses
the normal 15-minute check interval. The HTTP client performs one bounded request, so retries cannot
multiply across transport and scheduler layers.

No Network status is exposed to UI in this version, and Network failure cannot stop existing
Registry, Chatmail, Agent, Task, or Passport work.

## Configuration

```text
TETI_NETWORK_BASE_URL
production default: https://network.teti.bot
local integration:  http://127.0.0.1:8788
tests:               FakeTetiNetworkClient or explicit local integration
```

Only HTTPS origins are accepted outside loopback development. Credentials, query strings,
fragments, and path-scoped base URLs are rejected. Vite exposes only `VITE_*`; `TETI_*` remains in
the Node lifecycle Runtime.

## Stable App error taxonomy

The foundation defines stable codes including:

```text
NETWORK_UNAVAILABLE
NETWORK_TIMEOUT
NETWORK_UNAUTHORIZED
NETWORK_CLIENT_REVOKED
NETWORK_CONFLICT
NETWORK_INVALID_RESPONSE
NETWORK_REQUEST_INVALID
NETWORK_REQUEST_REJECTED
IDENTITY_NOT_FOUND
IDENTITY_ALREADY_EXISTS
RELATIONSHIP_NOT_FOUND
INVITE_EXPIRED
INVITE_USED
RATE_LIMITED
SERVER_UNAVAILABLE
PROTOCOL_UNSUPPORTED
```

Runtime and future UI branch on `code`, never HTTP status or server message.

## Local verification

Unit and Runtime regression:

```bash
node --experimental-strip-types --test \
  services/network/*.test.ts \
  apps/desktop/test/runtime-service.test.ts \
  core/delegation/delegation.test.ts
```

Real local Network integration, which must not silently skip:

```bash
npm run test:network:local
```

The integration exercises both:

```text
HttpTetiNetworkClient -> http://127.0.0.1:8788
TetiRuntime -> HttpTetiNetworkClient -> http://127.0.0.1:8788
```

## Explicitly deferred

- Public directory and stats.
- Identity registration/adoption.
- Client instance authentication.
- Formal Presence.
- Public Profile writes.
- Relationship state.
- RelayBinding.
- Invite.
- Production `network.teti.bot` pairing.
- Cloudflare business-code removal; this is mandatory before Beta 0.3 finalization.
