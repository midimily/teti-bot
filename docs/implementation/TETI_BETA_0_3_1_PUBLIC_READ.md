# Teti Beta 0.3.1 — Bootstrap & Public Read

Status: implemented and locally integrated

Application version: `0.3.1`

Network handoff:

```text
serviceVersionTested = 0.1.1
requiredProtocolVersion = 1
minimumContractRevision = 2
requiredCapabilities = [publicDirectory, publicProfile]
testedNetworkCommit = 2880838a78f6cc4173a61228f5cd16c1c7536e0e
handoffMetadataCommit = 798e56f
```

## Migrated paths

The lifecycle Runtime owns these official Network reads:

```text
GET /v1/bootstrap
GET /v1/public/nodes/:tetiId
GET /v1/public/nodes
GET /v1/public/stats
```

Peer identity resolution and periodic peer-profile refresh use
`TetiNetworkPublicReadAdapter`. Release Policy is read from the versioned bootstrap and retains the
existing monotonic, file-backed cache behavior. Its cache moves to
`network-release-policy-v1.json`, so a Worker policy with the same numeric revision cannot be
mistaken for the Network authority. Directory and Stats are exposed through Runtime
methods, not Renderer-owned fetches.

The client is handwritten from Canonical OpenAPI 3.1. It validates protocol headers, request IDs,
release metadata, pagination counts, stable sort values, public-node projections, durable stats,
and the App-facing Error Envelope. It has no Hono or Network-internal TypeScript dependency.

## Identity and delivery separation

`identityPublicKey` is never mapped to the App's Chatmail key. Only
`delivery.publicKey` maps to the optional transport key. `delivery.address` may use a RelayBinding
domain other than `mail.seep.im`; the mailbox must still match the canonical nine-character Teti
ID suffix. Local account provisioning remains unchanged and still validates its configured relay.

## Remaining legacy boundary

Cloudflare Worker access remains only behind `LegacyWorkerRegistrySyncAdapter` for:

- registration;
- registration write read-back/conflict detection;
- legacy profile heartbeat;
- identity delete.

The adapter has no directory method. Worker Release Policy and peer-profile reads are no longer in
product composition. The remaining write boundary is removed by later Beta 0.3 Identity/Profile
and Presence migrations; all Worker code is removed before final Beta 0.3 release.

## Local verification

```bash
npm test
TETI_NETWORK_BASE_URL=http://127.0.0.1:8788 npm run test:network:local
npm run desktop:typecheck
TETI_BUILD_TIMESTAMP=<ISO timestamp> npm run desktop:build
npm run desktop:rust-check
npm run desktop:rust-fmt -- --check
```

The persistent local Network development database is not seeded by App tests. Empty-directory and
zero-Stats behavior is verified against the running service; single/multi-node, pagination,
malformed response, 404, 429, timeout, dependency failure, and protocol mismatch use deterministic
handoff-compatible fixtures or injected transports.
