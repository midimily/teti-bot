# Teti Beta 0.2.9 — Teti Host Agent Delegation Foundation

Status: implemented; automated gates pass pending the full repository and
physical dual-Mac release matrix

Application version: `0.2.9`

## Outcome

Beta 0.2.9 establishes the first real Host/Child product structure. Teti owns a
small deterministic plan, consent, budgets, Workspace authority, execution
state, audit and final Artifact. Codex, CodeBuddy and Osaurus remain bounded
local Child Agents that execute one step each.

This release does not contain an autonomous Planner. The local user explicitly
chooses an ordered sequence before execution starts.

```text
Incoming long-horizon Task
  -> local user selects 1..4 Child steps
  -> Child step 1
  -> Child step 2
  -> ...
  -> Teti Host deterministic Artifact aggregation
  -> existing Task-v6 status and Artifact delivery
```

## Deterministic DelegationPlan

The receiver-local schema records:

- `planId`, `taskId`, phase and timestamps;
- fixed `delegationDepth: 1`;
- `plannerMode: disabled` and `source: explicit_user`;
- one to four linear `child_execution` steps;
- one mandatory final `artifact_aggregation` step;
- bounded local audit and Artifact provenance.

Every Child step freezes:

- Child Agent, Connector, Capability and `AgentResourceBinding` identity;
- dependency on the immediately preceding step;
- maximum input bytes, maximum text output bytes and timeout;
- starting Workspace revision and an access subset;
- `remoteAgentAccess: deny`;
- execution Task ID, state, timestamps, safe error and produced Artifact IDs.

The limits are four Child calls, eight provenance records, 64 audit events,
24 KiB of bounded text input, 56 KiB of text output and 15 minutes per Child
step. A Connector's stricter timeout or output limit wins. Existing Task image
count and attachment limits remain authoritative for image output.

## Target selection and authority

The Host publishes a receiver-local target catalog from registered, ready
Connectors. The UI sends only exact `childAgentId`, `connectorId` and
`capabilityId` selections through the local lifecycle bridge. The Runtime
resolves those selections to the current local Resource binding and freezes the
result. Endpoint, model, executable, local path, token, peer identity and
Transport fields are not accepted.

Before each step, the Host resolves the same triple again and checks that:

- Resource binding is unchanged;
- the Connector still supports the frozen budget;
- the step Workspace access is still a subset of the Task grant;
- the continuation lease has not expired;
- the target still accepts text and any supplied images.

`none` and `bounded_context` Workspace policies receive `read` only. A
`snapshot` Child can receive only the already-granted `read`, `write` and/or
`create_artifact` subset. Every step gets its own derived execution Task ID,
Execution Handle, one-time Execution Authority, timeout/deadline and epoch.

The Connector boundary continues to exclude Passport, Chatmail and peer
identity, so a Child has no Teti mechanism for recursively delegating or
contacting a remote Agent. Provider network use intrinsic to an approved Child
remains governed by that Connector's existing `agent_managed` network policy;
`remoteAgentAccess: deny` specifically forbids Teti Agent-to-Agent delegation.

## Step execution and context

Step one receives the original Task text. Later steps receive the original goal
plus prior append-only Artifact text through the existing bounded stage
instruction. Original input images are passed only to a target whose Connector
declares image input. No Child can change the frozen order or add a step.

Successful output becomes an intermediate Artifact and a Workspace-bound Host
checkpoint. Snapshot writers must advance exactly one revision; read-only or
no-Workspace execution must not change it. A revision conflict discards the
output and fails the plan.

Failure, cancellation, interruption, expiry, target change or budget violation
stops the frozen sequence. Teti never auto-selects the next Child, retries a
side-effecting stage or silently creates a replacement plan.

## Artifact aggregation and provenance

Every intermediate Artifact provenance record contains:

- producing step;
- Child Agent and Connector;
- local Resource binding;
- committed Workspace revision;
- creation time and `intermediate` role.

After all Child steps complete, the Host runs a deterministic
`ordered_artifact_bundle` operation. It concatenates bounded text in frozen step
order and includes at most four unique already-verified image references. This
operation does not invoke a model. The final Artifact identifies `teti_host`,
the Host aggregation Resource and the final Workspace revision.

Intermediate Artifacts are retained and delivered; the final Artifact never
overwrites them.

## Planner seam

`DelegationPlanner` exists so a future version can introduce a separately
reviewed planning policy. `DisabledDelegationPlanner.enabled` is false and
`plan()` always returns `DELEGATION_PLANNER_DISABLED`. No current execution path
calls a Planner, guesses a Child from task text or expands the depth beyond one.

## Protocol and persistence

The Task transport store advances to schema 4 and migrates schema 2/3 local
stores in place. `delegationPlan` is valid only on an incoming long-horizon Task
with a local Workspace binding. Store validation rejects expanded Workspace
authority and orphaned provenance.

Task protocol remains v6. DelegationPlan, local targets, Resource bindings,
budgets and audit do not enter Task, Passport, Compute Offer, Chatmail or the
requester's record. Existing minimized long-horizon progress and Artifact
messages are reused.

The production `/release-policy` floor remains `0.2.8`. Shipping a 0.2.9 binary
does not itself raise that remote floor or lock supported 0.2.8 clients; release
promotion remains a separate operator action.

## Desktop behavior

For an incoming pending long-horizon Task, the detail view offers an explicit
`Teti Host 委派计划` editor alongside the existing single-Child allow-once path.
The user can add, remove and select up to four ordered steps and inspect each
Resource, Workspace policy and timeout before approval.

During execution, the detail view shows the frozen Child steps, Host aggregation
step, state, per-step budget, Workspace revision, provenance-enriched Artifact
titles and receiver-local Host audit. It truthfully labels the Planner as
disabled. Native selects and buttons retain keyboard and screen-reader labels.

## Automated release gates

Automated coverage proves:

- a plan is depth one, linear, bounded and ends with Host aggregation;
- the autonomous Planner fails closed;
- more than four Child steps, contract-field injection and authority expansion
  are rejected;
- the local lifecycle bridge accepts only exact explicit selections;
- Osaurus-like analysis followed by a Codex-like second step executes in frozen
  order and passes the first Artifact as bounded context;
- each step receives its own Capability, Workspace subset and deadline-bound
  Execution Authority;
- every intermediate and final Artifact records the correct producer, Resource
  and Workspace revision;
- final aggregation retains ordered intermediate results;
- a failed first step leaves the next step pending and never auto-switches;
- the requester completes through normal Task-v6 messages and never receives
  the receiver's DelegationPlan.

Physical sign-off still requires real Codex/CodeBuddy staged execution and a
two-Mac delegated Task. Osaurus execution remains subject to the existing
Insights request-body retention and invalid-signature blockers. The accepted
0.1.15 multi-image delivery defect is unchanged and must be reviewed separately.
