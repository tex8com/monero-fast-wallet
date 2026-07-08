# Wallet Core Testbench

This testbench is the acceptance layer for the wallet brain before React
Native is treated as complete.

It deliberately covers more than the current implementation can pass. Missing
Ledger BLE, hosted scanner block matching, mobile device execution, or funded
send credentials are reported as open gates, not silently skipped.

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
```

The funded harness controls the current mainnet test wallets under
`~/Documents/Monero/tex8-send-tests` without printing secrets. It uses the
forked CLI for black-box parity and the native proof runner for the same
`libwallet_api` path that the mobile bridge uses.

Broadcast is guarded and requires an explicit amount:

```sh
TESTBENCH_ALLOW_REAL_SEND=1 \
FUNDED_SEND_AMOUNT_ATOMIC=100000000 \
tools/wallet-testbench/run-funded-wallet-terminal-harness.sh real-send b a
```

`full` requires real node/device/funded-wallet configuration and exits non-zero
when any required gate is missing.

## Important Environment

```text
MONERO_SOURCE_DIR=$HOME/Documents/Projects/monero-gui/monero
MONERO_BUILD_DIR=/Volumes/4TB/monero-gui-build/tex8-wallet-api
BRIDGE_BUILD_DIR=$HOME/Documents/Projects/monero-fast-wallet/build/native-bridge-monero

CUPRATE_RPC=152.53.133.188:18089
CUPRATE_GRPC=152.53.133.188:18091
OFFICIAL_MONERO_RPC=<host:port>

TESTBENCH_SEND_SOURCE_WALLET=<wallet path>
TESTBENCH_SEND_PASSWORD_FILE=<wallet password file>
TESTBENCH_SEND_DEST_ADDRESS=<destination address>
TESTBENCH_SEND_DEST_WALLET=<destination wallet path>
TESTBENCH_SEND_DEST_PASSWORD_FILE=<destination wallet password file>
TESTBENCH_SEND_AMOUNT_ATOMIC=<atomic amount>
TESTBENCH_ALLOW_REAL_SEND=1
TESTBENCH_SEND_VISIBILITY_ATTEMPTS=12
TESTBENCH_SEND_VISIBILITY_SECONDS=5

TESTBENCH_LEDGER=1
```

The runner must not print seeds, private spend keys, private view keys, wallet
passwords, daemon passwords, push tokens, or raw Ledger messages.

Prefer `*_PASSWORD_FILE` over inline password environment variables. The native
proof runner accepts password arguments as `@/path/to/password-file`, so real
send tests do not need wallet credentials in process logs.

On this Mac, the linked Monero build should stay on `/Volumes/4TB` because the
internal disk is too tight for repeat wallet-core builds.

Use the public server IP for node tests. `tex8.com` is routed through
Cloudflare and is not suitable for raw Monero RPC/gRPC ports.

Current funded wallet inventory:

- `wallet-a` holds the user-funded mainnet test wallet. The 0.025 XMR incoming
  tx is `249cf9d2c5f4cf9e145ef9aef01f0be288ae03b230d88751e988e19c52be68d4`.
- `wallet-b` is the paired mainnet send/receive test wallet.
- Password files stay local beside the wallet files and must never be printed.
