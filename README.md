# teti-bot

Teti is an open-source AI identity companion for the agent era.

Teti is not a chatbot, an assistant replacement, a social media application, or a centralized AI platform. It is designed as a personal AI identity node that runs on the user's own device and represents the user's AI identity, AI environment, AI capabilities, and trusted connections.

## Architecture

Teti uses two layers:

- Discovery: Cloudflare Worker + KV stores only public identity cards.
- Secure communication: mail.seep.im relays encrypted Teti-to-Teti messages.

Private keys, chat credentials, private profiles, connection graphs, and conversation history stay on the user's device.

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

