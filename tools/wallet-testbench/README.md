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

`full` requires real node/device/funded-wallet configuration and exits non-zero
when any required gate is missing.

## Important Environment

```text
MONERO_SOURCE_DIR=$HOME/Documents/Projects/monero-gui/monero
MONERO_BUILD_DIR=/Volumes/4TB/monero-gui-build/tex8-wallet-api
BRIDGE_BUILD_DIR=$HOME/Documents/Projects/monero-fast-wallet/build/native-bridge-monero

CUPRATE_RPC=tex8.com:18089
CUPRATE_GRPC=tex8.com:18091
OFFICIAL_MONERO_RPC=<host:port>

TESTBENCH_SEND_SOURCE_WALLET=<wallet path>
TESTBENCH_SEND_PASSWORD=<wallet password>
TESTBENCH_SEND_DEST_ADDRESS=<destination address>
TESTBENCH_SEND_AMOUNT_ATOMIC=<atomic amount>
TESTBENCH_ALLOW_REAL_SEND=1

TESTBENCH_LEDGER=1
```

The runner must not print seeds, private spend keys, private view keys, wallet
passwords, daemon passwords, push tokens, or raw Ledger messages.

On this Mac, the linked Monero build should stay on `/Volumes/4TB` because the
internal disk is too tight for repeat wallet-core builds.
