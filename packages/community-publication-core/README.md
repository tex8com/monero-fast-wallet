# Community Publication Core

Durable, wallet-independent publication and moderation state machine for
Monero Enthusiast V1.

It implements:

- immutable public content revisions;
- mandatory screening and human-review states;
- encrypted report and appeal text;
- append-only moderation audit events;
- a durable priority queue, moderator acknowledgement, one generic initial
  alert and one idempotent four-hour overdue escalation;
- explicit approve/reject/hide/remove/reinstate decisions;
- listing publication for at most 30 days;
- bounded multi-vector publication: an approved revision keeps one required
  primary Harrier vector and may store at most 16 typed title, summary,
  bullet or description chunks. Chunks follow the same normalization/model
  checks and flow into the separately signed local catalog;
- one idempotent reminder within the last 24 hours;
- expiry tombstones and fully re-moderated republication.

It intentionally does not implement payments, prices, orders, matching,
checkout, escrow, custody, exchange, wallet data, online search, Matrix
plaintext, or push delivery. A service adapter must authenticate users and
moderators, deliver only generic notification text, and feed the resulting
published records into the separately signed catalog pipeline.

## Test

```bash
cargo test --release
```

## Isolated catalog publication

`publish_catalog` reads the encrypted publication database and creates one
immutable signed snapshot directory. Secret files must contain one 32-byte
hexadecimal key and use mode `0600` or stricter on Unix. The command never
overwrites an existing sequence directory.

The authenticated internal publish request accepts optional
`embeddingChunks`. Each entry contains `source`, `ordinal` and `embedding`;
public user routes still cannot supply or publish embeddings.

```bash
cargo run --release --bin publish_catalog -- \
  --publication-db /var/lib/monero-enthusiast/publication.sqlite3 \
  --storage-key-file /run/credentials/community-storage-key \
  --signing-key-file /run/credentials/community-catalog-ed25519 \
  --scope pa-v1 \
  --review-id review-panama-v1 \
  --policy-version community-policy-v1 \
  --sequence 1 \
  --created-at-ms 2000000000000 \
  --expires-at-ms 2000604800000 \
  --output /srv/community-catalog/00000000000000000001
```
