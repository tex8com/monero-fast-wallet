# Monero Fast Wallet Notification Gateway

This is the separate HTTPS/WebSocket gateway for opaque desktop notification delivery.
It is intentionally independent from Community and the scanner API.

It accepts only a generic `incoming_transaction` signal from the local scanner
and stores a short queue by anonymous installation capability. It rejects
wallet addresses, amounts, transaction ids, key images, seeds, view keys,
spend keys, arbitrary provider payload fields, and arbitrary registration
targets.

## API contract

`POST /api/v1/internal/fast-wallet-push-events` is loopback-only in normal
deployment and requires `x-fast-wallet-push-token`. It accepts only:

```json
{
  "contractVersion": "monero-fast-wallet-push.v2",
  "eventId": "sig_<64 hex characters>",
  "tenantId": "monero-wallet",
  "shopId": "monero-wallet",
  "appId": "monero-wallet",
  "subscriptionId": "anonymous-installation-capability",
  "signal": "incoming_transaction"
}
```

`GET /api/v1/notifications/stream` requires the anonymous capability in the
`x-fast-wallet-installation-id` HTTPS header and is upgraded by Nginx to a
durable `wss://` connection. Linux and Windows background agents keep this one
outbound TLS connection open. The gateway sends a generic event, retains it,
and removes it only after the agent acknowledges that it has shown the desktop
notification. The agent reconnects after a network change with bounded
backoff. There is no periodic polling and no capability is placed in a URL.

## Platform delivery

| Platform | Delivery path |
| --- | --- |
| macOS | APNs is the primary closed-app path. A user-level WebSocket fallback can be enabled separately without replacing APNs. |
| Windows | Unprivileged user-level `monero-fast-walletd` WebSocket agent → Windows desktop notification. |
| Linux | Unprivileged user-level `monero-fast-walletd` WebSocket agent → DBus desktop notification. |

The private delivery path requires no external push-provider or Microsoft credentials.
The notification is deliberately generic: it conveys only that the Fast Wallet
has activity; the wallet opens and syncs locally to reveal any details.

## Live deployment

From the repository root on the Mac:

```bash
bash services/notification-gateway/deploy/deploy-live-from-macos.sh
```

The command asks for the existing server administrator's sudo password in the
local terminal. It preserves the Community include, backs up the live Nginx,
scanner and gateway configuration, verifies the public secure-stream route,
and wires `notify-scanner` to the gateway over `127.0.0.1`.
