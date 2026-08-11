# teti-bot

Teti is an open-source AI identity companion for the agent era.

Teti is not a chatbot, an assistant replacement, a social media application, or a centralized AI platform. It is designed as a personal AI identity node that runs on the user's own device and represents the user's AI identity, AI environment, AI capabilities, and trusted connections.

## Architecture

Beta 0.3 migrates the official control plane behind the versioned Teti Network contract. Beta 0.3.8
closes the local migration: the App has no legacy Worker/KV runtime, configuration, or admin path.

- Network contract: `Runtime -> NetworkClient -> network.teti.bot` (or local
  `http://127.0.0.1:8788`).
- Public Read, Release Policy, Identity and ClientInstance state:
  `Runtime -> NetworkClient -> teti-network -> SQLite`.
- Presence report/read: `Runtime -> NetworkClient -> teti-network -> Redis`; Presence never writes
  SQLite and never carries full Passport/Profile data.
- PublicProfile read/update: `Runtime -> NetworkClient -> teti-network -> SQLite`, using strong ETag,
  durable idempotency, and full-replacement conflict recovery.
- Private Relationship read/commands: `Runtime -> NetworkClient -> teti-network -> SQLite`, using
  one canonical unordered-pair ID, revision/ETag guards, and durable exact-command recovery.
- Relationship permission and recovery use fresh confirmed-only authorization plus stable snapshot
  and incremental-change reconciliation. `connections.json` is display/delivery recovery only.
- Relay bootstrap/catalog select Chatmail provisioning dynamically; signed RelayBinding state keeps
  the delivery address bound to the Network identity without coupling the Teti ID to a Relay.
- Signed HTTP authentication: separate Ed25519 Identity Root and ClientInstance keys, with Redis
  nonce/replay state. Chatmail/OpenPGP keys remain transport-only.
- Secure communication: Chatmail relays encrypted Teti-to-Teti messages.

Private keys, Chatmail credentials, private AI state, task content, and conversation history stay on
the user's device. Relationship is now Network-authoritative; the local Chatmail connection record
remains recovery state only. RelayBinding is Network-authoritative and cached separately for each
Network environment; Relay still owns message transport rather than Teti identity.

The App defaults to `https://network.teti.bot`. Settings has an explicit, default-off “本机 Network
开发环境” switch for `http://127.0.0.1:8788`; the fixed environment selection is persisted locally
and takes effect after restart so one Runtime never mixes credential domains. Existing local
identity adoption uses `TETI_NETWORK_ADOPTION_GRANT` outside loopback development. Network private
seeds are stored separately from `account.json` in the profile credentials directory with
owner-only permissions.

## Public ID Rule

Teti has one canonical public-ID format: `teti_[a-z0-9]{9}`. The card and desktop UI show only the 9-character suffix. Human input is case-insensitive, but local storage and Network protocol messages must contain the lowercase canonical form. Invalid characters are rejected, never removed silently. Network identity and Chatmail delivery address are intentionally independent; adoption preserves both without creating a new Chatmail account.

See [`docs/teti-public-id.md`](docs/teti-public-id.md) for the complete boundary rules.

Runtime owns the Presence scheduler: collaboration and visible connection-panel modes report every
5 seconds, foreground online every 15 seconds, and background every 30 seconds. State changes and
system wake report immediately; system sleep stops reports. Chatmail peer heartbeats remain a
separate message-transport mechanism.

## Repository Layout

```text
teti-bot/
├── apps/desktop/
├── core/
│   ├── identity/
│   ├── profile/
│   └── crypto/
├── integrations/
│   ├── chatmail/
│   └── agents/
├── services/discovery/
├── services/network/
├── protocol/
└── docs/
```

## Current Network Migration Boundary

`services/network` contains the thin, backend-independent Network v1 client. Beta 0.3.8 requires
protocol 1, minimum contract revision 8, `identity`, `clientAuthentication`, `publicDirectory`,
`publicProfile`, `presence`, `relationships`, and `relayBindings`. The App consumes OpenAPI/JSON rather than Hono types. Runtime owns
bootstrap, registration/adoption, signed `/self`, ClientInstance enrollment/revocation, Presence,
revisioned PublicProfile, canonical Relationship commands, confirmed-only authorization, and
snapshot/change recovery. It also confirms bootstrap Relay selection against `/v1/relays`, passes
the dynamic provisioning URI to Chatmail, and validates signed RelayBinding state after identity
synchronization. Confirmed-peer Passport remains Runtime/Chatmail-owned. All
official Network business crosses the Runtime-owned `NetworkClient`; Chatmail remains a separate
message transport.

## Beta MVP 1.0 Architecture

The accepted Beta boundary and staged Runtime convergence are documented in
[`docs/TETI_BETA_MVP_1_0_ARCHITECTURE_FREEZE.md`](docs/TETI_BETA_MVP_1_0_ARCHITECTURE_FREEZE.md).
Task 1 froze the Capability Passport model and introduced the Runtime Host. The lifecycle sidecar now
owns Network synchronization, Chatmail polling, peer transport presence, AI-status sync, and Codex
refresh. Desktop is a Runtime consumer: periodic reads update UI snapshots and never drive background
Network or Chatmail work.

To regression-test first launch on a development Mac while preserving the
local Chatmail account store, follow
[`docs/testing/TETI_FIRST_LAUNCH_REGRESSION.md`](docs/testing/TETI_FIRST_LAUNCH_REGRESSION.md).
