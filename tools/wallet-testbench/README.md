# Wallet Core Testbench

This testbench is the acceptance layer for the wallet brain before React
Native is treated as complete.

It deliberately covers more than the current implementation can pass. Missing
physical Ledger/device execution, production push credentials, official-node
configuration, or funded send credentials are reported as open gates, not
silently skipped. The local suite also runs the hosted scanner and anonymous
community privacy/API tests.

## Commands

Local development inventory:

```sh
tools/wallet-testbench/run-wallet-core-testbench.sh local
```

Strict full acceptance:

```sh
tools/wallet-testbench/run-wallet-core-testbench.sh full
```

Funded wallet terminal control:

```sh
tools/wallet-testbench/run-funded-wallet-terminal-harness.sh cli-status all
tools/wallet-testbench/run-funded-wallet-terminal-harness.sh native-status all
tools/wallet-testbench/run-funded-wallet-terminal-harness.sh prepare-sweep b a
```

The funded harness controls the current mainnet test wallets under
`~/Documents/Monero/tex8-send-tests` without printing secrets. It uses the
forked CLI for black-box parity and the native proof runner for the same
`libwallet_api` path that the mobile bridge uses.

`prepare-sweep` exercises the app's `MAX` path against real funded Mainnet
outputs through Cuprate. It verifies the exact destination amount and fee
returned by `libwallet_api`, then disposes the pending transaction with
`broadcast=false`.

Backend acceptance with live Cuprate sources and deployed Fast Receive
required:

```sh
TESTBENCH_NOTIFY_SCANNER_LIVE_SOURCES=1 \
TESTBENCH_REQUIRE_DEPLOYED_SCANNER=1 \
TESTBENCH_SCANNER_URL=https://xmr.tex8.com \
tools/wallet-testbench/run-wallet-core-testbench.sh local
```

That command is expected to fail until the public notify-scanner service is
deployed and `/healthz` returns a healthy JSON body such as `{"ok":true}`.

Broadcast is guarded and requires an explicit amount:

```sh
TESTBENCH_ALLOW_REAL_SEND=1 \
FUNDED_SEND_AMOUNT_ATOMIC=100000000 \
tools/wallet-testbench/run-funded-wallet-terminal-harness.sh real-send b a
```

The main runner can also broadcast through the same native bridge once an
amount is explicitly set:

```sh
TESTBENCH_ALLOW_REAL_SEND=1 \
TESTBENCH_SEND_AMOUNT_ATOMIC=100000000 \
tools/wallet-testbench/run-wallet-core-testbench.sh local
```

Hosted Fast Receive E2E is also guarded because it uploads an isolated
private view key to the configured scanner and broadcasts a real payment:

```sh
TESTBENCH_ALLOW_FAST_RECEIVE_E2E=1 \
TESTBENCH_ALLOW_REAL_SEND=1 \
FAST_RECEIVE_E2E_AMOUNT_ATOMIC=50000000 \
TESTBENCH_SCANNER_URL=https://xmr.tex8.com \
tools/wallet-testbench/run-fast-receive-e2e.sh
```

The script creates a fresh isolated fast-receive wallet, extracts only that
wallet's private view key, registers the watch, sends a tiny real mainnet
payment to the hosted address, verifies `pending_mempool`, waits for
`confirmed`, verifies the wallet-core refresh sees the same tx, then removes
the scanner watch unless `FAST_RECEIVE_E2E_KEEP_WATCH=1` is set.

Before broadcasting, it refreshes the source wallet and verifies that the
amount plus a fee safety margin is unlocked. If Monero has locked the outputs,
the gate reports TODO with `real_send_skip_reason=insufficient_unlocked_balance`
instead of broadcasting or claiming success.

`full` requires real node/device/funded-wallet configuration and exits non-zero
when any required gate is missing.

## Important Environment

```text
MONERO_SOURCE_DIR=$HOME/Documents/Projects/monero-gui/monero
MONERO_BUILD_DIR=/Volumes/4TB/monero-gui-build/tex8-wallet-api
BRIDGE_BUILD_DIR=$HOME/Documents/Projects/monero-fast-wallet/build/native-bridge-monero

CUPRATE_RPC=xmr.tex8.com:18089
CUPRATE_GRPC=xmr.tex8.com:18091
OFFICIAL_MONERO_RPC=<host:port>

TESTBENCH_NOTIFY_SCANNER_LIVE_SOURCES=1
TESTBENCH_SCANNER_URL=https://xmr.tex8.com
TESTBENCH_REQUIRE_DEPLOYED_SCANNER=1

TESTBENCH_SEND_SOURCE_WALLET=<wallet path>
TESTBENCH_SEND_PASSWORD_FILE=<wallet password file>
TESTBENCH_SEND_DEST_ADDRESS=<destination address>
TESTBENCH_SEND_DEST_WALLET=<destination wallet path>
TESTBENCH_SEND_DEST_PASSWORD_FILE=<destination wallet password file>
TESTBENCH_SEND_AMOUNT_ATOMIC=<atomic amount>
TESTBENCH_ALLOW_REAL_SEND=1
TESTBENCH_SEND_VISIBILITY_ATTEMPTS=12
TESTBENCH_SEND_VISIBILITY_SECONDS=5

TESTBENCH_ALLOW_FAST_RECEIVE_E2E=1
FAST_RECEIVE_E2E_AMOUNT_ATOMIC=<atomic amount>
FAST_RECEIVE_E2E_SOURCE_WALLET=<funded wallet path>
FAST_RECEIVE_E2E_SOURCE_PASSWORD_FILE=<funded wallet password file>
FAST_RECEIVE_E2E_KEEP_WATCH=0

TESTBENCH_LEDGER=1
```

The runner must not print seeds, private spend keys, private view keys, wallet
passwords, daemon passwords, push tokens, or raw Ledger messages.

Prefer `*_PASSWORD_FILE` over inline password environment variables. The native
proof runner accepts password arguments as `@/path/to/password-file`, so real
send tests do not need wallet credentials in process logs.

On this Mac, the linked Monero build should stay on `/Volumes/4TB` because the
internal disk is too tight for repeat wallet-core builds.

Use `xmr.tex8.com` for node tests. Its DNS record is deliberately DNS-only, so
raw Monero RPC `:18089` and gRPC `:18091` do not pass through Cloudflare's HTTP
proxy. Do not use the general `tex8.com` host for these ports.

Fast Receive is different from raw Monero RPC/gRPC. It needs the separate
notify-scanner HTTPS API, currently planned as `https://xmr.tex8.com`.
A raw IP URL is not acceptable for HTTPS unless a matching certificate exists.

Current funded wallet inventory:

- `wallet-a` holds the user-funded mainnet test wallet. Exact funding and
  transaction details stay in local, non-versioned acceptance logs.
- `wallet-b` is the paired mainnet send/receive test wallet.
- Password files stay local beside the wallet files and must never be printed.
