# Community Search Core

Wallet-independent native core for Monero Enthusiast V1 public catalogs.

The core has no HTTP client and no dependency on Monero, wallet files, wallet
addresses, transaction data, contacts, push tokens, or Matrix plaintext. It:

- verifies Ed25519-signed catalog manifests and SHA-256 payload hashes;
- binds every generation to one policy scope and one complete model contract;
- applies snapshots, deltas, and tombstones in a new SQLite generation;
- derives a USearch index from the verified SQLite data;
- accepts one required primary vector plus at most 16 signed, typed embedding
  chunks per item. Exact search indexes every chunk and collapses the ordered
  matches back to one result per public item using that item's best cosine.
  This lets long titles, bullet groups and description sections remain
  searchable without averaging unrelated sections into one weak vector;
- activates only complete generations through append-only activation markers;
- performs exact local vector search and rejects stale catalogs;
- maintains optional, bounded local-interest vectors with decay, repetition
  caps, safety-action exclusion, model-space reset, and an authenticated
  XChaCha20-Poly1305 storage envelope. The envelope key must come from the
  platform credential store and the blob must never be synced or backed up;
- installs a separately signed, monotonically versioned Common-Query catalog
  into atomic SQLite generations. Exact lookup and prefix suggestions can only
  return entries already present in that local catalog. The signed `weight`
  ranks the reviewed, aggregated most-used terms within a language;
- maintains a second, device-only query cache in SQLite. Every successfully
  submitted query becomes a local suggestion and can reuse its embedding on a
  later search. The cache is fixed at 512 entries by the app runtime, encrypts
  every query and vector with XChaCha20-Poly1305, expires low-use entries after
  180 days and evicts least-used/oldest entries when full. Its random 32-byte
  key must come from Android Keystore, Apple Keychain or the corresponding
  desktop credential store. Metadata and vector ciphertexts are separate:
  prefix suggestions never read or parse the large vector blobs, while an
  exact cache hit authenticates and decrypts only its one vector;
- merges private local suggestions before the downloaded signed suggestions,
  removes duplicates and never uploads typed or submitted queries. A user can
  clear the private cache without deleting either signed catalog.

This crate deliberately accepts an already-produced query vector. Local Harrier
inference is a separate native adapter and must match the model contract exposed
by `CatalogManifest`.

Embedding chunks contain only `source`, `ordinal` and the normalized vector.
They do not duplicate raw listing text. Their source/ordinal pairs must be
unique, every vector is checked against the same pinned model contract, and
the complete set remains covered by the signed catalog payload. Existing
single-vector entries remain valid with an empty chunk list.

The active product feature remains gated by `moneroEnthusiastV1`. Passing these
tests is not permission to enable the feature: Matrix E2EE, moderation,
publication, platform integration, and physical-device acceptance remain
separate release gates.

## Immutable Common-Query publication

`publish_query_catalog` accepts a complete snapshot or delta whose entries
already contain locally generated Harrier embeddings. It validates the frozen
model and normalization contracts, signs the exact payload, and atomically
creates a new immutable generation. It never calls a remote embedding service
and never overwrites an existing output directory. Production `weight` values
must be derived from a reviewed, pre-aggregated frequency table; raw
per-installation search logs are not an input to this tool.

```bash
cargo run --release --bin publish_query_catalog -- \
  --input /srv/community-query-source/queries.json \
  --signing-key-file /run/credentials/community-catalog-ed25519 \
  --review-id review-panama-v1 \
  --policy-version community-policy-v1 \
  --created-at-ms 2000000000000 \
  --expires-at-ms 2000604800000 \
  --output /srv/community-queries/00000000000000000001
```

## Test

```bash
cargo test --release
```
