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

## Authentication Recovery

Teti does not transport or persist Agent credentials. If an Adapter detects an
expired local login, the Task returns to `auth_required` and pending approval.
The user authenticates through the Agent's own local interface and must choose
allow once again. The original Task TTL remains authoritative, so an
authentication prompt cannot remain actionable forever.
