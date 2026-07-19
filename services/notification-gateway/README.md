# Monero Fast Wallet Notification Gateway

This is the separate HTTPS gateway for opaque desktop notification delivery.
It is intentionally independent from Community and the scanner API.

It accepts only a generic `incoming_transaction` signal from the local scanner
and stores a short queue by anonymous installation capability. It rejects
wallet addresses, amounts, transaction ids, key images, seeds, view keys,
spend keys, arbitrary provider payload fields, and arbitrary registration
targets. A Windows WNS channel URI is an opaque provider credential: it is
accepted only on the registration endpoint, stored in the service-private
event store, and never returned or logged.

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

`GET /api/v1/notifications/events` requires the anonymous capability in the
`x-fast-wallet-installation-id` HTTPS header. It returns and removes pending
opaque events. The agent does not put this value into a URL, so it is not part
of normal access logs. This is deliberately at-most-once delivery: an event
may be lost if the agent crashes after its retrieval; it must never be shown
repeatedly after service restart.

`POST` and `DELETE /api/v1/notifications/installations` are the Windows WNS
registration endpoints. Both require the same anonymous installation
capability in `x-fast-wallet-installation-id`. Registration accepts only a
Windows WNS channel hosted at `*.notify.windows.com`; it rejects arbitrary
URLs, so the gateway cannot be used as an SSRF relay. A successful event is
kept in the local opaque fallback queue and is also sent as a generic WNS toast
when a current WNS registration exists. The toast carries no wallet data or
event identifier.

## WNS server configuration

Set these three values **only on the gateway host** in
`/etc/monero-fast-wallet/notification-gateway.env`, then restart the service:

```ini
NOTIFICATION_GATEWAY_WNS_CLIENT_ID="<Microsoft Entra application (client) ID>"
NOTIFICATION_GATEWAY_WNS_CLIENT_SECRET="<Microsoft Entra client-secret Value>"
NOTIFICATION_GATEWAY_WNS_TENANT_ID="<Microsoft Entra Directory (tenant) ID>"
```

This uses Microsoft's current Windows App SDK / Microsoft Entra OAuth flow:
the gateway obtains a token from the tenant-specific Microsoft identity
endpoint with the `https://wns.windows.com/.default` scope. The client secret
**Value** (not its Secret ID) must not be copied into the desktop app,
committed to Git, printed to a terminal, or passed through the deployment
script. All three values must be present together. Without them the service
keeps opaque local polling working but rejects WNS registration with `503`, and
the desktop correctly reports that closed-app WNS is unavailable.

For a packaged Windows desktop release, Microsoft additionally requires a
**multi-tenant** Entra app registration and a one-time mapping of the Store
Package Family Name (PFN) to that Entra Application ID. Submit that mapping to
`Win_App_SDK_Push@microsoft.com` with the PFN, Application (client) ID, and the
service-principal Object ID. Microsoft processes these mapping requests on a
weekly cadence. Do not treat the Partner Center WNS screen or a local MSIX test
certificate as a substitute for that mapping.

## Live deployment

From the repository root on the Mac:

```bash
bash services/notification-gateway/deploy/deploy-live-from-macos.sh
```

The command asks for the existing server administrator's sudo password in the
local terminal. It preserves the Community include, backs up the live Nginx,
scanner and gateway configuration, and wires `notify-scanner` to the gateway
over `127.0.0.1`.
