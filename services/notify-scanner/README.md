# Notify Scanner

`notify-scanner` is the server-side Fast Receive module. It is separate from
normal wallet sync: standard wallets still use Monero RPC or optimized Cuprate
gRPC without uploading a private view key.

The module accepts opt-in watch records for isolated Fast Receive identities:

- public address
- private view key for that isolated identity
- network
- restore height
- optional anonymous Tex8 push subscription id

It never accepts a seed, private spend key, or main-wallet private view key.

## API

```text
GET    /
GET    /healthz
POST   /v1/fast-receive/watch
GET    /v1/fast-receive/watch/:identity_id
DELETE /v1/fast-receive/watch/:identity_id
GET    /v1/fast-receive/watch/:identity_id/matches
POST   /v1/fast-receive/matches
POST   /v1/fast-receive/key-images/status
```

`GET /` is a public human-readable service page with GitHub and documentation
links. It does not expose watches, matches, keys, tokens, or node internals.

`POST /v1/fast-receive/watch` body:

```json
{
  "identity_id": "fast-receive-0-20260701T120000",
  "address": "9...",
  "private_view_key": "64 hex chars",
  "network": "stagenet",
  "restore_height": 123456,
  "device_id": "optional anonymous push subscription id"
}
```

`device_id` is the anonymous `subscriptionId` returned by the shared Tex8
mobile push service. It is not an FCM/APNs token. The legacy `push_token`
field remains readable for storage compatibility but is never used for
delivery.

Every watch-management request must send a unique, randomly generated
32-byte-or-stronger capability:

```text
Authorization: Bearer <per-watch-management-capability>
```

The scanner stores only a domain-separated SHA-256 hash of that capability.
Creating a new watch binds the capability to the identity; reading, updating,
deleting, listing matches, and checking key images all require the same
capability. A capability for one watch cannot manage another watch. There is
no unauthenticated compatibility mode.

The application limits each hashed capability to 120 requests per minute and
rejects request bodies larger than 96 KiB before JSON parsing. The production
nginx configuration adds an independent per-IP request limit, connection
limit, body limit, and proxy timeouts. These defaults are a safety boundary,
not a substitute for deployment monitoring and load testing.
The encrypted store accepts at most 100,000 watches and retains at most 4,096
opaque matches plus 4,096 key-image status records per watch, pruning the
oldest privacy records first.

`GET /v1/fast-receive/watch/:identity_id` returns only non-secret scanner
state for that watch record. Mobile clients use it after node/server switches
to verify whether the active Tex8 scanner already has the hosted private view
key for that isolated Fast Receive identity. `notifications_enabled` is true
only when that watch carries an anonymous Tex8 push subscription id.

`POST /v1/fast-receive/matches` is the internal scanner write path used after a
block output matches a registered hosted identity. Transaction fields are used
only long enough to derive a one-way event fingerprint:

```json
{
  "identity_id": "fast-receive-0-20260701T120000",
  "tx_id": "64 hex chars",
  "output_index": 3
}
```

The raw transaction id and output index are immediately hashed into an opaque
`evt_...` id and discarded. Amounts, transaction ids, output indexes, block
timestamps, addresses, and key images are not stored in match records or
returned by the match API. Unknown detail fields are rejected. Processing the
same output twice still updates the same opaque event instead of creating a
duplicate.

This internal route is disabled unless
`NOTIFY_SCANNER_INTERNAL_AUTH_TOKEN` is configured. Its token is separate from
all per-watch capabilities and must never be distributed to apps.
The production reverse proxy also returns `404` for this exact route, so match
injection is reachable only through the loopback listener.

`POST /v1/fast-receive/key-images/status` is the fast spend-reconciliation
query. The app derives key images locally and asks the server for known spent
state:

```json
{
  "identity_id": "fast-receive-0-20260701T120000",
  "key_images": ["64 hex chars"]
}
```

If `NOTIFY_SCANNER_CUPRATE_RPC_ENDPOINT` is configured, the API checks
Cuprate `/is_key_image_spent`, stamps the result with the current daemon
height from `/get_info`, persists it in the key-image status table, and
returns `unspent` or `spent`. Cuprate's mempool-spent status is returned as
`spent` because the output must not be selected for a new transaction while a
spend is pending. Without a configured Cuprate RPC source, unknown key images
return `unknown` from the local cache.

## Runtime

```sh
export NOTIFY_SCANNER_STORAGE_KEY=<32-byte hex or base64 key>
export NOTIFY_SCANNER_WATCH_DB=./notify-scanner-watch.json.enc
export NOTIFY_SCANNER_BIND=127.0.0.1:8087
# Preferred on the node host: direct, read-only access to Cuprate's ScanPack.
export NOTIFY_SCANNER_SCANPACK_DIRECTORY=/var/lib/cuprate/wallet-scan-cache-100k
export NOTIFY_SCANNER_SCANPACK_NETWORK=mainnet
export NOTIFY_SCANNER_SCANPACK_REFRESH_MS=10000
export NOTIFY_SCANNER_DERIVATION_WORKERS=12
# gRPC remains the block-source fallback when no ScanPack directory is set.
export NOTIFY_SCANNER_CUPRATE_GRPC_ENDPOINT=127.0.0.1:18091
# RPC is still used for the mempool and key-image spent status.
export NOTIFY_SCANNER_CUPRATE_RPC_ENDPOINT=xmr.tex8.com:18089
export NOTIFY_SCANNER_INTERNAL_AUTH_TOKEN=<dedicated-32-byte-or-stronger-secret>
export NOTIFY_SCANNER_PUSH_ENDPOINT=http://127.0.0.1:4020/api/v1/internal/mobile/fast-wallet-push-events
export NOTIFY_SCANNER_PUSH_AUTH_TOKEN=<scanner-to-cloud-secret>
export NOTIFY_SCANNER_PUSH_TENANT_ID=monero-wallet
export NOTIFY_SCANNER_PUSH_SHOP_ID=monero-wallet
export NOTIFY_SCANNER_PUSH_APP_ID=monero-wallet
export NOTIFY_SCANNER_PUSH_TIMEOUT_MS=10000
# Optional: enables the separately authenticated test-only payment signal route.
# It is intentionally not the scanner API token.
export NOTIFY_SCANNER_TEST_AUTH_TOKEN=<dedicated-test-only-secret>
ops/notify-scanner/build-epyc.sh
./build/notify-scanner-epyc/cargo-target/release/notify-scanner
```

When `NOTIFY_SCANNER_SCANPACK_DIRECTORY` is set, block scanning does not call
Cuprate gRPC. Cuprate is the sole ScanPack writer and the scanner opens only
regular, non-symlinked, non-group/world-writable `MWSPACK1` files with
read-only descriptors. The systemd unit gives the scanner an explicit
read-only mount view of the cache and no write permission to Cuprate data.
Mempool snapshots and key-image status remain small RPC calls because ScanPack
contains confirmed block data only.

The EPYC build authenticates the pinned Dalek patch tree before compiling. It
uses a portable x86-64 binary with runtime AVX-512 IFMA/AVX2 selection rather
than assuming every deployment CPU supports AVX-512.

The scanner database is encrypted at rest with XChaCha20-Poly1305. It stores
watch records, opaque detection events, and key-image status records in one sealed
JSON file. Writes are atomic and durable: the current snapshot and an
authenticated `.previous` recovery snapshot are kept with file mode `0600` in
a directory with mode `0700`. A corrupt current snapshot is recovered only
from a backup that authenticates with the active key.

Use the storage administration binary while the scanner service is stopped.
Keys are read only from environment variables so they do not appear in command
history or process arguments:

```sh
# Verify the active database.
NOTIFY_SCANNER_STORAGE_KEY="$ACTIVE_KEY" \
  cargo run --locked --bin storage_admin -- verify "$WATCH_DB"

# Create and authenticate an encrypted off-host backup.
NOTIFY_SCANNER_STORAGE_KEY="$ACTIVE_KEY" \
  cargo run --locked --bin storage_admin -- backup "$WATCH_DB" "$BACKUP_PATH"

# Restore only after authenticating the encrypted backup.
NOTIFY_SCANNER_STORAGE_KEY="$ACTIVE_KEY" \
  cargo run --locked --bin storage_admin -- restore "$BACKUP_PATH" "$WATCH_DB"

# Rotate both the primary and recovery snapshots to a new key.
NOTIFY_SCANNER_OLD_STORAGE_KEY="$ACTIVE_KEY" \
NOTIFY_SCANNER_NEW_STORAGE_KEY="$NEW_KEY" \
  cargo run --locked --bin storage_admin -- rotate-key "$WATCH_DB"
```

Keep at least one tested backup on a separate encrypted host and one offline
copy. After a restore, start the scanner without public ingress first, verify
health and watch counts, then re-enable ingress. Never delete the old key until
the new primary, `.previous`, and off-host backup have all passed `verify`.

If either `NOTIFY_SCANNER_SCANPACK_DIRECTORY` or
`NOTIFY_SCANNER_CUPRATE_GRPC_ENDPOINT` is set, the service starts the
background block scanner. ScanPack takes precedence. If
`NOTIFY_SCANNER_CUPRATE_RPC_ENDPOINT` is also set, the same loop scans one
txpool snapshot per network for early pending hints.

Opening an existing database rewrites it immediately to the current schema.
Legacy raw match ids become one-way `evt_...` fingerprints, and old transaction,
output, amount, and block fields are omitted from the newly sealed file.

Optional scanner tuning:

```sh
export NOTIFY_SCANNER_BLOCK_SCAN_MAX_BLOCKS=25
export NOTIFY_SCANNER_BLOCK_SCAN_INTERVAL_MS=10000
export NOTIFY_SCANNER_CUPRATE_GRPC_CHUNK_BLOCKS=200
```

The crate decodes Cuprate `GetBlocksResponse` Epee payloads into Monero blocks
and transactions, then builds `monero-rpc` `ScannableBlock` values for hosted
view-key scanning. Ownership is checked without reading or retaining the
decoded amount from the matched output. The crate also checks key-image spent
state through Cuprate RPC for fast spend reconciliation. The push dispatcher
sends the same generic `incoming_transaction` signal to Tex8 Cloud after a new
mempool match, confirmation, drop, or reorg.
It marks a notification as sent only after the cloud endpoint accepts it and
retries failures on the next scanner pass.

The app sends the anonymous cloud `subscriptionId` as `device_id` during watch
registration. The scanner never needs an FCM token. Legacy `push_token` values
are intentionally ignored by the dispatcher. The v2 cloud event contains only
an opaque event id, anonymous subscription id, app routing scope, and the
generic signal. It has no optional detail mode. Addresses and private view keys
never leave the encrypted scanner database through the push path.

### End-to-end Fast Receive test signal

When `NOTIFY_SCANNER_TEST_AUTH_TOKEN` is set, an operator can test the exact
same notification delivery route without fabricating an on-chain payment:

```sh
curl --fail-with-body \
  -H "authorization: Bearer $NOTIFY_SCANNER_TEST_AUTH_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"identity_id":"fast-receive-identity"}' \
  https://xmr.tex8.com/v1/fast-receive/test/incoming-transaction
```

The route is absent unless its dedicated token is configured. It does **not**
accept a transaction id, amount, address, seed, spend key, or view key. It
creates one opaque test event for the existing identity and delivers the same
generic `incoming_transaction` notification that an actual scanner match uses.

## Scanner Worker

The crate now contains the first production-safe scanner worker boundary:

- `BlockSource` supplies ordered blocks from a local read-only ScanPack,
  Cuprate gRPC, or a test source.
- `OutputMatcher` owns Monero output detection for a watch record.
- `ScannerWorker` reads registered watch records, processes blocks after
  `last_scanned_height`, stores matches idempotently, and advances the watch
  height only after a block is processed successfully.
- Watches at the same network and cursor share one block fetch. Decoded packs
  are held in a bounded cache so different watch groups do not repeatedly
  decode the same immutable package.
- Block heights must be contiguous. If a source skips a height, the worker
  fails the run without advancing, so it cannot silently miss a block.

The production `HardwareHostedViewKeyMatcher` validates that the private view
key belongs to the registered address, prepares the view scalar once per
wallet/block-window invocation and batches all unique transaction public keys
across that fetched window. The EPYC feature processes 16-point chunks in a
fixed Rayon pool using
runtime-selected AVX-512 IFMA or AVX2. Primary and additional transaction keys,
view tags, ordinary outputs, and miner outputs are covered. The same results
are checked against `monero-wallet::Scanner` fixtures.

ScanPack's pruned transactions retain the transaction prefix and RingCT base,
which is sufficient for ownership detection. The scanner deliberately does
not re-verify RingCT proofs already accepted by the canonical Cuprate node;
notifications remain generic wake-up hints and the device wallet core is the
authority for balances and spendability.

`MWSPACK1` version 1 has no cryptographic package checksum or canonical
generation identifier. The reader enforces format/size/permission limits and
chain continuity inside each requested window, but the writer-side reorg
invalidation test is still a release requirement. Until that is complete,
ScanPack notifications must not be treated as proof of payment.

## Mempool Tracking

Fast Receive also needs a mempool path for early notifications:

- `MempoolSource` supplies the current txpool/mempool snapshot from Cuprate or
  a test source.
- `MempoolOutputMatcher` checks unconfirmed transaction outputs against hosted
  identities.
- `MempoolScannerWorker` stores matching outputs as `pending_mempool`.
- The later block scanner derives the same one-way fingerprint, so a confirmed
  block match updates the pending record instead of creating a duplicate.
- If a pending mempool match disappears before confirmation, it is marked
  `dropped`.

Mempool matches are notification hints only. The app must never treat them as
spendable funds until wallet-core verification sees the transaction confirmed
and reconciles spend state.

The mempool worker state machine is implemented and tested. The production
crypto matcher for txpool transactions is also implemented by wrapping each
full txpool transaction blob in a synthetic in-memory `ScannableBlock` and
running it through `monero-wallet::Scanner`. These matches are still only
pending notification hints. They must be confirmed by a later block scan and
local wallet-core verification.
