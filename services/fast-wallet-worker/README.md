# Fast Wallet Worker

Outbound-only V1 Worker building blocks.

- accepts only the fixed-size `watch-envelope.v1`;
- decrypts only envelopes bound to its signed descriptor and HPKE key;
- signs every outbound Relay pull and acknowledges only after durable local
  acceptance, so a crash safely retries instead of losing a watch;
- returns a descriptor- and ciphertext-ID-bound signed acceptance receipt in
  that ACK, which the Relay exposes only to the bearer of the exact message ID;
- converts the decrypted watch into the existing encrypted scanner store;
- reuses the existing ScanPack/Cuprate matcher separately;
- has no public plaintext watch-registration route;
- disables core dumps, makes the process non-dumpable on Linux, locks current
  and future memory pages before loading credentials, and loads secrets only
  from private credential files;
- returns/logs only opaque assignment and envelope identifiers.

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
