# Monero Enthusiast V1 API

Fail-closed service adapter for the new Monero Enthusiast publication and
moderation cores.

Security boundaries:

- pseudonymous account credentials are random and stored only as SHA-256
  token hashes in a database separate from publication data;
- unpublished drafts, reports, decision reasons, wording suggestions, and
  appeals are encrypted by `community-publication-core`;
- user routes cannot screen, approve, publish, or extend content;
- the private internal publisher may attach a bounded, validated
  `embeddingChunks` array after approval. Chunk vectors never enter public
  API responses and remain covered by the signed catalog pipeline;
- internal routes require a separate high-entropy token and should be exposed
  only on a private listener/reverse-proxy boundary;
- the internal listener exposes the durable moderation queue and explicit
  acknowledgement; scheduled output contains only generic alert/overdue action
  IDs, never reported text or reporter identity;
- there is no online search, ranking, embedding, wallet, payment, order,
  exchange, or plaintext-chat endpoint;
- public listings receive a maximum 30-day lifetime only after moderated
  publication.
- Matrix user IDs are encrypted in a third, separate contact database and are
  disclosed only after an authenticated recipient explicitly accepts a
  profile-to-profile contact request. Requests have no listing context or
  prepared message, and blocking immediately revokes resolution.
- Community FCM/APNs tokens use a fourth encrypted database. This service and
  token namespace are deliberately separate from the Fast Wallet notification
  Gateway, preventing a Community identity from being joined to a wallet
  assignment at that boundary. Provider payloads are generic.
- Voluntarily selected Matrix message reports use a fifth encrypted database
  and an independent key. Only the exact message the reporter confirmed plus
  minimum Matrix evidence enters that store; ordinary E2EE room history does
  not.
- Moderation decisions create durable generic outcome notices for the affected
  person and reporter. Reasons remain behind authenticated API routes and
  never enter provider push payloads.
- Authenticated query contributions enter a separate SQLite aggregation store.
  It stores a server-salted, query-specific contributor tag rather than the
  Community identity, requires independent contributors before review, expires
  rare unreviewed terms and feeds only moderator-approved embeddings into the
  signed Common-Query delta contract.

This service is not sufficient to enable `moneroEnthusiastV1`. The signed
catalog/runtime packaging, mobile native integration, age/policy UI,
production deployment, and physical-device acceptance remain release gates.

## Run locally

```bash
export ENTHUSIAST_V1_ACCOUNT_DB=/var/lib/monero-enthusiast/accounts.sqlite3
export ENTHUSIAST_V1_PUBLICATION_DB=/var/lib/monero-enthusiast/publication.sqlite3
export ENTHUSIAST_V1_CONTACT_DB=/var/lib/monero-enthusiast/contacts.sqlite3
export ENTHUSIAST_V1_CHAT_REPORT_DB=/var/lib/monero-enthusiast/chat-reports.sqlite3
export ENTHUSIAST_V1_NOTIFICATION_DB=/var/lib/monero-enthusiast/notifications.sqlite3
export ENTHUSIAST_V1_QUERY_CONTRIBUTION_DB=/var/lib/monero-enthusiast/query-contributions.sqlite3
export ENTHUSIAST_V1_STORAGE_KEY="$(openssl rand -hex 32)"
export ENTHUSIAST_V1_CONTACT_KEY="$(openssl rand -hex 32)"
export ENTHUSIAST_V1_CHAT_REPORT_KEY="$(openssl rand -hex 32)"
export ENTHUSIAST_V1_NOTIFICATION_KEY="$(openssl rand -hex 32)"
export ENTHUSIAST_V1_QUERY_PRIVACY_SALT="$(openssl rand -hex 32)"
# Optional; defaults to 3.
export ENTHUSIAST_V1_QUERY_MIN_CONTRIBUTORS=3
export ENTHUSIAST_V1_INTERNAL_TOKEN="$(openssl rand -hex 32)"
export ENTHUSIAST_V1_BIND=127.0.0.1:8090
export ENTHUSIAST_V1_INTERNAL_BIND=127.0.0.1:8091
cargo run --release
```

The internal token is hashed at process start and must never appear in logs.
The process enforces a separate loopback-only internal listener. Production
deployment must not proxy it through the public Community location.

The public API includes authenticated account status and deletion, Matrix
identity provisioning, own-content listing/submission/resubmission/status,
contact request/accept/decline/list/block, notification registration, exact
selected-message reporting, moderation outcomes and free appeals. Search,
ranking, embeddings, wallet operations and general Matrix plaintext remain
absent. `POST /v2/query-contributions` accepts one normalized, filtered,
model-bound term; it is not an online search endpoint.

The loopback-only internal API exposes:

- `GET /internal/v2/query-contributions/candidates`;
- `POST /internal/v2/query-contributions/{queryId}/decision`;
- `GET /internal/v2/query-contributions/catalog-delta`;
- `POST /internal/v2/query-contributions/catalog-acknowledge`.

An operator computes the canonical embedding only after review, approves the
candidate, exports the delta, signs it with
`community-search-core/src/bin/publish_query_catalog.rs`, deploys the immutable
package and acknowledges publication only after that deployment is durable.

## Test

```bash
cargo test --release
```
