# Teti Passport Schema 3 Cutover

Status: Implemented

Application version: 0.1.13 development line

## Decision

`teti.ai.status.sync` sends exactly one schema-3 Callable Passport. It no
longer emits schema 1 or schema 2 and never selects an outgoing schema from
`remoteAiStatus.schemaVersion`.

This cutover is intentionally limited to the AI Passport payload. Application
Envelope v1, Task protocol versions 1/2, lifecycle IPC v1, Chatmail transport,
connection identity, Registry behavior and sharing consent are unchanged.

## Explicit Peer capability

Presence now includes:

```json
{
  "passportSchemaVersions": [3]
}
```

The remote list is validated as a non-empty, unique, bounded list of positive
protocol versions and stored locally in:

```text
~/.teti/peer-protocol-capabilities.json
```

The file contains only canonical Teti IDs, Passport schema versions and the
observation time. It contains no address, App version, credential, token,
Passport content, Task content or Agent result. It is written atomically with
mode `0600`.

Negotiation selects the highest intersection of local and remote supported
versions and sends one payload. The current local supported set is `[3]`:

- unknown Peer: send schema 3 so offline-first delivery does not require a
  synchronous round trip;
- Peer advertises schema 3: send schema 3;
- Peer advertises no common version: send nothing rather than silently remove
  callable data;
- future local schema 4 support: add it to the local set and retain the same
  highest-common-version selector.

App SemVer is not an input to negotiation. It may later be exchanged for
diagnostics or upgrade UI only.

## Receive compatibility and ordering

Schema 1 and schema 2 validators and read-model mappers remain available for
historical messages already queued in Chatmail. Receiving them does not alter
the independently stored Peer capability and does not change what this Runtime
sends.

Remote snapshot replacement follows two rules:

1. a lower schema can never replace an established higher schema;
2. within the same schema, the newest `generatedAt` wins.

Consequently, delayed compatibility messages and out-of-order delivery cannot
remove callable Agents or Capabilities from an established schema-3 Passport.

## Send triggers and recovery

- Runtime Chatmail polling runs immediately on startup; an empty process-local
  send cache causes the current schema-3 Passport to be sent immediately.
- Changing the Passport sharing switch schedules an immediate schema-3 update,
  including a schema-3 disabled/revocation payload.
- A local Resource or Callable Passport content change changes the send
  fingerprint and is sent on the next three-second Runtime poll rather than
  waiting for the ten-minute refresh interval.
- An explicit Peer capability change invalidates the per-Peer send fingerprint
  and is applied on the same poll.
- An unchanged payload is retried after ten minutes, providing recovery if a
  previously accepted transport message is lost.

## Regression coverage

Automated tests cover:

- one schema-3 payload with no schema-1 duplicate;
- explicit Presence capability exchange;
- independent file persistence across Runtime restart;
- dropped Passport retry without legacy fallback;
- out-of-order schema-3 generations;
- delayed newer-dated schema-1 data after schema 3;
- Runtime restart immediate schema-3 resend;
- incompatible explicit version lists producing no speculative downgrade.
