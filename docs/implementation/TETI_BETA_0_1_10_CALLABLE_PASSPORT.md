# Teti Beta 0.1.10 Callable Passport

Status: Implemented

Application version: 0.1.10

## Outcome

Beta 0.1.10 makes the AI Passport truthfully represent callability. The broad
Agent Observer catalog stays local in Settings. Only an Agent whose controlled
Adapter passed qualification and was registered in the Runtime kernel can
enter Passport.

The existing `teti.ai.status.sync` application message is retained. Its new
payload schema version is 3; no new Teti message or task protocol is created.

## Local schema

`TetiCapabilityPassport` advances from schema 1 to schema 2:

- `resources` retains the existing AI Resource Passport data;
- `agents` contains only `CallablePassportAgent` values;
- `capabilities` contains the curated, deduplicated capability catalog;
- `bindings` identifies which callable Agent supplies each capability.

The public Agent projection contains:

- stable Agent ID, display name, and provider;
- curated capability IDs;
- bounded text input/output modes;
- availability and observation time.

It excludes executable paths, Adapter IDs and revisions, command arguments,
environment, installation/version/process evidence, credentials, prompts,
task bodies, private files, and Artifacts.

## Wire compatibility

| Peer evidence in current Runtime | Outgoing payloads |
| --- | --- |
| Unknown | schema 1, then schema 3 |
| Received schema 1 | schema 1 only |
| Received schema 2 | schema 2 only, with no coarse Agent projection |
| Received schema 3 | schema 3 only |

The first schema-3 payload received at the same `generatedAt` replaces the
schema-1 compatibility snapshot. Schema 1 and schema 2 remain fully validated
and mapped into the normalized remote Passport read model.

Peer capability knowledge is intentionally process-local in 0.1.10. After a
restart, the next enabled sync may send one compatibility pair until the peer
again proves schema 3. This avoids adding identity-storage migration or a new
handshake field before task collaboration is designed.

## Sharing migration

The product retains one `Passport 分享` switch. Settings storage advances to
version 4:

- previous enabled Resource + observed-Agent sharing migrates to enabled
  Resource + Callable Agent + Capability sharing;
- previous disabled state remains fully disabled;
- partial field combinations fail closed;
- confirmed peers remain the only audience.

## Expiry

The existing 30-minute payload TTL is unchanged. When a remote schema-3
snapshot expires, its Agent and Capability availability are normalized to
`stale`; it cannot be presented as currently callable.

## Explicit non-goals

Beta 0.1.10 does not add remote task submission, execution grants, automatic
execution, A2A endpoints, Agent Cards, MCP routing, per-peer policy, or
persistent protocol negotiation. Those remain later milestones.

## Verification

- legacy schema 1 and schema 2 validation and mapping;
- strict schema 3 privacy and reference validation;
- no Observer-only Agent enters local or outgoing Passport;
- Kernel registration is the only callability source;
- unknown-peer compatibility pair and known-peer single-schema sending;
- sharing settings v1/v2/v3 migration to v4;
- remote expiry fallback;
- full TypeScript, Runtime, protocol, UI view-model, and build test suites.
