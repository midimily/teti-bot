# Teti Beta 0.2.8 Local Release Policy

## Purpose

Beta 0.2.8 separates two facts that were previously conflated:

- whether this local Teti binary is still supported;
- whether a particular connected Peer supports the current collaboration protocol.

Only the first fact may freeze the whole local application.

## Decision matrix

| Local Release state | Peer compatibility | Local application | Peer collaboration |
| --- | --- | --- | --- |
| `supported` | `compatible` | available | available |
| `supported` | `upgrade_required` | available | that Peer is isolated and labelled “需要升级” |
| `supported` | `unknown` | available | that Peer is isolated and labelled “版本检测中” |
| `checking` / `temporarily_unavailable` | any | available | governed by the Peer state only |
| `update_required` | any | globally frozen | unavailable |

Network failure is fail-open unless a previously cached, effective Release Policy already proves that the local binary is obsolete. A missing Peer Presence message, Passport refresh, local Agent discovery, or detected Claude installation can never produce a global update lock.

## Policy authority

The Registry Worker exposes `GET /release-policy` with:

```json
{
  "schemaVersion": 1,
  "policyVersion": 1,
  "channel": "beta",
  "minimumSupportedVersion": "0.2.8",
  "effectiveAt": "2026-08-02T00:00:00.000Z"
}
```

Deployment bindings may set:

- `TETI_RELEASE_POLICY_VERSION`;
- `TETI_MINIMUM_SUPPORTED_VERSION`;
- `TETI_RELEASE_POLICY_EFFECTIVE_AT`.

Every policy mutation must increase `policyVersion`. The lifecycle sidecar rejects a lower policy revision and rejects changed content under the same revision. The last accepted policy is stored in `store-v2/release-policy-v1.json`.

## Production deployment

The route was deployed on 2026-08-02 to
`https://teti-registry.seep2026.workers.dev/release-policy` as Cloudflare Worker
version `bd2ac27d-0671-4d08-8cbf-b6e51aff8f19`. Public verification returned
HTTP 200, `cache-control: public, max-age=300`, the required CORS header and
policy revision 1 with the effective `0.2.8` floor.

The policy route is control-plane-only and no longer depends on the Registry KV
binding. `npm run verify:release-policy` in `services/discovery-worker` is the
repeatable post-deployment smoke gate. A future floor change must update all
three source-controlled bindings, increase `policyVersion`, deploy, and pass
that smoke gate before the effective time.

## Enforcement

The lifecycle sidecar checks the local Release status before handling application functions. Only `lifecycle.health`, `release.status`, `account.load`, and `account.status` remain readable so the Desktop can render an accurate upgrade screen. Registry, Chatmail, local Agent discovery, and quota refresh jobs stop scheduling work while locked; the Host Agent is shut down so active Child execution is cancelled. The WebView independently renders the global blocker only for `update_required`.

Beta 0.2.7 and earlier binaries do not contain this self-enforcement client and therefore cannot be retroactively frozen. The remotely adjustable version floor becomes effective for binaries starting with Beta 0.2.8.

Deploying the route changes a fresh Beta 0.2.8 client from
`temporarily_unavailable` to the authoritative `supported` state. It does not,
and technically cannot, inject self-lock code into already installed 0.2.7 or
older binaries. Those Peers are isolated by Task v6 and Passport compatibility
checks when they communicate with 0.2.8; only 0.2.8 and later can enforce a
future local floor while offline from a previously accepted cached policy.

## Beta 0.2.8 release gate

Release compatibility is a mandatory 0.2.8 gate, with these distinct checks:

- production `/release-policy` passes the exact endpoint smoke test;
- fresh 0.2.8 resolves policy revision 1 as `supported` from the network;
- a missing network response without authoritative cache remains fail-open;
- a cached, effective simulated `0.2.9` floor keeps 0.2.8
  `update_required` while offline;
- policy rollback and same-revision mutation are rejected;
- `update_required` blocks Host admission and stops active Child execution,
  while version/build identity and the upgrade screen remain available;
- an old or unknown Peer is isolated per Peer and never globally freezes the
  supported local 0.2.8 application;
- 0.2.7 retroactive self-lock is recorded as an explicit non-goal rather than
  represented as a passing compatibility claim.

## Build identity

The Desktop build command creates one UTC timestamp and injects the same version and timestamp into both the WebView bundle and the lifecycle sidecar. Settings displays the exact values at the bottom of the panel. The timestamp represents build creation time, not filesystem modification time or packaging time.
