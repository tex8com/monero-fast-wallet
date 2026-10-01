# Delayed `.mfw` claim delivery

A separate delivery service alongside Monero Fast Node, **not a consensus
change** and not the existing ciphertext `fast-wallet-relay`.

## Contract and trust boundary

The wallet broadcasts the commitment, then prepares and explicitly signs a
second transaction using **independent unlocked inputs**. It durably stores the
signed bytes and random 192-bit job/token locally before PUT. Successful PUT
means SQLite WAL + FULL synchronous durable custody, not registration. Retries
must use the same ID, token and byte-identical request. The server parses the
transaction, checks its actual hash, verifies the owner-signed MFW payload and
requires its matching commitment to be visible in the configured node.

The server knows the claim before publication and can leak or broadcast it
early. This is an **explicitly trusted delivery service**, not a trustless
commit/reveal replacement. No seed, spend key, view key or name-owner secret
leaves the wallet. Push routing optionally associates an installation with the
job; notifications contain only an opaque job ID and generic wording.

The existing wallet/daemon still verifies spend validity, ring signatures and
network fees. The canonical MFW index verifies the actual registry payment.
The relay cannot promise mining or successful ownership. It marks `confirmed`
only when the mined claim has 15 confirmations and the current canonical index
reports that exact TX and owner as finalized. The wallet still requires its
existing independent resolver verification before showing `Active`.

## State machine

`waiting → relaying → broadcast → confirmed`

- `waiting`: commitment is unmined or below the required age.
- `relaying`: transmission intent saved **before** RPC; timeout is ambiguous.
- `broadcast`: independently observed in mempool or blockchain, not registered.
- `confirmed`: final canonical registry evidence; generic push queued.
- `expired`, `rejected`, `cancelled`: terminal; generic attention push.

The next candidate block height minus commitment block height must be 15–720
(inclusive). Never use an elapsed-time alarm to authorize broadcast. Check the
claim before expiry: an in-time mined claim may finalize after block 720.
Re-read on chain movement; a post-broadcast reorg is not preventable. A missing
unmined commitment has a two-day storage deadline, but outages are never treated
as expiry. Retries broadcast only the same signed bytes (same TXID).

Cancellation is authenticated and serialized with transmission. Once a send
was attempted, cancellation is refused, including a lost acknowledgement.
Tombstones prevent retrying a cancelled job. Clients must retain their token;
they cannot recover custody through a public name lookup. Per-wallet sending
is conservatively blocked locally while a signed claim is pending. This is
**not** an input lock on other devices/wallet copies.

## Mobile and fallback

New Android/iOS flows probe this service only for the selected official TEX8
node. Custom/community nodes keep the existing manual second approval, local
reminder and persistent banner; no silent switch to our relay. Existing Android
device-only queued claims are preserved and are not migrated or double-queued.

If step 2 cannot be signed (e.g. only locked change remains), or its signed hex
exceeds the mobile 60,000-character transport budget, the commitment is
persisted and the UI keeps the manual second step. If upload is uncertain, the
UI says to keep the app open until server receipt and retries after unlock.
**After server receipt**, delivery no longer depends on the phone process.
Notifications additionally need an existing provider registration and OS
permission. Neither local reminders nor remote push can be guaranteed when
the OS/user disables them. Desktop remains on the manual workflow until its
separate native export/UI path has been implemented and device-tested.

## API

- `GET /v1/mfw/claim-relay/capabilities` — version/network/immutable block rules.
- `PUT /v1/mfw/claim-relay/jobs/{48-lowercase-hex}` — bearer token, also 48 hex.
  JSON: `commitTxid`, `claimTxid`, `rawTxHex`, nullable `installationId`.
- `GET` same job path — authenticated status, no raw transaction returned.
- `DELETE` same path — acknowledged cancellation only before any send attempt.

No user-provided RPC origin, maturity height or callback URL is accepted.
Bodies, upstream responses, queue size and edge request rate are bounded.
The fixed daemon origin must be loopback/private literal IP; notification
ingress is strictly loopback. Redirects and environment proxies are disabled.
Raw transactions and installation IDs are encrypted at rest with XChaCha20-
Poly1305, job ID as AAD; secrets reside in owner-only files outside this repo.
Single-process locking prevents independent workers racing a cancellation.
The initial queue is bounded at 128 active jobs and 10,000 records including terminal tombstones.
Capacity is fail-closed; retention/compaction must preserve idempotency and
should be established before a broad public launch.

## Deployment and verification

1. `cargo test --locked --manifest-path backend/mfw-claim-relay/Cargo.toml` and
   the notification gateway tests. Build both with `--release --locked`.
2. Create a dedicated unprivileged service account, private state directory,
   and distinct random storage and gateway-auth keys. Never rotate the storage
   key without migrating the encrypted database. Back up DB **with WAL** and
   the key securely; never overwrite a populated queue during deployment.
3. Install `deploy/mfw-claim-relay.service`, prepare an external environment
   from the example, and set the real canonical-node origin. Port 8101 avoids
   existing worker-debug/vanity ports. No public daemon port is opened.
4. Configure `NOTIFICATION_GATEWAY_CLAIM_SERVICE_AUTH_FILE` with a separate
   owner-readable copy of the shared notification key, update the gateway
   binary and restart it with a rollback copy retained.
5. Include the rate-limit snippet in Nginx `http` and the route snippet in the
   primary onion server. Run `nginx -t` before reload. Do not proxy the
   `/api/v1/internal/mfw-claim-event` route externally.
6. Verify loopback + onion capabilities, authenticated job denial, durable
   restart, RPC field shapes, correct block boundary, and actual push delivery.
   A real Ledger commit/claim cycle requires the owner's explicit approvals;
   tests must never silently spend wallet funds.

Automated fixtures use synthetic Monero transaction envelopes with valid MFW
owner signatures and dummy ring signatures against an isolated fake chain.
They prove state transitions, not Ledger functionality or mainnet acceptance.
Do not call this public-release-ready without the physical end-to-end test.
