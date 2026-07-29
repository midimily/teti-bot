# Teti Beta 0.2.6 — Child Agent Memory v1

Status: implementation landed; automated verification is part of the release
gate and physical dual-Mac acceptance remains pending.

## Goal and ownership

Beta 0.2.6 adds controlled, auditable long-term context for local Child Agents.
Teti owns the store, authorization, selection, injection, deletion, expiry and
export lifecycle. Codex, CodeBuddy and Osaurus vendor-native Memory remain
disabled or unused; this version does not delegate Memory policy to a provider.

This distinction is intentional: a provider-specific Connector still receives
only the final bounded execution input. It cannot query the Memory database,
see Memory authorization objects, or write records.

## Scope policy

- `task`: allowed by default only as the current request context during one
  execution. It is not written to the durable Memory store.
- `workspace`: disabled by default. The local user must authorize an exact
  `workspaceId + childAgentId`; only a `durable_collaboration` Workspace may be
  saved or retrieved.
- `child_agent`: disabled by default. The local user must authorize the exact
  Child Agent independently.
- Peer-shared Memory is not implemented. There is no peer API, Passport field,
  Task field or Chatmail payload for Memory.

Long-term writes use a two-step local action: enable the exact scope, then press
`保存结果` on a completed incoming Task. Task completion, peer text, Runtime
polling and Agent output never write automatically. Only the latest verified
text Artifact from the receiver-local execution is eligible.

## Record and persistence contract

The private schema-v1 record contains `memoryId`, `scope`, `workspaceId`,
`childAgentId`, `sourceTaskId`, `sourcePeerId`, `contentDigest`, `createdAt`,
`expiresAt`, and explicit `provenance`, plus the bounded local content. Current
provenance is `task_artifact_user_saved` by `local_user`, bound to the source
Artifact and authorization time.

The Store-v2 file is atomically replaced and owner-only (`0600`). Records expire
after 90 days, with a hard bounded store of 32 records and 64 authorization
entries. The Settings UI shows source Task, source Peer, Child, scope, preview
and expiry, and provides local delete and JSON export actions. Export files are
also `0600` below the receiver's private Store-v2 export directory.
Lifecycle reads and save responses expose only bounded previews and provenance
to the WebView; full record content remains in the Sidecar store and the Host's
bounded execution-input path.

There is deliberately no independent cached/vector index in v1. Every query
reads the authoritative record store, so deletion, expiry or authorization
revocation takes effect on the next selection without an index lag window.

## Bounded retrieval and injection

For each execution Teti queries only the exact `childAgentId`. Workspace records
must also match the exact execution Workspace and its still-active
authorization. Teti selects newest eligible records with all of these bounds:

- at most 4 records;
- at most 8 KiB total injected content;
- at most 4 KiB per stored record.

The Host JSON-encodes each selected record inside a
`TETI_CHILD_MEMORY_V1` reference envelope, labels it as historical reference
data rather than instructions, and appends the current Task separately. Memory
never enters Connector context, ExecutionAuthority, Passport, Task, Chatmail or
peer identity state. If the Memory selection fails validation, execution fails
closed before a Transport starts.

## Peer Passport flash correction

The remaining periodic flash did not originate in Peer Passport polling. The
Task controller refreshed every two seconds and notified the global renderer
even when only `generatedAt` changed; the shell then replaced the complete DOM,
including an expanded Peer Passport accordion.

Task polling now compares a UI-semantic projection. Snapshot timestamps,
non-visible expiry/update timestamps, hidden selected-Task details, execution
lease/provider/checkpoint fields and other non-presentational churn do not
notify the shell. Visible task counts, states, approvals, progress, Artifacts
and attachment readiness still render. A dedicated scheduled-poll regression
test verifies that timestamp-only refresh does not rebuild an unrelated
expanded Peer Passport.

## Release gates

Automated gates cover:

1. Durable scopes are disabled by default and false/missing local confirmation
   is rejected before the Memory service is called.
2. A peer-originated Task cannot write Memory merely by completing or by asking
   for a write in its prompt.
3. Workspace records do not cross Workspace boundaries and no record crosses a
   Child Agent boundary.
4. Injection remains at or below 4 records and 8 KiB, while each stored record
   remains at or below 4 KiB.
5. Delete, expiry and authorization revocation immediately remove a record from
   future retrieval.
6. Provenance is visible; private export is readable by the owner only.
7. Connector context, Task, Passport and Chatmail schemas contain no Memory
   database, record, local export path or authorization object.
8. Timestamp-only Task and Passport polling cannot replace the expanded Peer
   Passport DOM.

Physical release sign-off still includes UI/Sidecar restart, two-Mac execution,
Memory deletion/export interaction, the inherited multi-image review, and the
existing fail-closed Osaurus Insights/signature blockers.
