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

Unknown key images return `unknown`. A later Cuprate-backed worker must update
the key-image status table from chain state.

## Runtime

```sh
export NOTIFY_SCANNER_STORAGE_KEY=<32-byte hex or base64 key>
export NOTIFY_SCANNER_WATCH_DB=./notify-scanner-watch.json.enc
export NOTIFY_SCANNER_BIND=127.0.0.1:8087
cargo run --manifest-path services/notify-scanner/Cargo.toml
```

The scanner database is encrypted at rest with XChaCha20-Poly1305. It stores
watch records, matched outputs, and key-image status records in one sealed
JSON file. The next step is wiring the scanner loop to Cuprate's block stream,
chain-backed key-image checks, and push delivery.
