# Teti Discovery Service

The discovery service is the public lookup layer for Teti identities. It talks to the Cloudflare Discovery Registry and returns only public identity data:

- Teti id
- chatmail address
- public key, when available
- public profile

It never requests or stores private keys, chatmail credentials, database paths, or message history.

## API

```ts
import {
  TetiDiscoveryService,
  matchTetis
} from "./services/discovery/client.ts";

const discovery = new TetiDiscoveryService();

const tetis = await discovery.discoverTetis({ limit: 20 });
const profile = await discovery.getTetiProfile("teti_alex");

const matches = matchTetis({
  localProfile: {
    platform: "macOS",
    aiEnvironment: ["Claude Code", "Cursor"]
  },
  remoteTetis: tetis
});
```

## Compatibility Matching

Matching is deterministic in V1. It scores shared platform, shared AI environments, shared categories, and whether the remote Teti has a public key. It does not use an AI model.

## Connection Preparation

`prepareConnectionRequest()` creates a public request draft containing the local and remote public identifiers. It does not send chatmail messages. The future connection protocol will pass this draft to the chatmail messaging layer.
