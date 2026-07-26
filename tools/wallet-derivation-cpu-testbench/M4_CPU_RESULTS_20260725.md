# Monero wallet derivation CPU benchmark: Apple M4 batch path

Date: 2026-07-25
Scope: CPU kernel only, `generate_key_derivation` as `D = 8 * a * R`
Status: implemented and measured in local commit `b63ac1ee40ea2137e95b1816f88ce390f648bd6a`
CI: no GitHub Actions or other CI used

## Result

The accepted M4 path combines:

1. one prepared, constant-time radix-16 scalar;
2. two independent serial scalar multiplications interleaved to expose
   instruction-level parallelism;
3. Montgomery batch inversion for Edwards compression;
4. reusable per-Rayon-task workspaces to avoid repeated allocations;
5. a batch size of 16 and all 10 M4 CPU cores.

The final A/B/B/A/A/B series used one identical binary and corpus for both
variants. The median complete-kernel throughput improved from
`233,023.743` to `262,888.292 derivations/s`, or `+12.8161%`. The median of
the three adjacent paired improvements is `+12.3520%`.

This is a CPU-kernel result, not yet a full wallet-sync result. It must not be
inserted as a wallet sync-duration or blocks/s row before integration and a
full identical wallet restore benchmark.

Strict metric scope:

| Metric | Available in this test? | Reason |
|---|---|---|
| Complete key derivations/s | yes | direct timed kernel output |
| Kernel elapsed and full process wall | yes | monotonic timer and `/usr/bin/time -l` |
| CPU time, average CPU utilization, instructions, cycles | yes | `/usr/bin/time -l` |
| Peak RSS | yes | `/usr/bin/time -l` |
| Memory bandwidth | no | Apple profiler export failed; RSS is not bandwidth |
| Wallet sync duration and blocks/s | no | no wallet restore in this kernel test |
| Network throughput and payload MiB/s | no | no network traffic in this kernel test |
| Server DB time | no | no node or database access in this kernel test |
| Storage requirement | no change measured | benchmark corpus is generated in memory |

## Reproducible environment

| Field | Value |
|---|---:|
| CPU | Apple M4 |
| Logical CPU cores | 10 |
| Performance / efficiency cores | 4 / 6 |
| macOS | 26.5.2 |
| Rust | 1.97.0 (`2d8144b78`, 2026-07-07) |
| Build flags | `-C target-cpu=apple-m4` |
| Release profile | `opt-level=3`, fat LTO, `codegen-units=1`, abort on panic |
| Source commit | `b63ac1ee40ea2137e95b1816f88ce390f648bd6a` |
| Upstream Dalek base | `5312a0311ec40df95be953eacfa8a11b9a34bc54` |
| Binary SHA-256 | `1f30702b415a087589dd1da483d769cd0649dc5ba932b8df2281363074030e95` |
| Benchmark source SHA-256 | `5cfa9422b92153e2f5e620331b4270b3301648cf60a096e089868b522626aa64` |
| `edwards.rs` SHA-256 | `0175b07271b629cca540e325a26766de7f4bbead98b1daa5cf4613b32411b4d5` |
| `field.rs` SHA-256 | `81c43200bc922e4cacb633917edd3ad6c43591048863646f87e802f4c6afc054` |
| serial variable-base SHA-256 | `14448ff31a7bd64f10086ffef4a672031eb90cf1a8695164678418465e193878` |

Apple documents AArch64 NEON intrinsics in stable Rust through
`core::arch::aarch64`, and recommends QoS classes rather than manual
scheduler priority on Apple silicon. Both were investigated. The accepted
path does not require unsafe NEON intrinsics or forced QoS:

- <https://doc.rust-lang.org/core/arch/aarch64/index.html>
- <https://developer.apple.com/documentation/apple-silicon/tuning-your-code-s-performance-for-apple-silicon/>

## Canonical workload and correctness

All six final runs used:

- 65,536 distinct deterministic compressed Edwards25519 transaction public
  keys;
- one common deterministic view scalar;
- 40 timed rounds and 3 warmup rounds;
- 2,621,440 complete derivations per run;
- 10 Rayon workers;
- batch size 16 for the candidate;
- corpus seed `0x4d4f4e45524f3852`;
- corpus fingerprint `0xfe8e3ac99ab899e9`;
- expected result checksum `0x1f1008d2ba5b8fd8`.

Preflight checks compare the original operation, prepared-scalar operation,
paired operation, batch compression, reused workspace, odd batch length,
empty batch, and invalid compressed point handling. Corpus generation and
preflight are outside the timed region.

All six runs produced the same checksum. `pmset -g therm` reported no thermal,
performance, or CPU-power warning before or after every run. The substantial
frequency drift is nevertheless visible in the measurements, so the order was
alternated as `A/B/B/A/A/B`.

## Final individual runs

Only equal units are compared here. `Elapsed` is timed complete-kernel time.
`Wall`, CPU time, RSS, instructions, and cycles are full-process values from
`/usr/bin/time -l`, so they remain in separate columns.

| Order | Run | Variant | Derivations/s | Timed elapsed (s) | Full wall (s) | User CPU (s) | Sys CPU (s) | Peak RSS (MiB) | Instructions | Cycles |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | baseline-r1 | prepared radix-16, per-item compression | 247,614.817 | 10.586765500 | 13.65 | 111.14 | 0.14 | 14.797 | 1,179,932,788,764 | 356,470,306,609 |
| 2 | winner-r1 | pair + batch compression + reused workspace | 269,104.193 | 9.741356959 | 12.73 | 103.45 | 0.14 | 14.516 | 1,125,193,684,836 | 318,582,127,765 |
| 3 | winner-r2 | pair + batch compression + reused workspace | 262,888.292 | 9.971687917 | 12.97 | 105.23 | 0.15 | 14.500 | 1,125,186,913,294 | 320,083,968,185 |
| 4 | baseline-r2 | prepared radix-16, per-item compression | 233,023.743 | 11.249669084 | 14.33 | 118.48 | 0.15 | 14.828 | 1,179,953,856,632 | 363,557,216,888 |
| 5 | baseline-r3 | prepared radix-16, per-item compression | 231,018.565 | 11.347313166 | 14.50 | 119.05 | 0.15 | 14.781 | 1,179,967,392,603 | 363,848,657,915 |
| 6 | winner-r3 | pair + batch compression + reused workspace | 259,553.995 | 10.099786750 | 13.16 | 107.32 | 0.15 | 14.547 | 1,125,202,586,282 | 322,346,849,908 |

## Median comparison

| Metric | Baseline median | Candidate median | Change |
|---|---:|---:|---:|
| Complete derivations/s | 233,023.743 | 262,888.292 | **+12.8161%** |
| Timed complete-kernel elapsed | 11.249669084 s | 9.971687917 s | **-11.3602%** |
| Full process wall | 14.33 s | 12.97 s | -9.4906% |
| Full process user CPU | 118.48 s | 105.23 s | **-11.1833%** |
| Full process sys CPU | 0.15 s | 0.15 s | unchanged at displayed precision |
| Average full-process CPU utilization | 827.844% | 812.490% | -15.354 percentage points |
| Peak RSS | 14.797 MiB | 14.516 MiB | -1.9007% |
| Instructions retired | 1,179,953,856,632 | 1,125,193,684,836 | **-4.6409%** |
| CPU cycles | 363,557,216,888 | 320,083,968,185 | **-11.9577%** |

Adjacent paired throughput improvements:

| Pair | Order | Baseline derivations/s | Candidate derivations/s | Gain |
|---:|---|---:|---:|---:|
| 1 | A then B | 247,614.817 | 269,104.193 | +8.6786% |
| 2 | B then A | 233,023.743 | 262,888.292 | +12.8161% |
| 3 | A then B | 231,018.565 | 259,553.995 | +12.3520% |
| Median | — | — | — | **+12.3520%** |

## Raw final artifacts

Each directory contains `metadata.env`, `build.log`, `result.log`,
`time.log`, `thermal-before.log`, and `thermal-after.log`.

- `wallet-derivation-bench/results/m4-b63ac1e-baseline-r1`
- `wallet-derivation-bench/results/m4-b63ac1e-winner-r1`
- `wallet-derivation-bench/results/m4-b63ac1e-winner-r2`
- `wallet-derivation-bench/results/m4-b63ac1e-baseline-r2`
- `wallet-derivation-bench/results/m4-b63ac1e-baseline-r3`
- `wallet-derivation-bench/results/m4-b63ac1e-winner-r3`

## Exploratory measurements

These tests selected or rejected mechanisms. Unless marked canonical, they
are short screening runs and are not mixed into the final median.

### Inlining

Initial 32,768 × 10 screening:

| Variant | Derivations/s |
|---|---:|
| Existing M4 prepared path | 261,578.285 |
| Aggressive prepared-path inlining | 261,958.367 |

The apparent `+0.15%` is below run variance. Later paired aggressive pair
inlining also failed to show a stable gain:

| Order | Non-inlined | Forced-inline |
|---:|---:|---:|
| 1 | 291,484.321 | 281,754.655 |
| 2, reversed | 275,172.313 | 278,963.336 |

Rejected: code-size increase without stable speedup.

### Batch compression

First 32,768 × 10 screening:

| Variant | Derivations/s |
|---|---:|
| Existing prepared path | 261,578.285 |
| Batch compression, batch 64 | 279,892.008 |

Batch-size sweep before workspace reuse:

| Batch size | Derivations/s |
|---:|---:|
| 1 | 254,490.199 |
| 4 | 273,311.974 |
| 8 | 274,422.849 |
| 16 | 280,260.856 |
| 32 | 273,828.967 |
| 64 | 278,628.508 |
| 128 | 270,390.923 |
| 256 | 275,462.318 |
| 512 | 265,096.092 |

Accepted: amortizing Edwards compression inversion is a real gain.

### Two-way instruction-level parallelism

Same-binary screening, 32,768 × 10, batch 16:

| Variant | Derivations/s |
|---|---:|
| Prepared path | 262,090.874 |
| Paired multiplication only | 271,963.317 |
| Batch compression only | 280,341.799 |
| Pair + batch compression | 297,541.050 |

Accepted: two independent point streams expose useful M4 integer pipeline
parallelism while retaining constant-time scalar access.

### Four-way interleaving

Alternating pair-vs-quad screening:

| Run | Pair + batch | Quad + batch |
|---:|---:|---:|
| 1 | 300,738.021 | 232,619.010 |
| 2 | 296,008.586 | 229,671.048 |

Rejected: four live point streams create severe register pressure and spills.

### Interleaved pair lookup-table construction

Alternating old/new screening:

| Order | Existing pair table build | Interleaved table build |
|---:|---:|---:|
| 1 | 296,739.212 | 292,343.166 |
| 2, reversed | 291,131.002 | 291,457.417 |

Rejected: no stable improvement.

### Reused workspace

Alternating pair-batch vs reused-workspace screening:

| Order | Pair + batch allocations | Reused workspace |
|---:|---:|---:|
| 1 | 297,699.750 | 302,406.968 |
| 2, reversed | 290,525.494 | 300,166.730 |

Accepted: it removes repeated decoded-point, product, reciprocal,
batch-inversion-scratch, and output allocations.

### Workspace batch-size selection

An ordered sweep showed strong thermal drift and was not used directly for a
winner decision:

| Batch size | Derivations/s |
|---:|---:|
| 4 | 297,423.031 |
| 8 | 290,743.394 |
| 12 | 289,585.056 |
| 16 | 282,838.533 |
| 24 | 286,251.792 |
| 32 | 287,437.704 |
| 48 | 285,449.242 |
| 64 | 282,036.749 |
| 96 | 279,582.045 |
| 128 | 280,829.356 |
| 256 | 279,501.915 |

Alternating comparisons removed most order bias:

| Pair | Batch 16 | Batch 4 | Relative result |
|---:|---:|---:|---|
| 1 | 291,405.794 | 281,525.547 | batch 16 +3.51% |
| 2, reversed | 279,580.459 | 269,002.239 | batch 16 +3.93% |

Additional alternating batch 8 vs 4 results were
`271,179.605 / 262,091.285` and, reversed,
`265,741.044 / 262,840.989`. Batch 16 was retained.

### Worker count

Alternating 8/10-worker screening of the accepted mechanism:

| Order | 8 workers | 10 workers |
|---:|---:|---:|
| 1 | 262,638.145 | 282,342.049 |
| 2, reversed | 245,938.528 | 271,659.593 |

Accepted: 10 workers. Both M4 performance and efficiency cores contribute
positive throughput.

### Forced Apple QoS

Default vs `QOS_CLASS_USER_INITIATED`, in execution order:

| QoS | Derivations/s |
|---|---:|
| inherited default | 292,933.825 |
| user initiated | 286,236.002 |
| user initiated | 276,383.863 |
| inherited default | 273,719.802 |
| inherited default | 271,741.920 |
| user initiated | 269,833.745 |

Rejected as a performance optimization: it did not provide a stable gain.
The application may still select user-initiated QoS for semantic scheduling
reasons when the user is actively waiting for sync.

### Profiler attempts

Apple `xctrace` Time Profiler recorded a trace but did not terminate or export
cleanly after the launched process exited. A subsequent `/usr/bin/sample`
attempt also stalled and suspended the long benchmark shell. Both attempts
were stopped safely and no values from them were used. The failed profiler run
also explains why memory bandwidth is explicitly marked unavailable rather
than estimated from RSS or CPU counters.

## Test matrix

| Test | Result |
|---|---|
| `cargo test --manifest-path curve25519-dalek/Cargo.toml --lib` | 120 passed, 0 failed |
| `cargo check --manifest-path curve25519-dalek/Cargo.toml --no-default-features --features alloc` | passed |
| Release benchmark build with `-C target-cpu=apple-m4` | passed |
| Full deterministic preflight | passed |
| Invalid compressed input | rejected as expected |
| Empty batch | accepted and returns empty output |
| Odd batch length | matches per-item reference |
| All six final checksums | identical |
| GitHub Actions / CI | not used |

## Interpretation and next step

The result shows that the M4 serial path was not algorithmically exhausted.
The accepted optimization reduces both work and dependency stalls:

- batch inversion removes repeated compression inversions;
- two-way ILP keeps more of the wide Apple integer pipeline busy;
- workspace reuse removes allocator traffic;
- instructions fall by 4.64%, while cycles fall by 11.96%.

The next correct step is integration into the wallet-facing Rust batch API,
followed by an identical full wallet restore A/B measurement. Only that test
can determine the changes to client scan time, total sync duration, blocks/s,
network throughput, CPU, RAM, and the versioned wallet comparison table.
