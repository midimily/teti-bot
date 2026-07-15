# Teti Auto Onboarding

Teti V1 follows the chatmail onboarding model:

```text
User enters display name
  -> Teti starts deltachat-rpc-server
  -> chatmail/core creates a local account container
  -> chatmail/core configures chatmail transport from DCACCOUNT
  -> chatmail/core owns credentials, keys, encryption, and local database
  -> Teti extracts public identity
  -> Teti registers public discovery profile
```

The user-facing input is:

```ts
{
  name: "Alex"
}
```

The resulting Teti account contains public/local metadata only:

```ts
{
  address: "xxxxxxxxx@mail.seep.im",
  displayName: "Alex",
  publicKey: "...",
  publicProfile: {
    platform: "macOS",
    category: ["developer"],
    aiEnvironment: ["Claude Code", "Cursor"]
  }
}
```

## Provisioning Boundary

The implementation lives in:

- `integrations/chatmail/provisioner.ts`
- `core/account/manager.ts`

`ChatmailProvisioner.createIdentity(displayName)` returns:

```ts
{
  accountId: number,
  address: string,
  displayName: string,
  publicKey?: string,
  fingerprint?: string
}
```

It does not return or store passwords.

## RPC Flow

The default provisioning QR is:

```text
dcaccount:mail.seep.im
```

The RPC sequence is:

```text
add_account
  -> set_config(accountId, "displayname", displayName)
  -> add_transport_from_qr(accountId, "dcaccount:mail.seep.im")
  -> start_io(accountId)
  -> get_account_info(accountId)
  -> make_vcard(accountId, [1])
```

`add_transport_from_qr` delegates chatmail account provisioning to chatmail/core. Teti never creates a password and never handles SMTP/IMAP credentials.

## Security Rules

Teti must never expose or persist:

- chatmail password
- SMTP password
- IMAP password
- private key
- chatmail SQLite database path
- encryption material

Those belong to the local chatmail/core runtime.

Teti may persist:

- chatmail account id
- chatmail address
- display name
- public key
- Teti public profile
- discovery registration metadata

## Current Limits

The unit tests verify the provisioning orchestration without exposing credentials. The runtime integration test verifies that Teti can start `deltachat-rpc-server` and call account lifecycle RPCs.

The first full real onboarding still requires relay connectivity for `mail.seep.im` from chatmail/core during `add_transport_from_qr`.
