# Architecture Review

## 1. Does this design preserve privacy by design?

Yes, if Teti clients keep private keys, chat credentials, private profiles, connection graphs, conversations, and agent history local. The discovery Worker accepts and returns only public identity card fields.

## 2. Can KV leakage compromise users?

KV leakage can expose public discovery metadata: Teti ID, chatmail address, public key, public profile, and timestamps. It should not compromise private keys, private conversations, private capability profiles, chat credentials, or trusted connection graphs because those fields are not stored in KV.

## 3. Is the Worker acting as an identity discovery layer instead of a centralized social database?

Yes. The Worker stores short-lived public identity cards with a seven-day TTL. It does not store friend graphs, feeds, private messages, approvals, reputation, or relationship history.

## 4. Is the architecture compatible with future chatmail-based encrypted Teti communication?

Yes. Discovery returns the public key and chatmail address needed to initiate encrypted communication. The actual connection request and private capability exchange can happen later over mail.seep.im using local keys, without expanding KV into a private communication store.

