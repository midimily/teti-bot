# Teti Public ID Canonical Rule

The canonical public identity format is:

```text
teti_[a-z0-9]{9}
```

The user-facing code printed on `teti.bot` cards is the 9-character suffix only. For example:

```text
Public code: abc123xyz
Canonical ID: teti_abc123xyz
Chatmail address: abc123xyz@mail.seep.im
KV key: teti:teti_abc123xyz
```

## Boundary Rules

- The code contains exactly 9 ASCII lowercase letters or digits. `_`, `-`, whitespace, Unicode letters, and full-width digits are invalid.
- Human input is case-insensitive. Desktop input converts ASCII uppercase letters to lowercase before lookup.
- Stored and transmitted identity values are case-sensitive canonical values and must already be lowercase.
- Account creation derives the canonical ID from the Chatmail address and refuses addresses that cannot produce a canonical ID.
- Registry writes accept only canonical IDs. The Chatmail address local part must equal the 9-character public code.
- Workers KV keys always use the lowercase canonical ID.
- Connection and application protocol `fromTetiId` fields must be canonical. Invalid envelopes are rejected before state changes.
- UI input never deletes invalid characters silently. It keeps the character visible, disables submission, and displays an error.

These rules prevent case-folding collisions, duplicate local relationships, and lookups that differ between the desktop client and Workers KV.

## Pre-deployment KV Audit

Before deploying the stricter Worker, run the read-only audit against the production namespace:

```bash
CLOUDFLARE_ACCOUNT_ID=... \
TETI_KV_NAMESPACE_ID=... \
CLOUDFLARE_API_TOKEN=... \
npm run registry:audit-public-ids
```

The token needs Workers KV Storage Read permission. The command lists only keys with the `teti:` prefix, never reads values, and never writes or deletes data. It exits non-zero when it finds:

- uppercase keys that need migration;
- invalid-length or invalid-character keys;
- keys that collide after lowercase folding.

Do not deploy the strict registry rule until the report has empty `uppercase`, `invalid`, and `collisions` arrays. Migration itself is deliberately outside this audit command and requires a separately reviewed plan because moving a key can change identity ownership semantics.
