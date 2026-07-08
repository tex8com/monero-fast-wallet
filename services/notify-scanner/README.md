# Notify Scanner

`notify-scanner` is the server-side Fast Receive module. It is separate from
normal wallet sync: standard wallets still use Monero RPC or optimized Cuprate
gRPC without uploading a private view key.

The module accepts opt-in watch records for isolated Fast Receive identities:

- public address
- private view key for that isolated identity
- network
- restore height
- optional push token

It never accepts a seed, private spend key, or main-wallet private view key.

## API

```text
GET    /healthz
POST   /v1/fast-receive/watch
DELETE /v1/fast-receive/watch/:identity_id
GET    /v1/fast-receive/watch/:identity_id/matches
POST   /v1/fast-receive/matches
POST   /v1/fast-receive/key-images/status
```

`POST /v1/fast-receive/watch` body:

```json
{
  "identity_id": "fast-receive-0-20260701T120000",
  "address": "9...",
  "private_view_key": "64 hex chars",
  "network": "stagenet",
  "restore_height": 123456,
  "push_token": "optional push provider token"
}
```

If `NOTIFY_SCANNER_AUTH_TOKEN` is set, clients must send:

```text
Authorization: Bearer <token>
```

`POST /v1/fast-receive/matches` is the internal scanner write path used after a
block output matches a registered hosted identity:

```json
{
  "identity_id": "fast-receive-0-20260701T120000",
  "tx_id": "64 hex chars",
  "block_height": 3712787,
  "output_index": 3,
  "block_timestamp_ms": 1783440572804,
  "amount_atomic": 100000000,
  "key_image": "optional 64 hex chars"
}
```

The store key is `identity_id + tx_id + output_index`, so processing the same
block twice updates the same match instead of creating duplicates.

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
export NOTIFY_SCANNER_CUPRATE_GRPC_ENDPOINT=152.53.133.188:18091
export NOTIFY_SCANNER_CUPRATE_RPC_ENDPOINT=152.53.133.188:18089
cargo run --manifest-path services/notify-scanner/Cargo.toml
```

The scanner database is encrypted at rest with XChaCha20-Poly1305. It stores
watch records, matched outputs, and key-image status records in one sealed
JSON file. If `NOTIFY_SCANNER_CUPRATE_GRPC_ENDPOINT` is set, the service starts
an optional background block scanner. If `NOTIFY_SCANNER_CUPRATE_RPC_ENDPOINT`
is also set, the same loop scans the txpool for early pending hints.

Optional scanner tuning:

```sh
export NOTIFY_SCANNER_BLOCK_SCAN_MAX_BLOCKS=25
export NOTIFY_SCANNER_BLOCK_SCAN_INTERVAL_MS=10000
export NOTIFY_SCANNER_CUPRATE_GRPC_CHUNK_BLOCKS=200
```

The crate decodes Cuprate `GetBlocksResponse` Epee payloads into Monero blocks
and transactions, then builds `monero-rpc` `ScannableBlock` values for hosted
view-key scanning. The crate also checks key-image spent state through Cuprate
RPC for fast spend reconciliation. The remaining production work is push
delivery, lag/health metrics, and operational deployment wiring.

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
- The later block scanner uses the same match id
  `identity_id + tx_id + output_index`, so a confirmed block match updates the
  pending record instead of creating a duplicate.
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
