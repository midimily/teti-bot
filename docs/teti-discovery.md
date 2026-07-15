# Teti Discovery

Teti Discovery lets one Teti find other public Teti identities before any encrypted chatmail conversation exists.

```mermaid
flowchart TD
  A["Local Teti Account"] --> B["Teti Discovery Service"]
  B --> C["Cloudflare Discovery Registry"]
  C --> B
  B --> D["Compatibility Matcher"]
  D --> E["Connection Request Draft"]
  E -. "future" .-> F["Chatmail Messaging Adapter"]
```

## Why Discovery Exists

Chatmail answers how Tetis communicate securely. Discovery answers which Tetis exist and what public capabilities they advertise. These are separate responsibilities.

Discovery data is intentionally public:

- Teti id
- chatmail address
- public key
- public profile, such as platform, category, and AI environment

Discovery never contains private keys, chatmail credentials, local database paths, or chat history.

## Discovery Identity vs Chatmail Identity

A chatmail identity is the secure communication identity owned by chatmail/core. It includes local account state, OpenPGP keys, encrypted messaging, and relay communication.

A discovery identity is the public registry entry for a Teti. It points to the chatmail address and public profile so other Tetis can decide whether to connect.

## Client API

```ts
const discovery = new TetiDiscoveryService();

const tetis = await discovery.discoverTetis({ limit: 20 });
const profile = await discovery.getTetiProfile("teti_alex");
```

## Matching

`matchTetis()` is a simple deterministic matcher. It gives points for:

- same platform
- shared AI environments
- shared categories
- public key availability

This keeps V1 predictable and testable. A later version can add richer policy rules without changing the discovery boundary.

## Future Connection Flow

1. Discover public Teti identities.
2. Fetch a selected Teti profile.
3. Score compatibility against the local public profile.
4. Prepare a connection request draft.
5. Send the request through chatmail once the Teti-to-Teti protocol is defined.

The discovery layer stops at step 4. It does not implement messaging.
