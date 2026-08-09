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

Run the serial strict Mainnet comparison only when exclusive control over the
TEX8 Cuprate service is available. The harness freezes the P2P tip, executes
ScanPack, Fast-without-cache and Original in sequence, enforces the exact same
restore height and postflight tip, and restores production in its exit trap:

```sh
tools/wallet-testbench/run-strict-mainnet-sync-matrix.sh <matrix-id>
node tools/wallet-testbench/summarize-strict-mainnet-sync-matrix.mjs <matrix-id>
```

The generated `strict-summary.json` is derived exclusively from immutable raw
client logs, process/TCP samples, exact server journals and the archived
one-second server telemetry. Missing stages remain `null`/`n/a`; no historical
value is substituted. Invalid setup attempts remain archived with
`INVALID.md`. This workflow does not use GitHub Actions or CI.

Build and verify the untouched official CLI beside the product CLI:

```sh
tools/monero-upstream/build-cli-pair.sh \
  <official-source> <patched-source> \
  <official-build> <product-build> <output-dir>

MFW_PRODUCT_CLI_BINARY=<output-dir>/monero-fast-wallet-cli \
MFW_ORIGINAL_CLI_BINARY=<output-dir>/monero-wallet-cli-original \
MFW_CLI_TESTBENCH_OUTPUT=<new-artifact-directory> \
node tools/wallet-testbench/test-product-cli-bootstrap-contract.mjs
```

Without the two binary variables the contract audits source identity and
build/debug wiring only. With them it also validates provenance JSON, confirms
that the original binary has no product debug flags, rejects invalid debug
levels and exercises a controlled failed wallet-open. The latter must write
`debug-environment.json`, `debug-manifest.json`, `debug-summary.json`,
`debug-events.jsonl` and `debug-text.log` without wallet secrets. The command
is included in the integrated wallet-Core testbench. The first measured macOS
bootstrap result is documented in
`docs/MONERO_FAST_WALLET_CLI_BOOTSTRAP_TEST_RESULTS_2026-08-06.md`.

Exercise guarded wallet-file removal without any network or real funds:

```sh
tools/monero-upstream/test-wallet-removal.sh \
  <output-dir>/fast-wallet-cli
```

With `MFW_CLI_PAIR_DIR=<output-dir>`, the integrated testbench runs this as a
separate gate. With both `MFW_CLI_PAIR_DIR` and
`MFW_REGTEST_MONEROD_BINARY`, it also creates a private 82-block Regtest
chain, pays 1 XMR and 2 XMR into two accounts, proves aggregate/history
parity, and removes only a copied positive-balance wallet fixture. The
complete evidence is documented in
`docs/FAST_WALLET_CLI_WALLET_REMOVAL_TEST_RESULTS_2026-08-06.md`.

Address-generation profiling can be run on its own. The defaults create five
fresh software wallets and 64 subaddresses, which is long enough for useful
median/p95 values but intentionally not a stress test:

```sh
tools/wallet-testbench/run-address-generation-benchmark.sh stagenet 5 64
```

Every product-Core call in that scenario is written separately in
milliseconds, followed by count/min/median/p95/max/mean/total summaries for:

- `WalletEngine.createWallet` (primary-address path, including entropy, keys,
  KDF, and the initial wallet-file write);
- primary `getAddress` and native address validation;
- `WalletEngine.createSubaddress`;
- subaddress `getAddress` and native address validation;
- `WalletEngine.closeWallet`; and
- construction of the shared `WalletEngine`.

The runner also reports the slowest p95 call for the whole flow and for the
steady-state subaddress flow. It never prints addresses, seeds, wallet
passwords, or private keys. Raw per-call evidence and a compact summary are
stored under `build/wallet-testbench/address-generation-results`.

The benchmark first prepares the same exact common Core tree used by Desktop,
iOS, and Android. It cannot fall back to a neighbouring Monero checkout or an
older unversioned archive. The current Apple-Silicon reference is about 179 ms
median / 194 ms p95 for a new wallet including its primary address; address
reads, validation, and subaddress operations are all below 1 ms. Product
diagnostics must keep Core time separate from AppVault, registry, UI, and
network time so a regression cannot be hidden behind one generic spinner.

Verify the cross-platform Core identity contract without building an app:

```sh
node --test tools/wallet-testbench/test-common-wallet-core-contract.mjs
```

Audit the complete shared multi-wallet synchronization boundary separately:

```sh
node --test tools/wallet-testbench/test-network-sync-coordinator-contract.mjs
```

Verify the Ledger speed boundary separately:

```sh
node tools/wallet-testbench/test-ledger-owned-output-sync-contract.mjs
```

The checked-in official-GUI Ledger reference is also a mandatory local
testbench gate. It compares the hashed official CSV exports with every
screenshot-visible transaction, the account balances and the CSV integrity
manifest. It is local-only and opens neither a wallet nor a Ledger device:

```sh
node --test tools/wallet-testbench/test-official-ledger-reference-contract.mjs
```

This rejects any regression that starts a second historical blockchain scan
through Ledger. The local private-view wallet owns the full scan; hardware work
must scale only with the locally discovered owned outputs.

This distinguishes the already implemented app-wide unlock/UI lifecycle and
bounded exact-range cache from the still stricter V1 requirement: one native
node handshake, block transport, parser and mempool feed per active network.
The final test remains an explicit TODO until the WalletEngine exposes the
cursor, immutable-batch consumption, detach and checkpoint operations listed
in `docs/V1_EXECUTION_PLAN.md`. The main `full` runner treats that TODO as a
failing release gate.

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

Every patched-core run also emits machine-readable `[SYNC_METRIC]` records.
They deliberately separate gRPC network receipt, Bin-RPC wire receipt,
bounded-queue backpressure, consumer wait, wallet key derivation, output scan,
chain commit and the overlapped pipeline iteration. An actual gRPC-to-Bin-RPC
route change emits `[SYNC_FALLBACK]` with its scope, stable reason token,
error class/code and affected block coordinates. This makes a silent Fast
Wallet fallback a test failure that can be counted from the preserved log.

Verify that the required events cannot disappear during a patch update:

```sh
node tools/wallet-testbench/test-sync-observability-contract.mjs
```

## Ledger key-image sync benchmark

`run-ledger-key-image-benchmark.sh` uses the same linked
`monero_wallet_bridge_smoke` and authenticated common Core as the applications.
It first measures the encrypted local view-wallet sync, then measures Ledger
key-image reconciliation and durable store separately. An optional observer
wallet keeps the shared network coordinator busy while Ledger work runs.

The command mutates and stores the supplied encrypted view-wallet. Use only an
isolated copy and never a user's only wallet cache. Passwords are supplied via
regular, non-symlink files and are never written to the retained summary.

```sh
export TESTBENCH_LEDGER_RUNNER=/path/to/monero_wallet_bridge_smoke
export TESTBENCH_LEDGER_NETWORK=mainnet
export TESTBENCH_LEDGER_HARDWARE_WALLET=/isolated/ledger-cache
export TESTBENCH_LEDGER_HARDWARE_PASSWORD_FILE=/secure/ledger-password
export TESTBENCH_LEDGER_VIEW_WALLET=/isolated/ledger-view-cache
export TESTBENCH_LEDGER_VIEW_PASSWORD_FILE=/secure/view-password
export TESTBENCH_LEDGER_DAEMON=xmr.example:443
export TESTBENCH_LEDGER_GRPC=xmr.example:48091
export TESTBENCH_LEDGER_DAEMON_TLS=1

# Optional concurrent scanner, already behind the current tip:
export TESTBENCH_LEDGER_OBSERVER_WALLET=/isolated/observer-cache
export TESTBENCH_LEDGER_OBSERVER_PASSWORD_FILE=/secure/observer-password

tools/wallet-testbench/run-ledger-key-image-benchmark.sh <unique-run-id>
```

The aggregate wallet-core testbench exposes this as a separate physical gate.
Set `TESTBENCH_LEDGER_KEY_IMAGE=1` together with the variables above. Merely
setting `TESTBENCH_LEDGER=1` runs only device discovery and cannot satisfy the
key-image correctness/performance gate.

The paired view wallet must contain at least one locally discovered owned
output whose Key Image is still pending. The runner rejects a zero-output run:
only a run with `pending_outputs > 0` and exactly matching Ledger derivations
can be accepted.

To create a fresh, isolated hardware-cache/view-wallet pair, use the linked
proof runner while the Ledger is connected, unlocked and has the Monero app
open. Both target paths must be new. The Ledger explicitly asks for view-key
export; the command prints neither the address nor the private view key.

```sh
monero_wallet_bridge_smoke ledger-create-view-wallet \
  mainnet /isolated/ledger-hardware @/secure/hardware-password \
  /isolated/ledger-view @/secure/view-password 3720000 Ledger
```

An unencrypted trusted-daemon control run is refused unless the operator sets
`TESTBENCH_ALLOW_INSECURE_TRUSTED_DAEMON=1` explicitly. Such a control is not a
production security acceptance.

Run the deterministic pipeline, rollback and CLI contracts without hardware:

```sh
node --test \
  tools/wallet-testbench/test-ledger-key-image-source-audit.mjs \
  tools/wallet-testbench/test-ledger-key-image-pipeline-model.mjs \
  tools/wallet-testbench/test-ledger-key-image-benchmark-contract.mjs
```

The source audit proves the incremental Core path, ordered session locking,
transactional rollback, zero-work second run and secret-free phase telemetry.
A passing source audit still does not mean the physical production gate has
passed; only the real runner plus the Ledger failure/reorg/concurrency matrix
can establish that.

## Official Ledger-history reference comparison

The checked-in official GUI exports under
`docs/reference-evidence/ledger-nano-x-official-gui-2026-08-09/` are an
integrity-pinned private reference fixture.  Validate the fixture itself
without a device:

```sh
node --test tools/wallet-testbench/test-official-ledger-reference-contract.mjs
```

For a physical comparison, create an isolated view wallet via
`ledger-create-view-wallet`, refresh it with `list-txs`, then run:

```sh
node tools/wallet-testbench/verify-official-ledger-cli-history.mjs \
  <official-account-index> <private-bridge-output> <private-sanitized-report>
```

The verifier accepts only a fully synchronized refresh and requires exact
TxID, direction, atomic amount, fee and block-height equality. It stores no
address, key, seed or transaction identifier in its report. A view-only scan
can recognize incoming history but cannot classify every outgoing transaction
until the separate Ledger key-image reconciliation has completed.

Summarize a preserved native log without mixing per-channel gRPC rates with
end-to-end throughput. Pass the measured process duration only when the latter
is required:

```sh
node tools/wallet-testbench/summarize-sync-telemetry.mjs sync.log <elapsed-ms>
```

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

## Shared Product-Core gate

`native/product-core/scripts/run-testbench.sh` is the mandatory ABI and
telemetry gate used by the broader wallet-core testbench. It verifies generated
C/Rust/TypeScript/Kotlin/Swift contracts, byte-exact event vectors, strict
diagnostic result sanitization, existing runner adapters, queue-pressure
behavior and paired synthetic logger overhead. The synthetic overhead result
must never be placed in the Original/Fast/ScanPack wallet-sync table.
