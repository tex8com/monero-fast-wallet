# MFW RandomX JIT corpus profiler — implementation and first validation

Date: 2026-08-16

## Outcome

MFW-Miner now has a compile-time-disabled, offline JIT corpus entrypoint. It
captures every RandomX virtual instruction and the exact native byte range
emitted for it on AArch64 or x86-64. Deterministic stable replay emits
per-program monotonic and wall-clock time windows, allowing macOS Instruments
and Linux perf PCs to be attributed even when several programs reuse the same
JIT address.

Normal builds are unchanged unless `WITH_MFW_JIT_CORPUS=ON` is set. The corpus
entrypoint exits before miner, pool, DNS, donation, or share initialization.

## Correctness gates

- Every natural-corpus hash is compared with the interpreter.
- Every stable-replay program compares the complete `RegisterFile` and the
  complete 2 MiB scratchpad before profiling begins.
- RandomX v1 requires 256 captured instructions per program; v2 requires 384.
- The NDJSON analyzer rejects malformed sequences, byte ranges, offsets, sizes,
  summaries, and unhealthy producer output.
- v2 tweak isolation is available only as a diagnostic mask; production v2 is
  mask 15.
- All modes are offline. No pool URL or share-submit path is initialized.

## Defects found by the new gates

1. The fork's interpreter lacked the v2 AES F/E register mix. The official
   v2 behavior was backported and checked on Apple Silicon and x86-64.
2. The x86 Light JIT lacked the separate v2 Superscalar-dataset initializer.
   The v1 ordering updated `mx`; v2 must read and update `ma` before swapping.
   A separate official-style `program_read_dataset_sshash_init_v2.inc` and
   dispatch were added. Individual tweak masks and mask 15 then passed.
3. The first replay harness reset the floating-point rounding mode twice before
   running either VM. Because rounding mode is thread state, the JIT's
   `CFROUND` result leaked into the interpreter's initial state. Reset now occurs
   immediately before each VM execution. A deterministic program that formerly
   failed at corpus sequence 3 now passes.

## Validated platforms

| Platform | Natural corpus | Stable replay | PC/counter profile |
|---|---:|---:|---:|
| Apple M4 / macOS | v1 64 + v2 64 PASS | v2 8 × 2 PASS; v2 16 × 200 profiled | 5,876 replay-ROI samples; 291 exact JIT mappings; 16/16 program coverage |
| Intel Xeon E3-1585L v5 / Linux | v1 64 + v2 64 PASS | v2 8 × 2 PASS; v2 16 × 200 profiled | 24,159 cycle samples; 17,247 in replay ROI; 2,398 exact JIT mappings; 16/16 program coverage |
| AMD EPYC 9634 KVM guest / Linux | v1 64 + v2 64 PASS | v2 8 × 2 PASS | `perf` unavailable; no package installation attempted |
| Apple M1 MacBook Air / macOS | v1 64 + v2 64 PASS | v2 8 × 2 PASS; v2 16 × 200 profiled | 11,349 replay-ROI samples; 1,045 exact JIT mappings; 16/16 program coverage |

The complete feature-off build also passed on the Intel host. Its SHA-256 is
`02a860e89bdbed33436b2d964d3f2002864f6cea433db65dc00fe3555177c837`;
neither JIT-corpus symbols nor the developer CLI switch are present.

## First Intel cycle-sample ranking

This is a Light-mode code-body profile, not a Fast-mode H/s benchmark. Shares
are percentages of the 2,398 samples mapped inside exact JIT instruction ranges.

| Instruction type | Samples | Mapped JIT share |
|---|---:|---:|
| ISTORE | 253 | 10.550% |
| IADD_M | 252 | 10.509% |
| ISUB_M | 245 | 10.217% |
| FADD_M | 240 | 10.008% |
| FSUB_M | 222 | 9.258% |
| CBRANCH | 170 | 7.089% |
| ISMULH_M | 131 | 5.463% |
| IXOR_M | 87 | 3.628% |
| IMUL_M | 77 | 3.211% |
| FDIV_M | 63 | 2.627% |

The main evidence is a broad memory-address/data-dependency bottleneck, not one
isolated arithmetic instruction. Candidate changes therefore need a corpus-wide
schedule/dependency comparison and a matched Fast-mode H/s ABBA/BAAB gate; code
size alone is not a performance metric.

## First Apple M1 time-sample ranking

This is the same Light-mode limitation as the Intel profile. Percentages use
the 1,045 samples mapped into exact JIT instruction ranges. The trace contains
11,349 samples inside the replay windows; all 16 programs have mapped samples.

| Instruction type | Samples | Mapped JIT share |
|---|---:|---:|
| CBRANCH | 543 | 51.962% |
| FSUB_R | 88 | 8.421% |
| ISTORE | 64 | 6.124% |
| FMUL_R | 63 | 6.029% |
| ISUB_M | 40 | 3.828% |
| IXOR_M | 37 | 3.541% |
| IADD_M | 30 | 2.871% |
| IXOR_R | 29 | 2.775% |
| FSUB_M | 23 | 2.201% |
| IMUL_R | 22 | 2.105% |

The M1 result is materially different from the Intel ranking and supports
architecture-specific candidate selection. `CBRANCH` is the first M1 candidate
for deeper branch-layout and dependency analysis, but the 51.962% sample share
must not be presented as a projected H/s gain.

## First Apple M4 time-sample ranking

The M4 run began only after the foreign Android build ended, a 20-minute
cooldown, and ten consecutive live samples at or above 95% idle. There are
5,876 samples inside the replay windows; 291 map into exact JIT instruction
ranges and all 16 programs have coverage. Every mapped sample was scheduled on
a P core.

| Instruction type | Samples | Mapped JIT share |
|---|---:|---:|
| CBRANCH | 211 | 72.509% |
| IADD_M | 12 | 4.124% |
| ISTORE | 11 | 3.780% |
| ISUB_M | 11 | 3.780% |
| IXOR_M | 8 | 2.749% |
| IADD_RS | 8 | 2.749% |
| IXOR_R | 6 | 2.062% |

The shared M1/M4 signal is `CBRANCH`, but its measured share is substantially
larger on M4 (72.509% versus 51.962%). This justifies a common AArch64 branch
candidate with separate M1 and M4 promotion decisions. The remaining ranking
is not interchangeable: M1 next exposes `FSUB_R`/`FMUL_R`, while M4 next
exposes memory integer operations.

## Evidence

- Intel raw perf data, script, map, binary, CMake cache, reports, and verified
  manifest: `benchmark-results/hosts/fork-new-jit-corpus-20260816T0358Z/`
- EPYC maps/reports and verified manifest:
  `benchmark-results/hosts/tex8-epyc9634-jit-corpus-20260816T0416Z/`
- M4 natural/replay fixtures and prior Instruments traces:
  `benchmark-results/jit-corpus/`
- M4 successful 16 × 200 trace, exports, exact map/profile, and verified
  218-file manifest: files prefixed
  `benchmark-results/jit-corpus/m4-v2-time-16x200-20260816`.
- M1 natural/replay maps, successful and failed diagnostic traces, exported
  samples, reports, bundled-binary hashes, and verified 431-file manifest:
  `benchmark-results/hosts/m1-macbook-air-jit-corpus-20260816T0425Z/`

## Remaining gates

1. Provide unprivileged perf access on an isolated EPYC environment, or profile
   on a non-production Zen 4 host. Do not install packages or change kernel
   policy solely to force a result.
2. Convert the measured top dependency chains into one candidate at a time,
   retaining only bit-exact candidates that win matched Fast-mode H/s blocks.
