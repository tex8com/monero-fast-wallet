# Fast Wallet Worker

Outbound-only V1 Worker building blocks.

- accepts only the fixed-size `watch-envelope.v1`;
- decrypts only envelopes bound to its signed descriptor and HPKE key;
- signs every outbound Relay pull and acknowledges only after durable local
  acceptance, so a crash safely retries instead of losing a watch;
- returns a descriptor- and ciphertext-ID-bound signed acceptance receipt in
  that ACK, which the Relay exposes only to the bearer of the exact message ID;
- converts the decrypted watch into the existing encrypted scanner store;
- reuses the existing Monero Fast Node ScanPack matcher separately;
- has no public plaintext watch-registration route;
- disables core dumps, makes the process non-dumpable on Linux, locks current
  and future memory pages before loading credentials, and loads secrets only
  from private credential files;
- returns/logs only opaque assignment and envelope identifiers.

## Community mode

`FAST_WALLET_WORKER_MODE` accepts `public` (the default) or `private`.

- `public` signs a registration and regular heartbeats for the configured
  Directory. A new Worker remains `pending` until TEX8 approves it. The
  Directory then publishes a short-lived certificate bound to this exact
  Worker descriptor and Relay.
- `private` never contacts the Directory. Run `fast-wallet-worker-pairing`
  with `FAST_WALLET_WORKER_DESCRIPTOR_FILE` set to print the signed pairing
  code for manual entry in a Wallet.

Public mode additionally requires:

```text
FAST_WALLET_WORKER_DIRECTORY_ORIGIN=https://xmr.tex8.com
FAST_WALLET_WORKER_OPERATOR_LABEL=Example operator
FAST_WALLET_WORKER_REGION=PA
FAST_WALLET_WORKER_POLICY_URL=https://example.com/privacy
FAST_WALLET_WORKER_MAXIMUM_ASSIGNMENTS=100
```

The Worker opens no public port in either mode. Relay pulls, Directory
registration and notification wakes are outbound HTTPS requests.

Create a fresh Community Worker identity from source:

```bash
cargo run --release \
  --manifest-path native/fast-wallet-protocol/Cargo.toml \
  --example provision_community_worker -- \
  ./community-worker-material https://xmr.tex8.com mainnet
```

Keep `worker-root-signing.key` offline. Copy only the descriptor, online key,
HPKE key and storage key to the Worker host. Public mode appears in the Wallet
only after the TEX8 administrator approves its pending Directory entry.
Private mode skips that approval and is selected by manually importing the
pairing code; the Gateway gives such unlisted Workers a deliberately small
assignment quota.

The public V1 feature remains disabled until the Relay, signed receipts/wakes,
provider Gateway and physical client acceptance are complete.

The EPYC feature intentionally requires the authenticated Dalek patch tree.
Run the Worker suite through:

```bash
services/fast-wallet-worker/test-authenticated.sh
```

A plain `cargo test` is expected to fail closed rather than silently compile
against the unpatched upstream dependency.

The service account must have a sufficient locked-memory limit (for example
`LimitMEMLOCK=infinity` in a dedicated Linux systemd unit). Startup fails
before credentials are read when memory locking is unavailable.
