# Payment Link Resolver

This service creates short-lived, opaque HTTPS links for standard Monero
payment URIs. The QR code and transaction contract remain the interoperable
`monero:` URI; the resolver only adds a cross-platform hand-off and an install
fallback.

Payment details are encrypted at rest, expire after seven days by default and
are never used to initiate a transaction automatically. The wallet still
validates the address, displays the review screen and requires the normal user
or Ledger confirmation.

## Runtime

```text
PAYMENT_LINK_BIND=127.0.0.1:8098
PAYMENT_LINK_DB=/srv/monero-fast-wallet/monero-fast-wallet-runtime/payment-links.json.enc
PAYMENT_LINK_STORAGE_KEY=<32-byte hex or base64url key>
PAYMENT_LINK_PUBLIC_ORIGIN=https://xmr.tex8.com
PAYMENT_LINK_ANDROID_INSTALL_URL=https://tex8.com/xmr/
PAYMENT_LINK_IOS_INSTALL_URL=https://github.com/tex8com/monero-fast-wallet/releases
PAYMENT_LINK_DESKTOP_INSTALL_URL=https://github.com/tex8com/monero-fast-wallet/releases
PAYMENT_LINK_TTL_SECONDS=604800
```

Nginx must proxy `/pay/`, `/v1/payment-requests` and the two `/.well-known/`
association files to this service. Apply the rate limits from
`ops/payment-link-resolver/nginx-payment-link-rate-limits.conf` in Nginx's
`http` context, then include `nginx-payment-links.conf` inside the
`xmr.tex8.com` server block before exposing its public write route.

The Android association contains the SHA-256 fingerprint of the current TEX8
release/upload certificate. If Google Play App Signing is enabled later, add
the Play App Signing certificate from Play Console before shipping that build.

## Production deployment

Production is deployed only from an exact pushed Git commit. The deployer
backs up the current binary, encrypted database, environment, Systemd unit,
Nginx snippets and active `xmr.tex8.com` vhost. It inserts one include only in
the existing HTTPS server block and rolls every changed file back if the
service, Nginx validation or public end-to-end checks fail.

```sh
ssh -tt private-ssh-host 'sudo bash -lc '"'"'
set -euo pipefail
COMMIT=<pushed-commit>
TMP=/tmp/monero-fast-wallet-payment-deploy
rm -rf "$TMP"
sudo -u server -H git clone --depth 1 git@github.com:tex8com/monero-fast-wallet.git "$TMP"
sudo -u server -H git -C "$TMP" fetch --depth 1 origin "$COMMIT"
sudo -u server -H git -C "$TMP" checkout --detach "$COMMIT"
SOURCE_DIR="$TMP" "$TMP/ops/payment-link-resolver/deploy-from-github.sh" "$COMMIT"
'"'"''
```

Acceptance includes both association files, create/resolve/landing-page flow,
the exact signing fingerprint and smoke tests for the pre-existing scanner,
Community and News routes.
