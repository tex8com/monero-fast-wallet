# Monero GUI — Fast Crypto Edition

**Author:** Roland Kohlhuber  
**Based on:** [monero-project/monero-gui](https://github.com/monero-project/monero-gui)  
**Optimized Node:** [tex8com/cuprate](https://github.com/tex8com/cuprate/tree/fast-rpc) — use both together for maximum sync speed

---

## What changed

### 1. Fast Crypto (1.65x faster scanning)

The wallet's innermost cryptographic function `generate_key_derivation()` — responsible for scanning every transaction during sync — has been replaced with a Rust/[curve25519-dalek](https://github.com/dalek-cryptography/curve25519-dalek) implementation via C FFI. The original Monero wallet uses the `ref10` C library from 2014. This fork replaces only the scalar multiplication with a modern, optimized implementation. **Zero changes** to wallet logic, GUI, Ledger support, or protocol code.

### 2. gzip RPC Compression (2-3x less network transfer)

The wallet sends `Accept-Encoding: gzip` in HTTP requests and decompresses gzip responses from the node. When connected to a gzip-capable node (like [tex8com/cuprate](https://github.com/tex8com/cuprate/tree/fast-rpc)), block data is compressed before transfer — reducing bandwidth usage by 2-3x. **Fully backwards compatible:** against standard nodes (monerod) that don't support gzip, responses arrive uncompressed as usual.

### 3. Increased Block Batch Limits (50 MB per batch)

Block batch limits have been increased (`MAX_BLOCK_COUNT` 1000→10000, `MAX_RPC_CONTENT_LENGTH` 1MB→50MB). This allows downloading more blocks per request when connected to a node with matching limits (like [tex8com/cuprate](https://github.com/tex8com/cuprate/tree/fast-rpc)). Against standard nodes, the node's lower limits apply — no negative effect.

### 4. macOS 26+ Ledger Crash Fix

Ledger HID calls are dispatched to the main thread on macOS (PAC pointer authentication enforcement).

### 5. Parallel `fast_refresh` — hash-phase goes 12× faster

The first sync phase (`fast_refresh`) pulls only block **hashes** to advance `m_blockchain`, then the block-scan phase follows. Upstream does this serially: one `get_hashes` request at a time, ~250 blocks per round-trip.

This fork fires **16 parallel `pull_hashes_extra` calls** in every round, each requesting a disjoint height range. A dedicated client pool (`m_pull_clients`, `PARALLEL_FETCH_COUNT = 16`) keeps connections hot. Against a node that answers `get_hashes` with a bulk-range path (like [tex8com/cuprate](https://github.com/tex8com/cuprate/tree/fast-rpc) with its `BlockHashInRange` handler), 100 k hashes are returned per call.

**Result:** fast_refresh on a Ledger restore drops from **~6 min → ~30 s** (≈12× faster).

### 6. Speculative block prefetch — pipeline the block-scan phase

Upstream pulls a batch of blocks, parses/scans them, then pulls the next batch. The wallet sits idle on every network round-trip.

This fork makes the main `pull_blocks` call run **concurrently** with 16 speculative `pull_blocks_extra` prefetches at future heights (not after). When the main batch finishes parsing, the next batch is already in memory. Gap validation discards prefetches that don't align with the actual chain advance (daemons return variable block counts).

**Result:** block-scan iteration goes from ~300 blocks/s → **~738 blocks/s** (≈2.5× faster). 17 000-block iterations land in 22–23 s.

### 7. HASHCHAIN_BOUNDS_FAIL recovery

If the cached `m_blockchain` is out of sync with the daemon (common after switching between nodes with different chain tips), the wallet used to loop forever on `HASHCHAIN_BOUNDS_FAIL`. This fork detects the inconsistency and truncates `m_blockchain` back to a valid height, then re-runs `fast_refresh` to catch up. No more hung syncs after node-switch.

### 8. `daemonBlockChainTargetHeight` TTL: 30 s → 600 s

The Qt UI polled `get_info` every 30 s to update the "target height" indicator. Because epee's HTTP client is **strictly serial per connection**, this poll would queue behind an in-flight 50 MB `get_blocks` response and block the scan callback for up to **12 s per hot block**. Raising the TTL to 600 s during sync eliminates the stall without losing UI responsiveness.

### 9. epee deserialization limits: 65536×3 → 65536×16

With 50 MB batches carrying ~2000 blocks × ~40 txs × nested ring/output structs, the default epee object/field/string limits (`65536 × 3 ≈ 200 k`) overflowed and deserialization silently failed. Raised to `65536 × 16 ≈ 1 M` per dimension.

### 10. Cross-machine PERF correlation

Every binary RPC request carries an `X-Perf-Req-Id` header plus `send_epoch_ms` / `recv_epoch_ms` wall-clock timestamps. The node (Cuprate fork) echoes the same request-id in its `[PERF RPC]` logs, so a single sync run can be traced end-to-end across both machines without a shared clock. `MCWARNING("global", …)` is used explicitly because `net.http` is filtered at `FATAL` in many builds.

### 11. Optional gRPC streaming sync (Phase 1 complete)

When built with `-DMONERO_ENABLE_GRPC_STREAM=ON` and pointed at a cuprated node that exposes the `[rpc.grpc]` endpoint (see [tex8com/cuprate fast-rpc](https://github.com/tex8com/cuprate/tree/fast-rpc)), the wallet ditches the 16-parallel bin-RPC pull pattern in favour of a single HTTP/2 server-streaming call.

A standalone C++ smoke test (`cuprate/tools/grpc-smoke`) validated the server: **one stream delivered 10 000 blocks at 22.7 MB/s sustained throughput — the 16-parallel bin-RPC baseline tops out around 12.6 MB/s aggregate.** HTTP/2 multiplexing eliminates the per-TCP-connection variance that caps bin RPC at roughly half link bandwidth. The stream carries the chain tip in every chunk, so `get_info` polls no longer stall behind in-flight 50 MB bin responses (the whole reason the TTL was bumped to 600 s in change #8 above).

**Build deps** when `MONERO_ENABLE_GRPC_STREAM=ON`:
- macOS: `brew install grpc`
- Linux: `apt install libgrpc++-dev libprotobuf-dev protobuf-compiler-grpc`

**Enable streaming sync** (zero code changes, existing wallet binary works):
```bash
export CUPRATE_GRPC_ENDPOINT=<cuprate-host>:18091
./bin/monero-wallet-gui.app/Contents/MacOS/monero-wallet-gui   # or monero-wallet-cli
```

Look for `[GRPC client] OPEN ...` and `[GRPC client] CHUNK seq=... cum_mbs=...` in the wallet log. On any stream failure the wallet falls back to bin RPC transparently for the rest of the session.

Default build path (no flag) compiles unchanged — nothing to configure for users staying on bin RPC.

### 12. RAII thread cleanup

Parallel fetch threads are guarded by `epee::misc_utils::create_scope_leave_handler` so an exception between launch and join cannot trigger `std::terminate` (which did happen once when the Ledger disconnected mid-sync).

### Files modified for parallel/prefetch sync

| File | Change |
|------|--------|
| `src/wallet/wallet2.cpp` | Parallel `fast_refresh`, speculative prefetch, gap validation, HASHCHAIN_BOUNDS recovery, `PREFETCH_BATCH = 1000`, `max_block_count = 1000` on `pull_blocks`, RAII scope guards around parallel threads, per-block/per-tx PERF logging (`HOT_BLOCK`, `SLOW_TX`, `callback_on_new_block_us`) |
| `src/wallet/wallet2.h` | `PARALLEL_FETCH_COUNT = 16`, new `pull_hashes_extra(...)` signature, `pull_blocks_extra(..., max_block_count, ...)` param, `pull_and_parse_next_blocks(..., prev_blocks_start_height, ...)` param |
| `src/libwalletqt/Wallet.cpp` | `DAEMON_BLOCKCHAIN_TARGET_HEIGHT_CACHE_TTL_SECONDS` 30 → 600 |
| `contrib/epee/include/storages/http_abstract_invoke.h` | `X-Perf-Req-Id` header, `send/recv_epoch_ms`, gzip-timing, object/field/string limits raised `65536×3 → 65536×16`, `MCWARNING("global", …)` PERF line |

### Measured performance (Apple M4, 50.000 iterations, 3 runs averaged)

| | Ops/s (1 core) | us/Op | Full Restore (1 core) | Full Restore (4 P-cores) |
|---|---|---|---|---|
| **ref10** (original Monero) | 28.200 | 35.5 | 10.0 min | 2.6 min |
| **curve25519-dalek** (this fork) | **46.460** | **21.5** | **6.1 min** | **1.6 min** |
| **Speedup** | **1.65x** | | **39% faster** | **38% faster** |

Correctness verified: **50.000/50.000 identical results** between ref10 and dalek output.

### Files modified (in the `monero` submodule)

| File | Change |
|------|--------|
| `src/crypto/crypto.cpp` | `generate_key_derivation()` calls `fast_generate_key_derivation()` via C FFI — scalarmult + cofactor x8, entirely in Rust |
| `src/crypto/CMakeLists.txt` | Links `libmonero_fast_crypto.a` |
| `src/cryptonote_config.h` | Increased block batch limits: `MAX_BLOCK_COUNT` 1000→10000, `MAX_RPC_CONTENT_LENGTH` 1MB→50MB |
| `src/device/device_io_hid.cpp` | Ledger fix: dispatch HID calls to main thread on macOS (PAC) |
| `external/monero-fast-crypto/` | New: Rust crate wrapping curve25519-dalek, exports C API |
| `share/Info.plist` | Added `NSCameraUsageDescription` for macOS QR scanner |
| `contrib/epee/include/net/http_client.h` | Sends `Accept-Encoding: gzip`, accepts gzip Content-Encoding |
| `contrib/epee/include/storages/http_abstract_invoke.h` | zlib gzip decompression in `invoke_http_bin()` before deserialization |
| `contrib/epee/src/CMakeLists.txt` | Links zlib (`z`) |

---

## Building

### macOS

**1. Install dependencies**
```bash
brew install boost cmake libsodium miniupnpc zeromq hidapi pkg-config qt@5
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

**2. Clone**
```bash
git clone --recursive https://github.com/tex8com/monero-gui.git
cd monero-gui
```

**3. Build Rust crypto library**
```bash
cd monero/external/monero-fast-crypto && cargo build --release && cd ../../..
```

**4. Build GUI**
```bash
mkdir -p build/release && cd build/release
cmake -DCMAKE_BUILD_TYPE=Release -DCMAKE_PREFIX_PATH=$(brew --prefix qt@5) ../..
make -j$(sysctl -n hw.ncpu)
```

**5. Run**
```bash
open bin/monero-wallet-gui.app
```

---

### Linux (Ubuntu / Debian)

**1. Install dependencies**
```bash
sudo apt update
sudo apt install build-essential cmake pkg-config \
  libboost-all-dev libssl-dev libzmq3-dev libunbound-dev \
  libsodium-dev libminiupnpc-dev libhidapi-dev libusb-1.0-0-dev \
  qtbase5-dev qtdeclarative5-dev qtquickcontrols2-5-dev \
  qml-module-qtquick2 qml-module-qtquick-controls2 \
  qml-module-qtquick-layouts qml-module-qtquick-window2 \
  qml-module-qt-labs-settings qml-module-qt-labs-folderlistmodel \
  qml-module-qtgraphicaleffects libqt5svg5-dev
# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
```

**2. Clone**
```bash
git clone --recursive https://github.com/tex8com/monero-gui.git
cd monero-gui
```

**3. Build Rust crypto library**
```bash
cd monero/external/monero-fast-crypto && cargo build --release && cd ../../..
```

**4. Build GUI**
```bash
mkdir -p build/release && cd build/release
cmake -DCMAKE_BUILD_TYPE=Release ../ ..
make -j$(nproc)
```

**5. Run**
```bash
./bin/monero-wallet-gui
```

---

### Ledger Support

Requires `hidapi` and `libusb` (included in dependencies above). Connect your Ledger, open the Monero app, then select "Hardware Wallet" in the GUI.

**macOS 26+ (Tahoe):** The Ledger PAC crash fix is included — no additional steps needed.

## Best performance: use with Cuprate node

For maximum sync speed, connect this wallet to [tex8com/cuprate (fast-rpc branch)](https://github.com/tex8com/cuprate/tree/fast-rpc):

| Setup | Initial Sync (45K blocks) | Block Scan |
|-------|---------------------------|------------|
| This wallet + standard monerod | 19s | network-limited |
| This wallet + **Cuprate (fast-rpc)** | **4s** | **gzip compressed, 50MB batches** |
| Standard wallet + Cuprate | 12s | no gzip (still fast) |

### Ledger initial-restore (full chain, ~3.6 M blocks)

| | Upstream | This fork + Cuprate (fast-rpc) |
|---|---|---|
| `fast_refresh` (hash phase) | ~6 min | **~30 s** (12× faster) |
| Block-scan throughput | ~300 blocks/s | **~738 blocks/s** (2.5× faster) |
| Total restore time | ~16 min | **~3–4 min** (4–5× faster) |

The combined optimizations:
- **gzip compression** — 2-3x less data over the network (only when both sides support it)
- **50MB batch limits** — fewer HTTP round-trips
- **On-the-fly TX pruning** — node strips RCT prunable data before sending
- **Batch output-index lookups** — node computes indices 46x faster
- **1.65x faster crypto** — wallet scans transactions faster
- **16 parallel HTTP clients** — both `fast_refresh` hashes and block prefetch pipelined
- **Speculative prefetch** — next batches arrive while current one is still being scanned

## Known limitations & next steps

### Ledger restore: last ~90.000 blocks are slow

**Symptom:** When restoring a Ledger wallet, the first part syncs quickly, but the last ~90.000 blocks slow down noticeably.

**Root cause — transaction density, not a bug:**
- Fast Crypto (`curve25519-dalek`) does apply for Ledger: `device_ledger::generate_key_derivation()` runs in software when `has_view_key = true` (TRANSACTION_PARSE mode), calling `crypto::generate_key_derivation()` → `fast_generate_key_derivation()`. So the 1.65x speedup is active.
- The bottleneck is that recent Monero blocks contain significantly more transactions and outputs per block than older blocks. Every output requires one `generate_key_derivation()` call.
- The wallet scan loop in `wallet2.cpp` is **single-threaded** — one CPU core at ~100% while 1.4 GB RAM is in use.

**Next step: multi-threaded scanning in `wallet2.cpp`**
The scan loop (`process_new_blockchain_entry`) is the target. Parallelising output checking across P-cores would bring the last 90k blocks in line with the rest of the restore. This is a deeper change to wallet2 and is tracked as the next optimization.

### TCP per-connection variance — the next frontier

With CPU 82% idle and network not saturated (12.6 MB/s aggregate vs 25 MB/s link capacity), the remaining bottleneck is **slowest-wins behaviour across 16 TCP connections**: per-connection throughput varies 0.69–2.87 MB/s (≈4× spread). Raising parallelism beyond 16 gives diminishing returns because every batch has to wait for its slowest connection.

The architectural fix is **HTTP/2 multiplexing** (all streams share one congestion window) or **gRPC streaming** (server-streamed blocks, no per-batch round-trip). Both are tracked as future work — see discussion in this fork's commit history.

## License

Same as upstream Monero: BSD-3-Clause. The Rust library (`monero-fast-crypto`) is MIT.

## Credits

- [The Monero Project](https://github.com/monero-project) for the original wallet
- [dalek-cryptography](https://github.com/dalek-cryptography/curve25519-dalek) for the fast Ed25519 implementation
