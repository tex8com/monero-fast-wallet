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

Community Discovery has its own full API contract runner. It starts an
isolated encrypted service locally, tests every public endpoint with two fresh
anonymous identities, and removes all generated contacts, messages, blocks,
reports, and identities afterwards:

```sh
bash services/enthusiast-discovery/scripts/run-community-testbench.sh full
```

After the live Community service is deployed, the same privacy-scoped contract
can run against it. It creates only short-lived `TB-...` anonymous identities
and deletes them on completion; bearer tokens are never printed:

```sh
TESTBENCH_COMMUNITY_LIVE=1 \
TESTBENCH_ALLOW_COMMUNITY_LIVE=1 \
TESTBENCH_COMMUNITY_URL=https://xmr.tex8.com/community \
tools/wallet-testbench/run-wallet-core-testbench.sh local
```

Set `TESTBENCH_REQUIRE_DEPLOYED_COMMUNITY=1` to turn a missing live Community
contract into a failing gate. The live run covers the public route, health,
anonymous identity creation, authentication rejection, approximate-area
privacy, discovery, presence refresh, contact approval, chat, cursor queries,
reporting, blocking, and cleanup. The local Rust tests additionally cover
encrypted storage, rate limiting, expiry, and deletion of all related records.

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

## Wallet-sync baseline

`run-sync-benchmark.sh` measures a clean restore through the native
`WalletEngine` proof runner; it does not use `monero-wallet-cli` as the product
wallet path and never broadcasts. It writes separate logs, CPU/RSS samples,
metadata, and `summary.tsv` under `build/wallet-testbench/sync-results`.

Use a dedicated benchmark mnemonic, never a user's main wallet seed:

```sh
export TESTBENCH_SYNC_SEED_FILE=/secure/benchmark-mnemonic.txt
export TESTBENCH_SYNC_PASSWORD_FILE=/secure/benchmark-password.txt
export TESTBENCH_SYNC_NETWORK=stagenet
export TESTBENCH_SYNC_RESTORE_HEIGHT=<positive block height>

# A: upstream-compatible runner + monerod; B: fork + monerod;
# C: fork + Cuprate RPC/gRPC; D: adaptive-stream fork + Cuprate RPC/gRPC.
export TESTBENCH_SYNC_RUNNER_A=/path/to/upstream/monero_wallet_bridge_smoke
export TESTBENCH_SYNC_RPC_A=<monerod-host:port>
export TESTBENCH_SYNC_RUNNER_B=/path/to/fork/monero_wallet_bridge_smoke
export TESTBENCH_SYNC_RPC_B=<monerod-host:port>
export TESTBENCH_SYNC_RUNNER_C=/path/to/fork/monero_wallet_bridge_smoke
export TESTBENCH_SYNC_RPC_C=<cuprate-host:port>
export TESTBENCH_SYNC_GRPC_C=<cuprate-host:port>
export TESTBENCH_SYNC_RUNNER_D=/path/to/adaptive/monero_wallet_bridge_smoke
export TESTBENCH_SYNC_RPC_D=<cuprate-host:port>
export TESTBENCH_SYNC_GRPC_D=<cuprate-host:port>
tools/wallet-testbench/run-sync-benchmark.sh restore all
```

For the isolated TEX8 Stagenet node, use `private-node-ip:48089` (RPC) and
`private-node-ip:48091` (gRPC) for profile C. Do not use an SSH proxy.

This is stage one only. Resume, concurrent-wallet, restart, reorg/cache, and
Ledger scenarios require controlled test infrastructure and must be recorded
as separate runs rather than substituted with a restore result. See
`docs/WALLET_SYNC_EVALUATION_2026-07-23.md` for the decision gate and privacy
constraints.

`summary.tsv` names the implementation and records elapsed time, blocks/s,
authoritative gRPC payload MiB/s (from the one stream-close record), gRPC
chunk count, output-scan and transaction-hash-cache rates, TCP bytes in/out,
CPU user/system seconds, and maximum RSS. `client-network-accounting.txt`
defines the separate network column consistently: client-side TCP-RX payload
bytes from `nettop`, divided by the client-process time; it excludes IP/TCP
packet headers and carries the prior counter across a socket reset. The raw
CSV is retained, so the derived value is auditable. The legacy HTTP payload
has no gRPC envelope; its TCP-RX total is therefore taken from this same
per-process accounting rather than guessed from log lines. A clean restore comparison runs profiles serially: that is the
only fair way to compare one-wallet speed. Concurrent wallets are a separate
aggregate-throughput stress scenario, never mixed into the baseline table.

## Raw ScanPack transport diagnostics

`run-raw-grpc-payload-mainnet.sh` is deliberately not a wallet benchmark. It
drains the real pruned `StreamBlocks`/ScanPack payload from a fixed height,
but does not decode it, derive keys, scan outputs or commit a chain. It exists
only to distinguish an actual gRPC/WAN transport ceiling from wallet CPU.

The script writes the same preflight/postflight, client CPU/RSS and network
samples, server socket/CPU/RAM/I/O archive, service journals and SHA-256
manifest as an E2E run. It never restarts Cuprate or changes server
configuration. Invoke it with `bash`, a unique Run-ID, and no inline secrets:

```sh
RAW_GRPC_TEST_MODE=range_pool \
RAW_GRPC_RANGE_CONNECTIONS=4 \
RAW_GRPC_RANGE_BLOCKS=40000 \
RAW_GRPC_RANGE_BOOTSTRAP_BLOCKS=1000 \
RAW_GRPC_CHUNK_HINT=256 \
bash tools/wallet-testbench/run-raw-grpc-payload-mainnet.sh <unique-run-id>
```

`RAW_GRPC_TEST_MODE=range_pool` tests the product-like ordered temporary
spool. `fanout` snapshots a tip and drains disjoint streams concurrently,
without an order, spool, parser or scanner; it is a transport ceiling test
only. Neither mode belongs in the Original/Fast/ScanPack Wallet comparison
table. The full D6 results and their artifact hashes are in
`docs/WALLET_SYNC_BENCHMARK_RESULTS.md`.
