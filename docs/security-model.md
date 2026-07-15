# Security Model

## Privacy by Design

Teti assumes public infrastructure can be compromised. The discovery registry therefore stores only public, short-lived identity cards.

## Cloudflare KV Leakage

If KV data leaks, attackers may learn public identity metadata such as public keys, chatmail addresses, public categories, and AI environment labels. They should not obtain private keys, chat credentials, private profiles, connection graphs, conversations, or agent history because those fields are not accepted or returned by the registry.

## Local Ownership

Private keys must remain on the user's device. Future signature verification should prove ownership of an identity without sending private material to the Worker.

