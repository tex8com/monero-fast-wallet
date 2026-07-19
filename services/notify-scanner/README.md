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

If `NOTIFY_SCANNER_AUTH_TOKEN` is set, clients must send:

```text
Authorization: Bearer <token>
```

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
export NOTIFY_SCANNER_CUPRATE_GRPC_ENDPOINT=xmr.tex8.com:18091
export NOTIFY_SCANNER_CUPRATE_RPC_ENDPOINT=xmr.tex8.com:18089
export NOTIFY_SCANNER_PUSH_ENDPOINT=http://127.0.0.1:4020/api/v1/internal/mobile/fast-wallet-push-events
export NOTIFY_SCANNER_PUSH_AUTH_TOKEN=<scanner-to-cloud-secret>
export NOTIFY_SCANNER_PUSH_TENANT_ID=monero-wallet
export NOTIFY_SCANNER_PUSH_SHOP_ID=monero-wallet
export NOTIFY_SCANNER_PUSH_APP_ID=monero-wallet
export NOTIFY_SCANNER_PUSH_TIMEOUT_MS=10000
# Optional: enables the separately authenticated test-only payment signal route.
# It is intentionally not the scanner API token.
export NOTIFY_SCANNER_TEST_AUTH_TOKEN=<dedicated-test-only-secret>
cargo run --manifest-path services/notify-scanner/Cargo.toml
```

The scanner database is encrypted at rest with XChaCha20-Poly1305. It stores
watch records, opaque detection events, and key-image status records in one sealed
JSON file. If `NOTIFY_SCANNER_CUPRATE_GRPC_ENDPOINT` is set, the service starts
an optional background block scanner. If `NOTIFY_SCANNER_CUPRATE_RPC_ENDPOINT`
is also set, the same loop scans the txpool for early pending hints.

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

- `BlockSource` supplies ordered blocks from Cuprate or a test source.
- `OutputMatcher` owns Monero output detection for a watch record.
- `ScannerWorker` reads registered watch records, processes blocks after
  `last_scanned_height`, stores matches idempotently, and advances the watch
  height only after a block is processed successfully.
- Block heights must be contiguous. If a source skips a height, the worker
  fails the run without advancing, so it cannot silently miss a block.

The worker tests use an in-memory block source and deterministic matcher. Real
Cuprate block payloads should be decoded with `decode_get_blocks_payload`, then
matched with `HostedViewKeyBlockMatcher`, which uses `monero-wallet::Scanner`
and validates that the hosted private view key matches the registered address.
Pruned block payloads are rejected because hosted scanning needs the RingCT
base data.

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
