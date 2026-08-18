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
its interleaved control window. See
`docs/XMRIG_CPU_OPTIMIZATION_2026-07-29.md` for Original, V1-V37, profiler
evidence, and every rejected hypothesis.

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
| `0014` | Opt-in macOS worker QoS set before thread start |
| `0015` | Keep the asynchronous file-log handle alive through libuv close |

All performance experiments are default-preserving or opt-in. None changes
RandomX consensus rules. Every benchmarked variant must pass the known hash
before its speed can be considered.

Patch `0013` is a host-safety correction found during the V32 QoS test:
upstream returned each CPU to class-of-service 0 but did not restore the
original class-1 L3 mask. The patch saves and restores both registers on every
CPU. It is retained for correct cleanup; QoS itself was only +0.03% against
automatic placement in the six-round official V33 comparison and is not a
promoted speed setting.

## Apple M4 result (initial phase)

The Apple Silicon path uses a separate local source preparation, build, and
benchmark flow:

```bash
./download-xmrig-macos.sh
./prepare-m4-source.sh .work/m4/xmrig-v6.26.0-mfw
XMRIG_CXX_FLAGS_RELEASE="-O3 -DNDEBUG -DXMRIG_APPLE_WORKER_QOS=1" \
  ./build-macos.sh .work/m4/xmrig-v6.26.0-mfw .work/m4/build-m4-qos
XMRIG_BINARY="$PWD/.work/m4/build-m4-qos/xmrig" \
MFW_M4_LABEL_PREFIX=m4-qos \
  ./run-m4-thread-sweep.sh
```

`XMRIG_APPLE_WORKER_QOS=1` selects `QOS_CLASS_USER_INTERACTIVE`; value `2`
selects `QOS_CLASS_USER_INITIATED`. The latter scheduled the four-worker test
on the slower core class and is rejected. The macro is opt-in and has no
effect in a default build.

The first same-harness 100K sweep on a 10-core base Apple M4 (4 performance +
6 efficiency cores, 16 GiB) measured:

| Workers | 100K H/s | Correct hash | Clean exit |
|---:|---:|:---:|:---:|
| 4, stock scheduling | 2,538.3 | yes | yes |
| 4, interactive QoS | 2,596.5 | yes | yes |
| 6, interactive QoS | 3,212.1 | yes | yes |
| 8, interactive QoS | 3,676.6 | yes | yes |
| 10, interactive QoS | **3,920.8** | yes | yes |

The 10-worker candidate retained **3,846.7 H/s** over the official 250K
validation size and produced `7D6054757BB08A63`. The short sweep is a
screening result, not a final energy-efficiency decision: macOS `powermetrics`
requires privileges unavailable to the unprivileged harness, so exact H/s/W
is still open. See `docs/XMRIG_M4_OPTIMIZATION_2026-08-15.md` for candidate
selection, rejected measurements, thermal caveats, and the next paired gates.

The durable result ledger is `m4-results-2026-08-15.json`. It contains every
captured M4 run, including failed and thermally invalid measurements, with a
`performance_eligible` flag intended for a later `miner benchmark` CLI view.
`m4-results-2026-08-15.tsv` is the smaller human-readable promotion table.
Raw console, telemetry, thermal, battery, binary, and codesign evidence stays
under `.work/m4/results/` and is referenced by `evidence_directory` in the
ledger; copy those directories into versioned benchmark evidence before a
release if the raw evidence must travel with the repository.

The macOS harness captures output through a named pipe. Passing XMRig's own
`--log-file` exposed an upstream lifetime bug: an embedded `uv_async_t` was
freed before libuv processed its close queue. Patch `0015` moves the handle to
independent storage and deletes it only from the libuv close callback. The
previously crashing file-log benchmark now exits with status 0.

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

Copy each completed result directory back into
`docs/benchmark-evidence/YYYY-MM-DD/xmrig-cpu/`. Never edit source files
directly on a rented benchmark host.

Verify the copied evidence before using it in a result table:

```bash
python3 verify-evidence.py --json \
  ../../docs/benchmark-evidence/2026-07-29/xmrig-cpu/overnight/results-v19e-v31
```

For dual-CCD results, validate and sum the two child processes separately:

```bash
python3 aggregate-dual-ccd.py \
  ../../docs/benchmark-evidence/2026-07-29/xmrig-cpu/overnight/results-v32plus
```

One V34 orchestrator is intentionally reported invalid because it preserves
the first screen performed with only four available 1 GiB pages. All later
dual runs reserve six pages, verify `3/3` per process, and restore the previous
kernel and MSR state.

## Test-only Zen 4 AVX-512VL Group-E gate

`MFW_X86_GROUP_E_MODE=1` builds an opt-in x86 JIT template that implements
`(converted & mask) | exponent` with four 128-bit `VPTERNLOGQ` instructions.
The option defaults to `0`, and runtime dispatch additionally requires Zen 4,
AVX512F, AVX512VL and enabled AVX-512 OS state. Unsupported CPUs keep the
unchanged SSE path.

The lightweight gate exhaustively evaluates all eight ternary input rows,
reconstructs immediate `0xEA`, checks the capability/dispatch/default-source
contract, cross-assembles the GNU x86-64 template, and verifies four encoded
`VPTERNLOGQ ..., 0xEA` instructions:

```bash
python3 verify-x86-group-e-vpternlog.py
```

The executable correctness gate is deliberately separate and must be run only
on an approved, idle Zen 4 Linux host. It builds both modes in a new work
directory and accepts them only if each offline 250K run produces
`7D6054757BB08A63`:

```bash
./run-x86-group-e-correctness.sh /path/to/MFW-Miner /new/work/directory
```

If the host has no development libuv package, first create a pinned static
user-local prefix without installing system packages:

```bash
MFW_BUILD_JOBS=2 ./prepare-linux-userlocal-libuv.sh \
  /new/deps/libuv-1.52.1 /path/libuv-v1.52.1.tar.gz

MFW_DEPS_PREFIX=/new/deps/libuv-1.52.1 \
MFW_WITH_HWLOC=0 \
MFW_BUILD_JOBS=2 \
MFW_CORRECTNESS_THREADS=4 \
XMRIG_NICE_LEVEL=19 \
XMRIG_TASKSET_CPUS=2,3,8,10 \
XMRIG_SCHED_POLICY=batch \
  ./run-x86-group-e-correctness.sh /path/to/MFW-Miner /new/work/directory
```

`WITH_HWLOC=0` is appropriate only for the verified single-NUMA guest; retain
hwloc for real multi-node EPYC systems. Candidate builds emit the one-time
runtime diagnostic `MFW_X86_GROUP_E_ACTIVE=1` only when the AVX-512VL loop was
actually selected. The gate does not perform pool mining and its output is not
a performance claim.

## EPYC 9634 staged autotune

The 12-vCPU TEX8 guest uses a dry-run-default batch flow because its virtual
L3 IDs do not establish physical CCD placement:

```bash
python3 generate-epyc-autotune.py workers /new/plan/workers.tsv
./run-epyc-autotune-batch.sh /new/plan/workers.tsv /new/results/workers
```

The second command only validates and displays the matrix. Execution needs an
additional acknowledgement and distinct official-XMRig, MFW-mode-0 and
MFW-mode-1 binary paths. Before every row, the executor checks the exact guest
identity, effective CPU set, NUMA node, live idle/steal/swap state, memory,
process residue and requested HugeTLB/MSR capability. It does not stop
services or configure the host. `summarize-epyc-autotune.py` keeps dataset
initialization separate from core H/s and rejects missing hashes, mismatched
threads and excessive repeat drift.

See `benchmarks/hosts/TEX8_EPYC9634_AUTOTUNE_PLAN_2026-08-16.md` for the
staged matrix and capability/privilege boundaries.

`run-tex8-maintenance-window.sh` is a separate, explicitly acknowledged
operator wrapper. It snapshots the exact container and application-unit sets,
stops only that application stack, runs one supplied command, then restores
and verifies exact names, health, units, runtimes and miner residue even after
failure. It never stops SSH or networking. `with-epyc-hugepages.sh` can be
nested inside that window to reserve a bounded 2 MiB pool and restore the
original pool before service startup. Both wrappers are fail-closed and are
not invoked by the batch executor itself.

The executor now supplies `--no-huge-pages` for a no-page row and verifies
actual RandomX dataset and worker allocation counts. A 2 MiB row must log
1168/1168 dataset pages and one page for every worker. 1 GiB execution is
disabled until an equivalent runtime log gate is implemented. This prevents
the benchmark CLI from silently overriding a JSON-only page setting.

## Skylake-S ISWAP quiet gate

`run-skylake-iswap-quiet.sh` is a dry-run-default matched-build ABBA+BAAB
runner for the verified Xeon E3-1585L v5 host. It uses seven workers on CPUs
0-6, 250K, 45-second pauses and a fresh three-sample idle/swap/I/O gate before
every row. It does not stop services or change the host. The resulting
aggregate is never promoted when either path spans more than 2% of its mean.
The 2026-08-16 retest failed that gate, so the ISWAP mode remains default-off.

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
