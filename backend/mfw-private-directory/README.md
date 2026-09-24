# MFW private directory services

This crate provides three deliberately separate, log-free network roles plus
one offline publisher:

- `voprf`: one independently keyed RFC 9497 Ristretto255 evaluator. Deploy two
  instances under separate operational control. Each request needs a
  short-lived, quota-bounded permit issued outside the evaluator.
- `verification`: the loopback-only SMS/voice verification and signed mutation
  service. It talks to an isolated provider gateway through an
  HTTPS-only, timestamped/nonce-bound HMAC protocol, derives the verified
  number's token itself through both pinned VOPRF evaluators, issues the
  participant record, and accepts only signed contact/revocation records.
- `directory`: a read-only server for a pre-signed, freshness-bounded complete
  opaque directory snapshot. It has no contact lookup endpoint.
- `mfw-directory-publisher`: an offline CLI that applies canonical binary
  mutations and atomically publishes the next signed snapshot generation.

The wallet blinds each normalized E.164 number independently for both VOPRF
nodes, verifies both proofs and combines both outputs locally. It downloads the
signed snapshot, derives mutual pair IDs and decrypts matching fixed-size HPKE
cards locally.

This is a 2-of-2 multi-server composition, not a claim that RFC 9497 itself
defines threshold VOPRF. Collusion between both evaluators and the phone
verification issuer remains a documented residual risk. Mainnet enablement
still requires an external cryptographic/privacy review and independent
operators.

Only `/v1/phone-verification/start` accepts the publishing user's own canonical
E.164 number so the configured SMS/voice provider can prove temporary control.
It is retained only in a bounded, ten-minute, zeroizing in-memory challenge and
is never written to directory state. No endpoint accepts an address book,
ordinary phone-number hash, Monero secret, wallet-address lookup, phone-token
lookup, pair lookup, or individual contact lookup.

The verification service exposes only fixed/bounded binary routes:

- `POST /v1/phone-verification/start`
- `POST /v1/phone-verification/complete`
- `POST /v1/contact`
- `POST /v1/contact/revoke`
- `POST /v1/contact/ask`
- `POST /v1/contact/ask/poll`
- `POST /v1/participant/revoke`

The latter three require protocol signatures from the active participant key,
strictly increasing sequences, active recipient HPKE keys, per-participant
rate/capacity limits, and an authenticated state fsync before success. The
directory state is HMAC-authenticated, mode `0600`, written by atomic rename,
and protected by a cross-process exclusive lock shared with the publisher.
Revocation tombstones and snapshot generation high-water marks survive
restart.

`/v1/contact/ask` is a ciphertext-only, fixed-size relay for the
`ask every time` policy. Requests and responses are exactly 592 bytes and are
signed, end-to-end encrypted and bound to the mutual pair, both participant
tokens, one random request ID, network, sequence and short expiry. The service
accepts a request only from two active participants with an active reverse
contact relationship. It accepts at most one exact response for a pending
request. It cannot read the requested network, decision or approved Monero
subaddress.

Mailbox polls are fixed 170-byte participant-signed messages and return one
fixed 624-byte page: a random process-instance ID, monotonic cursor, presence
bit, zero padding and either one envelope or zeros. The in-memory relay retains
at most 100,000 messages globally and 64 per mailbox, removes expired entries,
and rate-limits requests, responses and polls independently. A service restart
intentionally discards pending messages and changes the instance ID; clients
reset their cursor and the sender can issue a new request after expiry. No
phone number, address, decision or cryptographic secret is persisted by this
relay.

The service intentionally does not contain an SMS-vendor SDK. The
`verification` role calls a separately isolated provider gateway at
`MFW_PHONE_PROVIDER_ORIGIN`; this keeps vendor credentials and provider-specific
payloads outside the directory process. The gateway contract is:

- `POST /v1/start`: canonical E.164 bytes in, opaque handle bytes out;
- `POST /v1/check`: bounded opaque handle plus numeric code in, one byte
  `0`/`1` out;
- verify `x-mfw-provider-time`, `x-mfw-provider-nonce`, and
  `x-mfw-provider-auth` against the shared HMAC key, a short clock window, and
  a nonce replay cache.

Run the repeatable source and process testbench with:

```sh
TMPDIR=/Volumes/4TB/CACHE/monero-fast-wallet-build/tmp \
CARGO_TARGET_DIR=/Volumes/4TB/CACHE/monero-fast-wallet-build/mfw-private-directory-target \
cargo test --locked --offline --manifest-path \
  backend/mfw-private-directory/Cargo.toml --all-targets
```

It covers proof pinning, wrong evaluator keys, HTTPS-only origins, provider
HMAC binding, OTP single use/attempt/rate bounds, client token-substitution
prevention, authenticated atomic persistence, concurrent publisher locking,
monotone snapshots, replay, key rotation, contact/participant revocation and
the actual publisher process. It also covers encrypted request/approval,
decline, replay, stranger rejection, exact request/response binding, fixed
mailbox pages and relay capacity/rate limits.

The binary refuses non-loopback binds. Put a reviewed, authenticated TLS
terminator in front of each evaluator; never expose the cleartext Axum socket.
Secret files must be small regular files with no group/world permissions and
are opened with `O_NOFOLLOW` on Unix.
