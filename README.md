# teti-bot

Teti is an open-source AI identity companion for the agent era.

Teti is not a chatbot, an assistant replacement, a social media application, or a centralized AI platform. It is designed as a personal AI identity node that runs on the user's own device and represents the user's AI identity, AI environment, AI capabilities, and trusted connections.

## Architecture

Beta 0.3 migrates the official control plane behind the versioned Teti Network contract. Beta 0.3.5
adds canonical SQLite-backed Relationship state to the Identity, ClientInstance, Presence, and
PublicProfile foundation:

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
- Signed HTTP authentication: separate Ed25519 Identity Root and ClientInstance keys, with Redis
  nonce/replay state. Chatmail/OpenPGP keys remain transport-only.
- Transitional code: the old Worker adapter stays for later retirement, but its legacy heartbeat is
  ID-only and the Desktop Runtime never sends Profile content to it.
- Secure communication: Chatmail relays encrypted Teti-to-Teti messages.

Private keys, Chatmail credentials, private AI state, task content, and conversation history stay on
the user's device. Relationship is now Network-authoritative; the local Chatmail connection record
remains recovery state only. Later Beta 0.3 milestones move RelayBinding and remaining official
state into the durable contract.

The App defaults to `https://network.teti.bot`. Settings has an explicit, default-off “本机 Network
开发环境” switch for `http://127.0.0.1:8788`; the fixed environment selection is persisted locally
and takes effect after restart so one Runtime never mixes credential domains. Existing local
identity adoption uses `TETI_NETWORK_ADOPTION_GRANT` outside loopback development. Network private
seeds are stored separately from `account.json` in the profile credentials directory with
owner-only permissions.

## Public ID Rule

Teti has one canonical public-ID format: `teti_[a-z0-9]{9}`. The card and desktop UI show only the 9-character suffix. Human input is case-insensitive, but local storage and Network protocol messages must contain the lowercase canonical form. Invalid characters are rejected, never removed silently. Network identity and Chatmail delivery address are intentionally independent; adoption preserves both without creating a new Chatmail account.

See [`docs/teti-public-id.md`](docs/teti-public-id.md) for the complete boundary rules and the mandatory pre-deployment KV audit.

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
├── services/discovery-worker/
├── services/network/
├── protocol/
└── docs/
```

## Current Network Migration Boundary

`services/network` contains the thin, backend-independent Network v1 client. Beta 0.3.5 requires
protocol 1, minimum contract revision 6, `identity`, `clientAuthentication`, `publicDirectory`,
`publicProfile`, `presence`, and `relationships`. The App consumes OpenAPI/JSON rather than Hono types. Runtime owns
bootstrap, registration/adoption, signed `/self`, ClientInstance enrollment/revocation, Presence,
revisioned PublicProfile, canonical Relationship commands, and recovery. Confirmed-peer Passport remains Runtime/Chatmail-owned. All
remaining Worker code will be removed before the Beta 0.3 series is finalized.

## Beta MVP 1.0 Architecture

The accepted Beta boundary and staged Runtime convergence are documented in
[`docs/TETI_BETA_MVP_1_0_ARCHITECTURE_FREEZE.md`](docs/TETI_BETA_MVP_1_0_ARCHITECTURE_FREEZE.md).
Task 1 froze the Capability Passport model and introduced the Runtime Host. Task 2 connects it to the
existing lifecycle sidecar so Registry heartbeat, Chatmail polling, peer presence and AI-status sync,
and Codex refresh are Runtime-owned background work. Task 3 makes Desktop a pure Runtime consumer:
its periodic reads update UI snapshots only and never drive Registry, Chatmail, or provider network work.

To regression-test first launch on a development Mac while preserving the
local Chatmail account store, follow
[`docs/testing/TETI_FIRST_LAUNCH_REGRESSION.md`](docs/testing/TETI_FIRST_LAUNCH_REGRESSION.md).
