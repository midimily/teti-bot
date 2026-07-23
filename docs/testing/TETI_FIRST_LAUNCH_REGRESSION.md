# Teti first-launch regression reset

Use this development-only command to return the current Mac to Teti onboarding
without deleting the local Delta Chat account store.

Quit Teti first, then preview the cleanup:

```bash
npm run desktop:reset-onboarding -- \
  --confirm RESET_TETI_ONBOARDING \
  --dry-run
```

Run the local reset:

```bash
npm run desktop:reset-onboarding -- \
  --confirm RESET_TETI_ONBOARDING
```

The command removes:

- the active local Teti account mapping;
- connection and Passport-sharing state;
- lifecycle markers, diagnostics, and Teti Desktop logs;
- current and legacy macOS WebView/application state.

It preserves `~/.teti/credentials/chatmail-accounts`. A later onboarding run
can therefore leave old local relay accounts in that store, but it creates and
selects a new Chatmail identity and a new Teti ID.

## Optional Registry KV cleanup

The production Registry does not expose an unauthenticated public delete
endpoint. That would allow one Teti to delete another Teti's identity.

Maintainers with Cloudflare KV edit permission can delete the current local
Teti ID before local cleanup:

```bash
CLOUDFLARE_ACCOUNT_ID=... \
TETI_KV_NAMESPACE_ID=... \
CLOUDFLARE_API_TOKEN=... \
npm run desktop:reset-onboarding -- \
  --confirm RESET_TETI_ONBOARDING \
  --delete-registry \
  --registry-confirm DELETE_TETI_ONBOARDING_AND_REGISTRY
```

`CLOUDFLARE_API_TOKEN` needs Workers KV Storage Edit permission. Registry
deletion runs first. If it fails, the local identity is retained so the command
can be retried safely.

Without this option, the old public Registry card remains until its existing
TTL expires. It does not block onboarding because the new Chatmail identity
produces a new canonical Teti ID.
