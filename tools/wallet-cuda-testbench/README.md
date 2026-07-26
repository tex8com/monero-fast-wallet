# Wallet CUDA testbench

This testbench measures only the isolated wallet crypto core

```text
D = (8 * Scalar::from_bytes_mod_order(a)) * R
```

It processes deterministic, public `MWMTV1` vectors. True wallet keys must not
be used in vector files or in GPU buffers.

## Implementing candidates

| Variant | Purpose | Register/Thread | Local memory/thread |
| --- | --- | ---: | ---: |
| C0 `layout` | Dispatch and layout cap, no cryptography | 22 | 0 B |
| C1 `ladder` | constant 256-bit chargers, addition chains | 255 | 80 B |
| C2 `radix16` | Radix-16 and 8-Niels table in the 16-bit field core | 255 | 9.616 BB |
| C3 `radix2625-chunk` | 10-Limb Field Core and Three-Stage Chunk Inversion | 255 | 952 B |
| C4 `radix2625-direct` | C3 field core as a one-pass kernel | 255 | 952 B |
| C5 `radix2625-radix8` | Table of 4, signed Radix 8 digits | 255 | 176 B |
| C6 `radix2625-radix8-sqrt-ratio` | C5 with combined Dalek-`sqrt_ratio_i`-point decompression | 255 | 176 B |

The values are taken from `ptxas` for `sm_86`. C6 is the current candidate for
the RTX 3090. C5’s smaller table costs more point additions, but significantly
reduces the spill accesses that are particularly expensive for CUDA. C6 also
avoids separate inversion and square root when decompressing `R`.

## Local byte testing

The portable reference run does not require a CUDA and checks the same result
bytes and the same invalid point as the GPU run:

```sh
clang++ -O3 -std=c++17 -Wall -Wextra -Werror \
  reference.cpp -o wallet-cuda-reference

./wallet-cuda-reference \
  --vectors /path/to/vectors.mwmtv1 \
  --variant all
```

## SCP and build sequence

The source text is changed locally and then copied. No source text is created or
edited on the GPU instance:

```sh
scp derivation_core.cuh derivation_radix2625.cuh vector_corpus.hpp \
  main.cu build.sh GPU:/workspace/monero-cuda/src/

ssh GPU \
  'CUDA_ARCH=sm_86 /workspace/monero-cuda/src/build.sh \
   /workspace/monero-cuda/wallet-cuda-testbench'
```

Example of the confirmed C5 run:

```sh
./wallet-cuda-testbench \
  --vectors vectors/points-8192.mwmtv1 \
  --variant radix2625-radix8 \
  --rounds 60 \
  --warmup-rounds 3 \
  --threads-per-block 32
```

## RTX 3090 results

System: Vast instance `45848910`, RTX 3090 with 24 GB, Compute Capability 8.6,
CUDA 12.8, driver 595.71.05 and a 300W limit set by the host. All table values
are the median of three formal runs and contain only the GPU event time of the
kernel pipeline.

| Points/batch | C1 Ladder | C2 Radix-16/16-bit | C3 Chunk | C4 Directly | C5 Radix-8 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 8 | 598 | 862 | 3.586 | 3.584 | 5.358 |
| 64 | 4.790 | 6.886 | 28.660 | 28.671 | 42.869 |
| 1.024 | 78.540 | 101.987 | 471.261 | 467.071 | 657.714 |
| 8.192 | 627.866 | 418.892 | 3.606.365 | 3.639.870 | **5.309.030** |
| 131.072 | 1.428.556 | 729.860 | 4.143.638 | 4.171.474 | **9.534.593** |

C0 is not cryptography and is therefore not used as an acceleration value. At 8.192 points, C5, compared with the median single-thread original Ref10
measurement (`27.030,166/s`), achieves a factor of **196,41×**. Compared with
C1, the factor is **8,456×**.

The additional continuous run processed 131.072.000 derivatives in 13,683650391
seconds:

```text
9.578.730,548 derivations/s
Temperature: 52–69 °C
Power: maximum 299,55 W
SM clock: maximum 1.740 MHz
validation=pass
```

## RTX 3090 C6 results

System: Vast instance `45854234`, RTX 3090 with 24 GB, Compute Capability 8.6,
CUDA 12.8, Driver 590.48.01 and 350W limit. C5 and C6 were measured alternately
on the same host, each with five formal runs and 128 threads per block. The
table contains the median GPU event time.

| Points/batch | C5 Radix-8 | C6 `sqrt_ratio_i` | C6/C5 |
| ---: | ---: | ---: | ---: |
| 8.192 | 6.111.302 | **6.462.993** | **1,0575×** |
| 131.072 | 10.331.329 | **10.948.124** | **1,0597×** |

Compared to the single-thread original ref10 measurement (`27.030,166/s`), C6
achieves the factor **131.072** at 405,03× points.

The C6 continuous run processed 262.144.000 derivatives in 24,294734375 seconds:

```text
10.790.157,075 derivations/s
GPU utilization: 100% in all active telemetry samples
Memory utilization:  0 %
Power: Median 348,82 W, maximum 349,27 W at 350 W limit
Temperature: 51–65 °C
SM clock: median 1.830 MHz, 1.815–1.845 MHz
validation=pass
```

C5 and C6 both require 255 registers and 176 B of local memory per thread. With
128 threads per block, two blocks or eight warps fit statically on each
Ampere-SM: 16,7% theoretical warp-occupancy. Telemetry simultaneously shows 100%
GPU and 0% memory utilization; The current kernel is therefore compute, register
and power limited, not by global memory bandwidth.

## Test status

- Bytelike against Curve25519-Dalek 4.1.3: passed.
- Dalek rejected point: `valid=0` and 32 null bytes, passed.
- C5 scalar recoding: zero, one, group ordering, `ff…ff` and 10.000
  deterministic 256-bit inputs reconstructed, passed.
- C6-`sqrt_ratio_i`: portable byte test versus Curve25519-Dalek 4.1.3 for 1.024
  points and GPU tests for 8 to 131.072 points.
- Three formal repetitions per variant and corpus size: passed.
- CUDA Compute Sanitizer `memcheck`: all C0–C5 paths without error.
- `initcheck`: C3–C5 without error.
- C6 `memcheck` and `initcheck`: 0 errors each.
- `synccheck` and `racecheck`: C1/C2 without errors or hazards.
- Block sizes 32, 64, 128 and 256: measured.
- C3 chunk variables 1, 2, 4, 8, 16, 32, 64 and 128:
- Register boundary 192 against the natural 255 register build: measured and
  discarded.

Nsight Compute could not read a performance counter on the rental system
(`ERR_NVGPUCTRPERM`). The resource values are therefore taken from `nvcc
-Xptxas=-v` Timing takes place with CUDA events.

The complete raw data are available at
`build/wallet-cuda-testbench/rtx3090-vast-45848910-20260725/` (C0–C5) and
`build/wallet-cuda-testbench/rtx3090-c6-vast-45854234-20260725/` (C5/C6).

The complete evaluation of the subsequent C7–C11 experiments on the RTX 3090 as
well as all SM-120 measurements on the RTX 5090 is available in
[`RESULTS-2026-07-25.md`](RESULTS-2026-07-25.md).
