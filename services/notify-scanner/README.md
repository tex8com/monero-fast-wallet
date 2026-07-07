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

## Runtime

```sh
export NOTIFY_SCANNER_STORAGE_KEY=<32-byte hex or base64 key>
export NOTIFY_SCANNER_WATCH_DB=./notify-scanner-watch.json.enc
export NOTIFY_SCANNER_BIND=127.0.0.1:8087
cargo run --manifest-path services/notify-scanner/Cargo.toml
```

The watch database is encrypted at rest with XChaCha20-Poly1305. The next step
is wiring the scanner loop to Cuprate's block stream and push delivery.
