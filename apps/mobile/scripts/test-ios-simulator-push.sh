#!/usr/bin/env bash
# Simulates the *same opaque event contract* consumed by FastWalletPushService
# on the currently booted iOS Simulator.  This is a simulator presentation and
# app-routing test only: it does not obtain an APNs token, exercise Firebase,
# register with the TEX8 gateway, or prove closed-app provider delivery.
set -euo pipefail

bundle_id="${IOS_BUNDLE_ID:-com.tex8.monerowallet}"
payload="$(mktemp -t monero-wallet-simulator-push.XXXXXX.apns)"
trap 'rm -f "$payload"' EXIT

cat >"$payload" <<EOF
{
  "Simulator Target Bundle": "$bundle_id",
  "aps": {
    "alert": {
      "title": "Monero Fast Wallet",
      "body": "A private wallet update is ready."
    },
    "sound": "default"
  },
  "type": "monero.fast_wallet.incoming",
  "contractVersion": "monero-fast-wallet-push.v2",
  "eventId": "fwpush_$(openssl rand -hex 16)"
}
EOF

xcrun simctl push booted "$bundle_id" "$payload"
echo "Simulator accepted an opaque Fast Wallet event for $bundle_id."
echo "This is not evidence of APNs/FCM registration or closed-app delivery."
