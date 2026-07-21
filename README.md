# teti-bot

Teti is an open-source AI identity companion for the agent era.

Teti is not a chatbot, an assistant replacement, a social media application, or a centralized AI platform. It is designed as a personal AI identity node that runs on the user's own device and represents the user's AI identity, AI environment, AI capabilities, and trusted connections.

## Architecture

Teti uses two layers:

- Discovery: Cloudflare Worker + KV stores only public identity cards.
- Secure communication: mail.seep.im relays encrypted Teti-to-Teti messages.

Private keys, chat credentials, private profiles, connection graphs, and conversation history stay on the user's device.

## Public ID Rule

Teti has one canonical public-ID format: `teti_[a-z0-9]{9}`. The card and desktop UI show only the 9-character suffix. Human input is case-insensitive, but local storage, Workers KV keys, registry writes, and protocol messages must contain the lowercase canonical form. Invalid characters are rejected, never removed silently.

See [`docs/teti-public-id.md`](docs/teti-public-id.md) for the complete boundary rules and the mandatory pre-deployment KV audit.

Production Desktop instances send a discovery activity heartbeat at startup and approximately every five minutes while running. This registry signal is intentionally separate from Chatmail connection heartbeats; see [`docs/teti-discovery.md`](docs/teti-discovery.md#desktop-activity-heartbeat).

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
├── protocol/
└── docs/
```

## Current Component

The first implemented network component is `services/discovery-worker`, a native Cloudflare Worker that provides Teti Discovery Registry V1.

## Beta MVP 1.0 Architecture

The accepted Beta boundary and staged Runtime convergence are documented in
[`docs/TETI_BETA_MVP_1_0_ARCHITECTURE_FREEZE.md`](docs/TETI_BETA_MVP_1_0_ARCHITECTURE_FREEZE.md).
Task 1 froze the Capability Passport model and introduced the Runtime Host. Task 2 connects it to the
existing lifecycle sidecar so Registry heartbeat, Chatmail polling, peer presence and AI-status sync,
and Codex refresh are Runtime-owned background work. Task 3 makes Desktop a pure Runtime consumer:
its periodic reads update UI snapshots only and never drive Registry, Chatmail, or provider network work.
