# Teti Discovery Registry V1

Native Cloudflare Worker for discovering public Teti identities.

## KV Binding

Create a KV namespace and bind it as `TETI`.

```sh
wrangler kv namespace create TETI
wrangler kv namespace create TETI --preview
```

Then update `wrangler.toml` with the generated namespace IDs.

## Data Model

KV key:

```text
teti:teti_{9-character-public-code}
```

TTL:

```text
604800 seconds
```

Stored value:

```json
{
  "version": 1,
  "id": "teti_a83kd9x2q",
  "address": "a83kd9x2q@mail.seep.im",
  "displayName": "Milo",
  "publicKey": "chatmail-public-key",
  "publicProfile": {
    "platform": "macOS",
    "category": ["developer", "designer"],
    "aiEnvironment": ["Claude Code", "Cursor"]
  },
  "createdAt": "2026-07-10T00:00:00.000Z",
  "updatedAt": "2026-07-10T00:00:00.000Z"
}
```

## API

All responses use:

```json
{
  "success": true,
  "data": {}
}
```

or:

```json
{
  "success": false,
  "error": "ERROR_CODE",
  "message": "Human readable message"
}
```

### POST /register

Registers a new public identity card.

Request:

```json
{
  "version": 1,
  "id": "teti_a83kd9x2q",
  "address": "a83kd9x2q@mail.seep.im",
  "displayName": "Milo",
  "publicKey": "chatmail-public-key",
  "publicProfile": {
    "platform": "macOS",
    "category": ["developer"],
    "aiEnvironment": ["Claude Code"]
  }
}
```

Rules:

- `id` must match `teti_[a-z0-9]{9}` exactly.
- `address` must be lowercase, use `mail.seep.im`, and its 9-character local part must match the ID suffix.
- `displayName`, when present, must contain 1 to 10 Unicode characters.
- `publicKey` must be a non-empty string and must not be `undefined`.
- Request JSON must be 16 KiB or smaller.
- Duplicate registrations return `409`.

The Worker adds `createdAt` and `updatedAt`.

### POST /heartbeat

Refreshes an existing identity card without replacing the public profile.

Request:

```json
{
  "id": "teti_a83kd9x2q"
}
```

The Worker updates only `updatedAt` and refreshes the TTL.

### GET /discover

Returns up to 50 public identity cards.

### GET /profile/:id

Returns one public identity card.

The profile lookup accepts ASCII uppercase input for user-facing convenience and folds it to the lowercase canonical key. Registry writes remain strict and reject non-canonical casing.

## Required Pre-deployment Audit

Run the read-only KV key audit before deploying changes to the ID validation rule:

```bash
CLOUDFLARE_ACCOUNT_ID=... \
TETI_KV_NAMESPACE_ID=... \
CLOUDFLARE_API_TOKEN=... \
npm run registry:audit-public-ids
```

Deployment is blocked when the report contains uppercase, invalid, or case-folding collision keys. See [`docs/teti-public-id.md`](../../docs/teti-public-id.md) for the migration boundary.

## Future Compatibility

The validation and registration path is structured so future Ed25519 verification can add `signature` and `timestamp` without moving route logic into a framework.
