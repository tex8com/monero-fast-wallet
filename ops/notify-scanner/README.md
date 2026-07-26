# Notify Scanner Deployment

This directory contains the production wiring for the Fast Receive scanner API.
Raw Monero RPC still uses the Cuprate public IP, while the scanner uses the
local Cuprate gRPC listener only as a block-source fallback. The scanner API
is normal HTTPS and should be reached through the existing `tex8.com` TLS
route.

Production scanner URL:

```text
https://xmr.tex8.com
```

The root path is a public human-readable service page with links to GitHub and
project documentation. The machine API stays under `/v1/fast-receive/...`.

DNS status:

```text
xmr.tex8.com A 152.53.133.188
Cloudflare proxy: DNS only
```

The DNS record must stay unproxied because the wallet uses raw Cuprate RPC on
the same host. Cloudflare's HTTP proxy is not suitable for `18089`.

Expected acceptance check:

```sh
TESTBENCH_NOTIFY_SCANNER_LIVE_SOURCES=1 \
TESTBENCH_REQUIRE_DEPLOYED_SCANNER=1 \
TESTBENCH_SCANNER_URL=https://xmr.tex8.com \
tools/wallet-testbench/run-wallet-core-testbench.sh local
```

## GitHub Deploy

Deploy production only from a pushed GitHub commit. The server already has
GitHub SSH access for `git@github.com:tex8com/monero-fast-wallet.git`, so the
deploy path does not need `scp`.

The deploy writes these operational targets:

```text
/srv/monero-fast-wallet/monero-fast-wallet-git-deploy
/srv/monero-fast-wallet/monero-fast-wallet-runtime/bin/notify-scanner
/srv/monero-fast-wallet/monero-fast-wallet-runtime/notify-scanner.env
/etc/systemd/system/notify-scanner.service
/etc/nginx/snippets/notify-scanner-tex8-location.conf
/etc/nginx/sites-available/xmr.tex8.com
```

It backs up existing runtime/systemd/Nginx files under
`/srv/monero-fast-wallet/monero-fast-wallet-deploy-backups`, verifies with local and
public health checks, and prints the rollback path at the end.

Run from the MacBook, replacing `<commit>` with the pushed commit:

```sh
ssh -tt private-ssh-host 'sudo bash -lc '"'"'
set -euo pipefail
COMMIT=<commit>
TMP=/tmp/monero-fast-wallet-deploy-source
rm -rf "$TMP"
sudo -u server -H git clone --depth 1 --branch codex/wallet-testbench-scanner-deploy git@github.com:tex8com/monero-fast-wallet.git "$TMP"
sudo -u server -H git -C "$TMP" fetch --depth 1 origin "$COMMIT"
sudo -u server -H git -C "$TMP" checkout --detach "$COMMIT"
SOURCE_DIR="$TMP" "$TMP/ops/notify-scanner/deploy-from-github.sh" "$COMMIT"
'"'"''
```

## Server Layout

```text
/srv/monero-fast-wallet/monero-fast-wallet-git-deploy
/srv/monero-fast-wallet/monero-fast-wallet-runtime/bin/notify-scanner
/srv/monero-fast-wallet/monero-fast-wallet-runtime/notify-scanner.env
/srv/monero-fast-wallet/monero-fast-wallet-runtime/notify-scanner-watch.json.enc
/etc/systemd/system/notify-scanner.service
```

The runtime env file must be created on the server and must not be committed.
Use a new random `NOTIFY_SCANNER_STORAGE_KEY` and, when public writes are
enabled, a server-only `NOTIFY_SCANNER_AUTH_TOKEN`.

```text
NOTIFY_SCANNER_BIND=127.0.0.1:8087
NOTIFY_SCANNER_WATCH_DB=/srv/monero-fast-wallet/monero-fast-wallet-runtime/notify-scanner-watch.json.enc
NOTIFY_SCANNER_STORAGE_KEY=<32-byte hex or base64 key>
NOTIFY_SCANNER_SCANPACK_DIRECTORY=/var/lib/cuprate/wallet-scan-cache-100k
NOTIFY_SCANNER_SCANPACK_NETWORK=mainnet
NOTIFY_SCANNER_CUPRATE_GRPC_ENDPOINT=127.0.0.1:48091
NOTIFY_SCANNER_CUPRATE_RPC_ENDPOINT=http://private-node-ip:18089
NOTIFY_SCANNER_BLOCK_SCAN_MAX_BLOCKS=25
NOTIFY_SCANNER_BLOCK_SCAN_INTERVAL_MS=10000
NOTIFY_SCANNER_CUPRATE_GRPC_CHUNK_BLOCKS=200
NOTIFY_SCANNER_TEST_AUTH_TOKEN=<server-only-test-token>
```

`NOTIFY_SCANNER_TEST_AUTH_TOKEN` is generated automatically by the deployer if
it is missing. It enables the separately authenticated `POST
/v1/fast-receive/test/incoming-transaction` route. The route creates an opaque
test notification only for an existing Fast Wallet identity and deliberately
accepts no address, amount, transaction id, or key material. Keep the token on
the server; it is not an app credential and must never be bundled in a client.

## Nginx Route

Install the location snippet inside the `xmr.tex8.com` HTTPS server block:

```text
include /etc/nginx/snippets/notify-scanner-tex8-location.conf;
```

The snippet maps:

```text
https://xmr.tex8.com/
https://xmr.tex8.com/healthz
https://xmr.tex8.com/v1/fast-receive/...
```

to the local service at `127.0.0.1:8087`.

## Verification

```sh
systemctl status notify-scanner --no-pager
curl -fsS http://127.0.0.1:8087/healthz
curl -fsS https://xmr.tex8.com/healthz
TESTBENCH_SCANNER_URL=https://xmr.tex8.com \
TESTBENCH_REQUIRE_DEPLOYED_SCANNER=1 \
tools/wallet-testbench/run-wallet-core-testbench.sh local
```

Rollback is stopping/disabling `notify-scanner.service`, removing the Nginx
include from the `xmr.tex8.com` server block, reloading Nginx, and restoring the
previous service binary from backup.

The public HTTPS scanner route also requires an Nginx certificate that covers
`xmr.tex8.com`. Until that certificate and server block are installed,
`https://xmr.tex8.com/healthz` will fail even though the raw Cuprate ports are
reachable.
