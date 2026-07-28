# Security Model

## Privacy by Design

Teti assumes public infrastructure can be compromised. The discovery registry therefore stores only public, short-lived identity cards.

## Cloudflare KV Leakage

If KV data leaks, attackers may learn public identity metadata such as public keys, chatmail addresses, public categories, and AI environment labels. They should not obtain private keys, chat credentials, private profiles, connection graphs, conversations, or agent history because those fields are not accepted or returned by the registry.

## Local Ownership

Private keys must remain on the user's device. Future signature verification should prove ownership of an identity without sending private material to the Worker.

## Application and Task Ingress

Confirmed-peer status is necessary but not sufficient for accepting a message.
Beta 0.1.13 additionally enforces:

- a 128 KiB UTF-8 limit before Application Envelope JSON parsing;
- an exact top-level Envelope allowlist and bounded identifiers/timestamps;
- strict per-message payload schemas, canonical Teti identity binding and Task
  TTL/clock-skew limits;
- semantic Task deduplication, monotonic status revisions and ordered receipts;
- isolation of malformed messages so one payload cannot stop the Runtime poll;
- bounded image, Adapter input/output and process lifetime limits.

Remote data cannot select an executable, command, argument, environment,
workspace, path, credential, model or tool. A Chatmail receipt never grants
execution. Only a receiver-side allow-once action creates a short-lived local
grant.

Beta 0.1.14 treats generated images as untrusted files until they pass the same
PNG/JPEG, size, dimensions and SHA-256 checks as Task inputs. Adapter output
paths must resolve inside the isolated task workspace, then the image is copied
to the private Artifact store before that workspace is deleted. An
`image-editing` execution that produces no verified image fails closed and
cannot publish a text-only success.

Beta 0.1.15 result-image actions canonicalize the selected path and allow only
verified PNG/JPEG files beneath Teti's private Artifact root. Opening, revealing
or exporting a result therefore cannot turn a remote Task field into an
arbitrary local filesystem operation. Task-v4 attachment receipts contain only
strict task, peer, purpose and attachment identifiers plus a timestamp.

Beta 0.2.0 rejects Application Envelope v1 before business dispatch and accepts
only Task v4 and network Passport schema 3. A bounded legacy outer-header check
may classify a confirmed sender as `需要升级`, but never parses its payload as a
Task or Passport. Unknown or incompatible Peers receive no speculative
downgrade.

The active collaboration Store is isolated below `~/.teti/store-v2`. Migrated
0.1 Tasks and attachments are copied to a read-only, explicitly non-executable
archive. Active replay and Task stores start empty, preventing old queued Tasks
from being executed by the new Runtime.

For `KD-0.1.15-MULTI-IMAGE-DELIVERY`, incomplete delivery is a tolerated
availability defect only. Every expected image must independently verify before
approval or execution; per-image diagnostics contain no path or credential.

Beta 0.2.1 separates collaboration authorization from provider integration.
The receiver-side allow-once action is reduced to an exact-input-bound,
short-lived, single-use `ExecutionAuthority`. Only `TetiHostAgent` can validate
and consume it. An `AgentConnector` receives no Authority, task text, Passport,
Chatmail object, connection record or peer identity. It returns only a
local-only execution specification; the Host validates that specification and
writes task text to the selected Transport.

`ProcessTransport` retains fixed entrypoints, bounded arguments/environment,
isolated working directories, combined output limits and detached process-group
cleanup. `FakeTransport` is test-only. `LoopbackHttpTransport` is reserved but
disabled, so Beta 0.2.1 introduces no new local HTTP attack surface. Transport
and Resource Binding details are excluded from both Task and Passport.

## Authentication Recovery

Teti does not transport or persist Agent credentials. If an Adapter detects an
expired local login, the Task returns to `auth_required` and pending approval.
The user authenticates through the Agent's own local interface and must choose
allow once again. The original Task TTL remains authoritative, so an
authentication prompt cannot remain actionable forever.
