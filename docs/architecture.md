# Teti Architecture

Teti is a local-first identity companion.

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

## Boundary

The Worker is an identity discovery layer, not a centralized user database or social graph.

