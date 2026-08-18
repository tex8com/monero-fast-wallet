# MFW-Miner

MFW-Miner is a performance-focused Monero RandomX miner, benchmark suite and
hardware-tuning project maintained by TEX8 LLP. It is currently based on XMRig
`v6.26.0` at commit `b2ca72480c58d197e18c885d9fc1a0c8d517e60a`.

The active work is to retain XMRig's mature cross-platform engine while adding
measured architecture-specific improvements, automatic tuning, reproducible
upstream comparisons and MFW CLI/Desktop integration.

## Current status

- The source tree builds the `mfw-miner` executable and reports both the MFW
  product version and pinned XMRig engine version.
- Benchmarks are offline and must pass XMRig's official RandomX result hash.
- The Apple ARM64 engine already differs from XMRig 6.26.0: it contains the
  newer RandomX `ISUB_R` JIT correctness fix, Group-E `BIF` code generation
  and an experimental M4 dataset-prefetch selector.
- The disclosed donation policy is set to 1% for official builds. The public
  receiving address is recorded in the gateway example and validated as a
  standard Monero mainnet address. Donation remains hard-disabled in the miner
  until the gateway, fail-open client path and first-run disclosure pass their
  release gates.
- A separate Rust `mfw-donation-gateway` now provides the backend-independent
  Stratum layer. It can route the donation window to a pool, P2Pool or a future
  Stratum-compatible solo coordinator without changing the miner endpoint.
- No fastest claim is valid without an interleaved, like-for-like comparison
  against the pinned unmodified upstream build.

See [ROADMAP.md](ROADMAP.md) and [benchmarks/README.md](benchmarks/README.md).
The gateway design and local-only test instructions are in
[services/mfw-donation-gateway/README.md](services/mfw-donation-gateway/README.md).

## Apple Silicon build

```sh
MFW_APPLE_WORKER_QOS=0 \
MFW_A64_DATASET_PREFETCH=1 \
MFW_A64_GROUP_E_MODE=2 \
  tools/xmrig-cpu-testbench/build-macos.sh . build-mfw-m4
./build-mfw-m4/mfw-miner --version
```

`MFW_APPLE_WORKER_QOS=0` retains upstream scheduling. Values `1` and `2` are
experimental comparison variants and are never selected silently. The first
interleaved M4 screen rejected interactive QoS as the default; see the
comparison ledger under `benchmarks/comparisons/`.

`MFW_A64_DATASET_PREFETCH=1` is the correctness-preserving upstream prefetch
form and remains the default. Values `0`, `2`, `3` and `4` are test-only ARM64
JIT variants. They must not be promoted without a correct, interleaved hardware
comparison.

`MFW_A64_GROUP_E_MODE=2` selects the current Apple-M4 candidate: ARM64 `BIF`
Group-E code with the legacy generated-VM-code offset preserved. Its first
controlled four-thread screen measured +1.6838% and passed the official 250K
hash. A later opposite-order ten-thread block was effectively neutral after
drift correction (+0.14%) and therefore rejects mode `2` for the all-core M4
profile. The generic default remains mode `0` so ten-thread M4 runs, Raspberry
Pi and other ARM64 CPUs do not inherit an unvalidated Apple-specific layout.
Mode `3` is a new test-only layout-stable form: it retains the exact reference
instruction footprint after every generated `FDIV`, making it suitable for a
future runtime-selected JIT template. Its four-thread A-C-C-A screen passed all
official hashes but lost 4.7421% by block mean, so the hot NOP-padded form is
rejected. It remains available only to reproduce that result; it is not a
release profile.

The first longer 250K A-B-B-A screen of mode `2` is excluded from performance
claims: all four hashes were correct and offline, but the control fell 32.32%
between A1 and A2 on the fanless M4. An opposite-order cold B-A-A-B block is
required before this four-performance-core profile can be promoted.

## Test-only Zen 4 Group-E build

The x86-64 baseline remains XMRig's SSE Group-E template. A separately gated
EPYC Zen 4 candidate replaces its four `ANDPD` plus four `ORPD` operations with
four 128-bit `VPTERNLOGQ` operations:

```sh
MFW_X86_GROUP_E_MODE=1 \
  tools/xmrig-cpu-testbench/build-linux.sh . build-mfw-zen4-group-e
```

This mode is never selected by a default build. Even when compiled, it is used
only when runtime detection reports `ARCH_ZEN4`, AVX512F, AVX512VL and the
required AVX-512 OS state. Every other CPU retains the byte-for-byte upstream
SSE template. The static gate proves the exhaustive ternary truth table,
checks that the generic template stayed unchanged, and cross-assembles and
disassembles the candidate:

```sh
python3 tools/xmrig-cpu-testbench/verify-x86-group-e-vpternlog.py
```

On an approved, idle Zen 4 x86-64 Linux host, the separate executable gate
builds SSE and candidate binaries and requires both to produce XMRig's official
250K RandomX hash:

```sh
tools/xmrig-cpu-testbench/run-x86-group-e-correctness.sh \
  "$PWD" /new/empty/work-directory
```

For hosts without development libuv, the testbench includes a SHA-pinned
user-local static libuv builder; see
`tools/xmrig-cpu-testbench/prepare-linux-userlocal-libuv.sh`. The verified
candidate additionally prints `MFW_X86_GROUP_E_ACTIVE=1` from the real JIT
constructor when the opt-in loop is actually selected.

Both TEX8 250K paths passed the official hash. Their host-load phases drifted
too far for a speed claim, so the candidate remains default-off until a quiet
ABBA/BAAB comparison is available. Passing these gates establishes only build
and hash correctness, not a speed improvement.

## Upstream

- Project: <https://github.com/xmrig/xmrig>
- Pinned tag: `v6.26.0`
- Pinned commit: `b2ca72480c58d197e18c885d9fc1a0c8d517e60a`

MFW-Miner preserves XMRig copyright notices and source history. XMRig and its
authors do not endorse MFW-Miner or TEX8 LLP.

## Licensing

MFW-Miner is distributed under GNU GPL version 3. Upstream files retain their
original copyright and license notices. See [LICENSE](LICENSE) and
[NOTICE](NOTICE).
