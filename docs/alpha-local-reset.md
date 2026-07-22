# Alpha local account reset

This command creates a first-install test environment on the current Mac by permanently deleting Teti's local profile and desktop WebView state.

It intentionally does **not** delete or update:

- the identity stored in Cloudflare Workers KV;
- the account created on `mail.seep.im`;
- mail already retained by the Chatmail relay.

Quit Teti completely before running the command. Otherwise the running desktop sidecar can recreate local files during cleanup.

Preview the affected local paths:

```bash
npm run desktop:alpha-reset-local -- --confirm DELETE_LOCAL_TETI --dry-run
```

Perform the local reset:

```bash
npm run desktop:alpha-reset-local -- --confirm DELETE_LOCAL_TETI
```

The command removes:

- `~/.teti`, including the account record, connection records, creation marker, logs, and local Chatmail account databases;
- macOS WebKit, Application Support, cache, HTTP storage, preferences, saved-state, and container data for the current `bot.teti.app` Bundle Identifier;
- the same UI-container locations for the legacy `im.midimily.teti.desktop` identifier, so an explicit Alpha reset does not leave stale pre-freeze WebView state behind.

The production account and Chatmail profile remain rooted at `~/.teti`; changing the Bundle Identifier does not move or recreate them. The command still refuses to delete a detected real `mail.seep.im` account unless the existing explicit orphan-account override is supplied.

Successful output always reports:

```json
{
  "localOnly": true,
  "remoteChatmailDeleted": false,
  "remoteDiscoveryDeleted": false
}
```

After the command completes, launch Teti again. The desktop application should enter the first-install naming and account-creation flow.
