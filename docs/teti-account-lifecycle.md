# Teti Account Lifecycle

## What Is a Teti Account?

A Teti account is the local metadata record for a user's AI identity node.

It answers:

> Who is this AI identity and what public capabilities does it advertise?

A Teti account stores public-facing identity metadata and a pointer to the chatmail/core account that owns secure communication.

It does not store:

- private keys
- chatmail passwords
- chatmail credentials
- encryption material
- local chatmail database paths
- message history

## Relationship Between Layers

### Teti Account

The Teti account is local Teti metadata:

- Teti address
- chatmail account id
- public profile
- optional public key exported safely by chatmail/core
- created timestamp

Teti owns AI identity, profile, capability, and discovery logic.

### chatmail Identity

The chatmail identity is owned by chatmail/core:

- account lifecycle
- local identity
- OpenPGP keys
- encrypted messaging
- local SQLite database
- relay communication through mail.seep.im

Teti must use the Chatmail Adapter instead of reading chatmail storage or implementing crypto.

### Discovery Identity

The discovery identity is the public identity card registered with the Cloudflare Worker registry:

- version
- Teti id derived from the address local part
- chatmail address
- public profile
- public key when available

Cloudflare Registry answers:

> Which Teti identities exist?

It must not become a private user database or social graph.

## Where Data Is Stored

Default Teti local metadata path:

```text
~/.teti/account.json
```

This file contains:

- `version`
- `address`
- `displayName` when available
- `chatmailAccountId`
- `publicKey` when available
- `fingerprint` when available
- `publicProfile`
- `createdAt`

Private identity data remains in chatmail/core storage, not Teti storage.

## Lifecycle Flow

### Create Account

1. Check local Teti storage.
2. If an account already exists, return it.
3. For automatic onboarding, call `ChatmailProvisioner.createIdentity(displayName)`.
4. Create a Teti public profile.
5. Save local Teti metadata.
6. Call `DiscoveryClient.registerIdentity()`.
7. Return `TetiAccount`.

### Load Account

`loadTetiAccount()` reads local Teti storage only.

It does not contact chatmail/core or the network automatically.

### Query Status

`getTetiStatus()` checks whether local Teti metadata exists and whether the registry has a matching public identity.

The current `onlineStatus` is `unknown` because V1 does not yet include heartbeat monitoring.

### Delete Account

1. Load local Teti metadata.
2. Call `DiscoveryClient.deleteIdentity()`.
3. Call `ChatmailAdapter.deleteAccount()`.
4. Remove local Teti metadata.

## Future First-Install Onboarding

The first-install flow should call:

1. `createTetiAccount()`
2. Chatmail provisioning through `dcaccount:mail.seep.im`.
3. Safe public key export from chatmail/core when available.
4. Discovery registration.
5. Optional heartbeat scheduling.

Before real production account creation works end to end, Teti still needs:

- relay connectivity for `mail.seep.im` during chatmail provisioning
- full message send/receive integration over contact/chat/event RPCs
- a registry delete endpoint deployed in the Cloudflare Worker
- onboarding UX for the Teti display name
- heartbeat scheduling for active discovery

## Design Principle

The final relationship is:

- Chatmail answers: "How can Teti communicate securely?"
- Teti answers: "Who is this AI identity and what capabilities does it have?"
- Cloudflare Registry answers: "Which Teti identities exist?"

These responsibilities must stay separate.
