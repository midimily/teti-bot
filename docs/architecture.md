# Teti Architecture

Teti is a local-first identity companion.

The accepted Beta collaboration direction and versioned implementation plan are
defined in [`TETI_BETA_0_2_0_ROADMAP.md`](TETI_BETA_0_2_0_ROADMAP.md). Beta
0.1.2 freezes those future boundaries without changing current product or
network behavior.

## Layers

### Layer 1: Discovery

Cloudflare Worker + KV publishes short-lived public identity cards so other Teti nodes can discover available identities.

KV stores:

- Teti ID
- chatmail address
- public key
- public profile
- created and updated timestamps

KV must never store:

- private keys
- chat credentials
- private capability profiles
- connection graphs
- private conversations
- agent history

### Layer 2: Secure Communication

mail.seep.im is used as a relay for encrypted messages. The relay transports ciphertext only. Teti clients own the private keys and perform encryption/decryption locally.

### Layer 3: Confirmed-peer application semantics

The version-1 Teti Application Envelope carries Passport and Task semantic
objects over Chatmail. Beta 0.1.12 adds reliable text and image Task input,
transport receipts, explicit allow-once execution, state synchronization,
cancellation and bounded text Artifacts with identity binding, TTL,
idempotency, replay protection, passive version negotiation and offline
delivery.

This layer is A2A-aligned at the Task model boundary, but it is not a public A2A
endpoint and does not replace A2A. Transport receipt is separate from local
user approval and Agent execution. Local execution remains behind a qualified
Adapter, an isolated task directory and a short-lived single-use grant.

## Boundary

The Worker is an identity discovery layer, not a centralized user database or social graph.
