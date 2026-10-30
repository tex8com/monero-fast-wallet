# Monero Fast Wallet Notification Gateway

This service is the separate delivery boundary for opaque Fast Wallet wake
events. It never receives a wallet address, amount, transaction id, view key,
spend key, provider-independent wallet id, or Worker watch plaintext.

## V1 security contract

- An installation has a public CSPRNG identifier and a separate 32-byte
  authentication secret. Only its SHA-256 verifier is persisted.
- An assignment pins one installation to one assignment handle, epoch, Worker
  root key, Worker online signing key, HPKE key and expiry.
- `POST /api/v1/internal/worker-wake` accepts only a fixed generic
  `incoming_transaction` event signed by that exact Worker online key.
- Worker authentication expires within 60 seconds and is replay-protected.
  Replay storage is capped globally and per assignment.
- The Worker supplies no installation id or push token. The Gateway resolves
  the destination from its own active assignment.
- `GET /api/v1/notifications/stream` requires both
  `x-fast-wallet-installation-id` and
  `x-fast-wallet-installation-auth`.
- The stream retains an opaque event until the authenticated Windows/Linux
  background agent acknowledges it.

The public router deliberately has no unauthenticated installation-registration
endpoint. Registration must come from the separate app-integrity/provider
adapter through `GatewayState::register_installation`; that adapter and real
FCM/APNs activation remain release gates.

The previous shared scanner token, caller-selected subscription id, and
installation-ID-only WebSocket authentication were removed. A legacy v3 event
store is migrated fail-closed: old unauthenticated queues are discarded.

## Platform delivery

| Platform | Delivery path |
| --- | --- |
| Android / iOS | FCM; Firebase forwards iOS delivery to APNs |
| macOS | APNs after the provider adapter is accepted |
| Windows | Authenticated outbound WSS agent → Windows notification |
| Linux | Authenticated outbound WSS agent → DBus notification |

Every visible notification is generic. The local wallet opens and synchronizes
to determine what actually happened.

### macOS APNs credentials

For automatic JWT renewal, configure the existing Apple key through a protected
file, never through an environment value containing its private contents:

```text
NOTIFICATION_GATEWAY_APNS_TOPIC=com.tex8.monerowallet.desktop
NOTIFICATION_GATEWAY_APNS_TEAM_ID=<Apple Team ID>
NOTIFICATION_GATEWAY_APNS_KEY_ID=<existing APNs Key ID>
NOTIFICATION_GATEWAY_APNS_SIGNING_KEY_FILE=/etc/monero-fast-wallet/apns-signing.p8
NOTIFICATION_GATEWAY_APNS_SANDBOX=false
```

The signing file must be a regular PEM P-256 key file, at most 16 KiB, without
group/other permissions (normally mode 0600 with Gateway-readable ownership).
Symlinks are refused. Startup validates the key by signing a token; errors never
include credential contents or paths. No Apple key is created by the Gateway.

The Gateway shares one provider JWT across concurrent requests and renews it
after 30 minutes, on the next request. A request after a long idle period signs
with the current Unix time before sending. A backwards wall-clock correction
replaces a future cached token using the corrected time, on the delivery's new
HTTP connection. A failed renewal defers delivery through the ordinary retry
queue; it never sends an expired cached token as a fallback. Keep the server
clock correct.
This follows Apple's [20–60 minute provider-token refresh window](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns).

Compatibility mode remains available with `NOTIFICATION_GATEWAY_APNS_TOPIC`
and `NOTIFICATION_GATEWAY_APNS_PROVIDER_JWT_FILE` instead of **all three** signing
settings. That JWT file is reread on every delivery and must be rotated by an
external service within Apple's validity window. Mixed or partial credential
sources fail startup. Production-signed macOS builds require `SANDBOX=false`;
development builds require their matching environment.

iOS keeps its existing FCM route, so it does not share the direct macOS APNs
topic. Its signed app must contain the correct `GoogleService-Info.plist`, and
the matching Firebase iOS app needs an active Apple APNs credential for its
bundle ID and environment. Configuring direct macOS APNs does not prove this
Firebase prerequisite or physical iOS receipt.

## Deployment status

Live deployment is intentionally blocked until app-integrity/provider
registration, exact assignment provisioning, signed-Worker wake integration,
rate-limit evidence, and physical closed-app delivery pass together. The deploy
script exits without connecting to or changing a server.


## Scheduled Settings self-test

`POST /api/v1/installations/test-push` uses the ordinary installation headers
and requires enabled delivery, a live provider registration and a live
assignment to the configured official co-located Worker. Community/private
Workers outside that loopback service are rejected explicitly; a fresh provider
registration alone cannot trigger a test.

The response is HTTP 202 **after durable scheduling**, with exactly:

```json
{"accepted":true,"eventId":"evt_<64 lowercase hex>","scheduledAt":1793214001,"deliverAfter":1793214011}
```

`scheduledAt` is server Unix time rounded upwards; `deliverAfter` is exactly ten
seconds later. This prevents second truncation from delivering after only nine
seconds. There is no client sleep and no Worker/provider request in the HTTP
handler. Queue processing and network delivery may add time after the deadline.

The encrypted provider store retains the scheduled trigger and its opaque
assignment binding across restarts. At the deadline the normal dispatcher
calls the authenticated loopback Worker endpoint. That Worker must find the
existing watch and matching epoch, signs the exact event ID with its online key,
and submits `signal=test` through `/api/v1/workers/wake`. The normal Gateway
signature/assignment checks, persistent provider jobs, retries, FCM/APNs
adapters and authenticated Desktop stream/ACK then apply. The category remains
`monero.fast_wallet.test`; no matched output, transaction or payment history
entry is created. Provider acceptance is logged as `provider-accepted` and is
not a claim that a device received the message.

The test covers the registered watch, Worker signature, Gateway wake ingress,
queue, provider/stream, and the client's real notification/refresh handler. It
does **not** fabricate a blockchain match or exercise a new HPKE/Relay enrollment.
Relay is the existing enrollment path; normal payment wakes also travel
straight from Worker to Gateway.

One test per installation per 60 seconds and at most one pending test are
allowed. A persistent 24-hour receipt prevents a repeated Worker trigger from
creating a second provider job after delivery/ACK. Trigger errors use the same
bounded retry scheduler. Opt-out, assignment deletion/expiry and provider lease
expiry are checked before the applicable trigger/delivery step. An already
accepted external provider request cannot be recalled.

Errors return a status and, for Settings prerequisites, an opaque JSON `error`:
`self_test_requires_fast_wallet` (409), `self_test_worker_unsupported` (409),
`self_test_provider_required` (409), or `self_test_unavailable` (503).
Authentication remains 401 and the installation-bound rate limit is 429.

### Release preparation and activation boundary

`deploy/build-settings-self-test-release.sh` prepares the Linux x86-64 Gateway
and EPYC Worker binaries using their existing locks and the authenticated Dalek
CPU backend. Its output TAR contains binaries, the descriptor activation helper,
source/binary checksums and these instructions. It performs no SSH, deployment,
service restart, descriptor renewal or credential operation. Build with:

```sh
MFW_SELF_TEST_BUILD_ROOT=/path/to/local-build \
  backend/notification-gateway/deploy/build-settings-self-test-release.sh
```

Activation is a separate explicit approval. The reviewed package requires:

1. A newly signed public descriptor with unchanged Root/online/HPKE keys,
   network and relay origin. Only the public descriptor is transferred; the
   offline root key stays offline. Renew before its 30-day expiry. Renewal
   cannot revive assignments which already expired; clients must re-enroll.
2. Protected backups of the existing Gateway/Worker binaries, both descriptor
   files, service environment files and persistent stores. Backups must keep
   private ownership/modes and never be printed or included in a public TAR.
3. The two built binaries installed atomically, with a recovery guard active
   before the first replacement. Preserve all Worker watches and existing
   Gateway/provider state. Only additive defaulted metadata was added to the
   encrypted provider store; rollback to an older Gateway must first quiesce
   self-test requests and preserve/drain pending test jobs, whose Worker phase
   the older binary does not understand.
4. A private Worker loopback/test-token configuration, plus these **two
   additive** Gateway environment entries (preserve every other setting):

   ```text
   NOTIFICATION_GATEWAY_WORKER_TEST_ORIGIN=http://127.0.0.1:8099
   NOTIFICATION_GATEWAY_WORKER_TEST_TOKEN_FILE=/etc/monero-fast-wallet/worker-debug-token-gateway.key
   ```

   The Gateway token file must contain the same token as the Worker, with
   Gateway-readable private ownership/mode0600. Preserve an existing token;
   if none exists, generate a new 32-byte token only on the server and install
   private copies for the two service users. Never show its contents or
   transfer Worker keys. Check the port immediately before activation: the
   October2026 production download service already uses8097 and8098 is occupied.
   Keep the Worker endpoint loopback-only and absent from Nginx. Its existing
   `FAST_WALLET_WORKER_DEBUG_BIND` and `...DEBUG_TOKEN_FILE` remain required.
5. The public descriptor is activated with the reviewed helper; restart only
   Relay, Gateway and Worker as required. No Node restart or Node deployment.
6. Verify service health, identical public descriptor over HTTPS and Onion,
   unchanged public key IDs, a Settings202 response, no pre-deadline wake, and
   the same event ID at Worker, Gateway, provider acceptance and actual device.
   Verify foreground, locked/background and Desktop WSS/ACK separately before
   claiming those device states work.

The October2026 production502 was independently traced to the descriptor
expiring on2026-10-17: Relay/Gateway/Worker refused startup. A new client or this
source change alone cannot repair that separate server prerequisite.

Local regression commands:

```sh
cargo test --manifest-path backend/notification-gateway/Cargo.toml --locked --offline
```

Worker tests must use the isolated EPYC lock and authenticated CPU fork, as in
`backend/fast-wallet-stack/deploy/build-fast-wallet-worker-epyc.sh`; ordinary
unpatched crates.io Dalek does not expose its prepared-scalar APIs. The Worker
integration test uses only synthetic in-memory watches/keys and real loopback
HTTP, signs the wake, traverses the real Gateway handler and normal recording
provider dispatch, and verifies no matched output was inserted.

## Fresh hosting checks

`POST /api/v1/installations/assignments/{handle}/hosting-check` uses the existing
installation ID/auth headers. JSON input is `{assignmentEpoch, nonce,
workerDescriptor}`; the nonce is 32 fresh random bytes encoded as lowercase
hex. Repeat the same request to poll for at most 60 seconds. This read requires
assignment ownership and does not require APNs/FCM permission or a provider.

The response has `contractVersion: "monero-fast-wallet-hosting.v1"`, `status`,
`assignmentHandle`, `assignmentEpoch`, `nonce`, `checkedAt`, and `proof`.
HTTP 202 `pending` and HTTP 200 `unsupported` have null check time/proof.
HTTP 200 `hosted` or `missing` require a fresh descriptor-bound Worker signature.
Authentication, assignment expiry/key mismatch, transport, or invalid proofs
produce errors and must never trigger automatic rehosting as if absence were
proven. A recently polling legacy Worker returns `unsupported`; an offline
Worker remains pending until the client's bounded attempt ends as unknown.

The Gateway uses its configured Relay control channel for every Worker type.
The Relay queues an opaque challenge; the outbound Worker reads the actual
`fw1:{handle}` WatchStore record, validates epoch/network and the real
address/private-view-key pair, then signs the result. The envelope's short
admission expiry is not the lifetime of the persisted watch. Relay assignment
expiry and current key pins are checked independently before accepting a proof.
WatchStore read failures never produce a signed missing result. Challenges
are held in a bounded ephemeral queue; a Relay restart can lose a pending
check, never manufacture a missing result.

The canonical 121-byte proof body is `TX8HST01 || workerRootId[32] || handle[32]
|| epochBE[8] || nonce[32] || hosted[1] || checkedAtBE[8]`. The signature uses
`WorkerAuthPurpose::HostingStatus` (7), issuedAt equals checkedAt, and the
maximum proof lifetime is 60 seconds. Native clients also match the fresh
attempt nonce/handle/epoch and require checkedAt no earlier than attempt start
minus five seconds. The shared Rust verifier and C ABI enforce the same proof
contract. Diagnostics correlate the first 16 nonce hex characters as
`hostingCheckId`, without logging handles, addresses, keys, or credentials.

Gateway, Relay and Worker binaries plus the updated Nginx routes must ship
together. The build-only Settings release script includes all three and the
Nginx configuration. The internal Relay assignment-check route is not public;
only the signed Worker pull/complete routes are exposed. Older Relay servers
return unsupported without interrupting ordinary Worker enrollment/scanning.
This protocol does not change Firebase, Apple accounts, provider keys, or Node
configuration.
