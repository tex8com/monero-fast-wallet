# XMRig CPU Testbench

This testbench measures offline Monero RandomX (`rx/0`) performance without
connecting to a mining pool. It is intentionally separate from the wallet
derivation testbenches: RandomX hashes and wallet key derivations are different
operations and their rates must never be compared as if they used the same
unit.

## Reproducibility

- Upstream: `https://github.com/xmrig/xmrig.git`
- Version: `v6.26.0`
- Commit: `b2ca72480c58d197e18c885d9fc1a0c8d517e60a`
- Algorithm: `rx/0`
- Official short validation size: `250K`
- Local testbench size: `100K`

The local patch only allows the existing offline benchmark parser to accept
`100K`. It does not change RandomX, thread scheduling, JIT code, hash
calculation, or timing. Every new machine must first pass an official `250K`
run whose final hash sum matches XMRig's built-in reference.

## Ryzen 9 5950X result

The retained configuration on the Hetzner host is:

```text
31 workers + 1 GiB dataset pages + automatic Zen 3 MSR
+ automatic AMD/BMI2 JIT + scratchpad PREFETCHT0
```

Four alternating official 250K pairs measured:

| Configuration | Median | Factor | Difference |
|---|---:|---:|---:|
| Original XMRig defaults | 15,089.8 H/s | 1.0000x | +0.00% |
| Retained configuration | **15,300.5 H/s** | **1.0140x** | **+1.40%** |

All eight runs matched `7D6054757BB08A63`. V32-V37 subsequently combined
cache QoS, CCD affinity, dual processes, and 31/32 workers; none beat V31 in
its interleaved control window. Keep raw benchmark outputs outside the source
repository via `MFW_BENCHMARK_EVIDENCE_DIR`; this repository retains only the
reproducible testbench and its methodology.

## What is measured

Each run records:

- core benchmark time and hashes per second reported by XMRig;
- selected thread count, affinity, Huge Page status, 1 GiB Page status, and
  MSR status from the XMRig log;
- process and whole-system CPU utilization;
- peak resident memory and virtual memory;
- average observed CPU frequency;
- network receive and transmit deltas;
- cycles, instructions, cache references/misses, branches/misses, context
  switches, CPU migrations, and page faults when Linux `perf` permits them;
- AMD Data Fabric DRAM read/write counters when the host exposes the
  `amd_df` PMU.

The AMD Data Fabric counters are system-wide. They are useful on an otherwise
idle dedicated server but must not be interpreted as process-isolated values.
Network bandwidth should be approximately zero because all runs are offline.

## Local preparation and remote execution

Prepare the exact source tree locally:

```bash
./prepare-source.sh /tmp/xmrig-v6.26.0-mfw
```

Copy the prepared source and the local scripts to the remote machine:

```bash
scp -r /tmp/xmrig-v6.26.0-mfw root@SERVER:/root/mfw-xmrig/source
scp build-linux.sh run-benchmark.sh root@SERVER:/root/mfw-xmrig/
```

Build on the target architecture:

```bash
ssh root@SERVER \
  '/root/mfw-xmrig/build-linux.sh /root/mfw-xmrig/source /root/mfw-xmrig/build-stock'
```

Compiler experiments use the same script and must write to a separate build
directory. For example, a Zen 3 plus LTO build is:

```bash
ssh root@SERVER \
  'XMRIG_C_FLAGS_RELEASE="-O3 -DNDEBUG -march=znver3 -mtune=znver3 -flto=auto -fno-plt" \
   XMRIG_CXX_FLAGS_RELEASE="-O3 -DNDEBUG -march=znver3 -mtune=znver3 -flto=auto -fno-plt" \
   XMRIG_EXE_LINKER_FLAGS="-flto=auto" \
   /root/mfw-xmrig/build-linux.sh \
   /root/mfw-xmrig/source /root/mfw-xmrig/build-znver3-lto'
```

`version-series.tsv` defines the Original and V1-V10 hypotheses used for the
Ryzen 9 5950X investigation. `run-version.sh` applies one variant at a time.
V10 is a real source-level change: patch `0002` makes the prefetch distance in
the fused AES scratchpad hash-and-fill loop a compile-time setting. Candidate
distances must be measured separately; only the best correct candidate is
retained as V10. `build-pgo-linux.sh` remains available for a rejected PGO
experiment. A Zen 3 native plus instrumented build failed its `--version`
smoke test with `SIGILL` and is never considered a benchmark result.

The overnight investigation adds:

- `run-paired-benchmark.sh` for alternating AB/BA comparisons;
- `run-latin-benchmark.sh` for cyclic multi-variant Latin squares, including
  per-variant config files, CPU sets, and `SCHED_BATCH`;
- `run-final-validation.sh` for the official Original-versus-retained pairs;
- `aggregate-overnight.py` for grouping both `-rN` and `-pN` repeats;
- `run-cache-qos-validation.sh` for proving that CAT/QoS activates and that
  the original MSR state is restored afterward;
- `run-dual-ccd-benchmark.sh` for two concurrent CCD-local processes with
  temporary six-page 1 GiB allocation and exact MSR restoration;
- `run-dual-ccd-paired.sh` for alternating a dual-CCD candidate with a
  single-process control;
- `aggregate-dual-ccd.py` for validating both child hashes and reporting their
  combined rate;
- `verify-evidence.py` for checking every captured run's exit status, timeout
  state, required telemetry files, captured-config hash, and official
  100K/250K hash sum;
- `build-profiling-linux.sh`, `build-clang16-linux.sh`,
  `build-jit-offset-linux.sh`, `build-vaes256-linux.sh`, and
  `build-no-bmi2-linux.sh` for isolated binaries.

The patch stack currently contains:

| Patch | Experiment |
|---|---|
| `0001` | Local 100K parser allowance |
| `0002` | AES scratchpad prefetch distance |
| `0003` | Dataset-prefetch hint |
| `0004` | JIT branch alignment |
| `0005` | JIT cache-line offset stride |
| `0006` | Hard-AES unroll factor |
| `0007` | Offline-benchmark accounting diagnostic |
| `0008` | New experimental AVX2/VAES-256 AES implementation |
| `0009` | Clang `xmrig-notls` CMake target fix |
| `0010` | Runtime scratchpad `PREFETCHT1` mode |
| `0011` | BMI2 JIT-path toggle |
| `0012` | Runtime scratchpad `PREFETCHW` mode |
| `0013` | Restore original cache-QoS association and L3-mask MSRs |

All performance experiments are default-preserving or opt-in. None changes
RandomX consensus rules. Every benchmarked variant must pass the known hash
before its speed can be considered.

Patch `0013` is a host-safety correction found during the V32 QoS test:
upstream returned each CPU to class-of-service 0 but did not restore the
original class-1 L3 mask. The patch saves and restores both registers on every
CPU. It is retained for correct cleanup; QoS itself was only +0.03% against
automatic placement in the six-round official V33 comparison and is not a
promoted speed setting.

Use `aggregate-version-series.py` with the three retained result directories
for every version to calculate the median table and the improvement relative
to Original. This prevents a single short run from being reported as a gain.

Run the official validation before any short or tuned tests:

```bash
ssh root@SERVER \
  'XMRIG_BINARY=/root/mfw-xmrig/build-stock/xmrig-notls \
   /root/mfw-xmrig/run-benchmark.sh validation-stock-250k \
   --bench=250K -a rx/0 --no-color'
```

Run a short offline test:

```bash
ssh root@SERVER \
  'XMRIG_BINARY=/root/mfw-xmrig/build-stock/xmrig-notls \
   /root/mfw-xmrig/run-benchmark.sh stock-auto-100k \
   --bench=100K -a rx/0 --no-color'
```

Store completed result directories outside the repository, for example under
`$MFW_BENCHMARK_EVIDENCE_DIR/YYYY-MM-DD/xmrig-cpu/`. Never edit source files
directly on a rented benchmark host.

Verify the copied evidence before using it in a result table:

```bash
python3 verify-evidence.py --json \
  "$MFW_BENCHMARK_EVIDENCE_DIR/2026-07-29/xmrig-cpu/overnight/results-v19e-v31"
```

For dual-CCD results, validate and sum the two child processes separately:

```bash
python3 aggregate-dual-ccd.py \
  "$MFW_BENCHMARK_EVIDENCE_DIR/2026-07-29/xmrig-cpu/overnight/results-v32plus"
```

One V34 orchestrator is intentionally reported invalid because it preserves
the first screen performed with only four available 1 GiB pages. All later
dual runs reserve six pages, verify `3/3` per process, and restore the previous
kernel and MSR state.

## Interpretation

The core hashes-per-second value excludes RandomX dataset initialization. Peak
RAM, process CPU, and Data Fabric counters cover the whole process, including
initialization. Short runs are suitable for rapid tuning, but final candidates
must be repeated and validated with at least `250K` hashes.

Huge Pages and the XMRig MSR modification are expected parts of a tuned
RandomX baseline. Compiler experiments, thread-count sweeps, affinity changes,
prefetch modes, 1 GiB pages, and JIT Huge Pages must be compared against that
tuned baseline rather than against a deliberately degraded configuration.

Small changes require an interleaved same-window control. On this host,
functionally equivalent controls can differ by about 0.1-0.2% in a short run.
A candidate near that range is not a gain until longer official pairs retain
the effect. Failed, timed-out, wrong-hash, concurrently contaminated, or
not-actually-enabled runs must remain visible in the evidence but excluded
from promoted tables.
