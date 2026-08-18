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
| macOS | APNs after the provider adapter is accepted |
| Windows | Authenticated outbound WSS agent → Windows notification |
| Linux | Authenticated outbound WSS agent → DBus notification |

Every visible notification is generic. The local wallet opens and synchronizes
to determine what actually happened.

## Deployment status

Live deployment is intentionally blocked until app-integrity/provider
registration, exact assignment provisioning, signed-Worker wake integration,
rate-limit evidence, and physical closed-app delivery pass together. The deploy
script exits without connecting to or changing a server.
