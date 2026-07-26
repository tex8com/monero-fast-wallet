# Wallet Metal testbench

This is the GPU test track for the wallet scan. It does not contain product
integration and only processes deterministic, public test data. A real view key
must not enter the test vector or the GPU buffer.

## M0 – Layout and Dispatch (historical baseline)

M0 binds exactly the buffers needed later:

```text
View-Key: 32 Byte
R:        N × 32 Byte
D:        N × 32 Byte
valid:    N × 1 Byte
```

The kernel only copies `R` to `D` and sets `valid`. It measures metal
initialization, unified memory delivery, dispatch and acceptance of results.
**M0 does not contain Edwards25519 arithmetic; its values are not derivations/s
and must not be compared with CPU crypto values.**

## M1 – complete reference derivation

`derivation.metal` implements the same operation as the current Rust adapter:

```text
D = (8 * Scalar::from_bytes_mod_order(a)) * R
```

The kernel contains field arithmetic modulo `2^255 - 19`, full extended-edwards
formulas, point decoding, scalar reduction modulo of the Ed25519 group order and
compressed output. His goal is first of all correctness, not maximum
performance.

Before each M1 measurement, `tools/wallet-crypto-testbench` builds a binary
`MWMTV1` vector file. It contains deterministic, public points and for each
point the byte-accurate result of the existing Dalek adapter. In addition, it
contains a point discarded by Dalek. The metal run only exists if:

1. Each of the `N` results corresponds exactly to the 32 Dalek bytes and
2. the invalid point provides `valid=0` and 32 null bytes.

Example of a small correctness run:

```sh
WALLET_METAL_M1_POINTS=8 \
WALLET_METAL_BENCH_RUN_ID=metal-m1-smoke-mac-m4-YYYYMMDD-001 \
bash tools/wallet-metal-testbench/run-metal-m1-derivation-testbench.sh \
  --rounds 1 --warmup-rounds 1 --threads-per-group 32
```

Vector export is a correctness requirement, not a CPU performance measurement.
`m1_derivations_per_second` may only be compared to the CPU derivation rate
after `validation=pass`; Nevertheless, it remains an isolated crypto core
measurement, not a wallet sync rate.

## M2 – common scalar per thread group

`derivation_m2_group_scalar` uses unchanged M1 mathematics and the same `MWMTV1`
vectors. The only difference is the execution: Since a wallet scan batch has a
common view scalar, one lane reduces and multiplies the scalar by 8 once per
thread group; The remaining lanes adopt the 32-byte result after a thread group
barrier.

```sh
WALLET_METAL_M1_POINTS=8192 \
WALLET_METAL_BENCH_RUN_ID=metal-m2-bulk-r1-mac-m4-YYYYMMDD-001 \
bash tools/wallet-metal-testbench/run-metal-m1-derivation-testbench.sh \
  --kernel derivation_m2_group_scalar \
  --rounds 3 --warmup-rounds 1 --threads-per-group 32
```

M2 is considered an improvement only if it passes the same byte and fault path
checks as M1. M2 also remains a test core, not wallet product code.

## M4 – Dalek-Radix-16 with projective Niels tables

M4 adopts the algorithm of variable basis point multiplication from
`curve25519-dalek` 4.1.3 instead of just modifying a single field operation:

1. It generates a table `P, 2P, …, 8P` in Projectiv-Niels coordinates per entry
   point.
2. The scalar already folded into `8*a mod l` is broken down into 64 signed
   Radix-16 digits (`[-8, 8]`).
3. It processes the digits from top to bottom with four Doublings in P2
   coordinates and a Niels table addition.

This reduces the number of point additions in the main multiplication path from
256 to 64; the table structure requires an additional seven additions. Point
decoding, scalar contract, result coding and the M2 threadgroup scalar path
remain unchanged. M4 is considered a candidate only after full byte testing
against the same `MWMTV1`-Dalek vectors.

```sh
WALLET_METAL_M1_POINTS=8192 \
WALLET_METAL_BENCH_RUN_ID=metal-m4-radix16-r1-mac-m4-YYYYMMDD-001 \
bash tools/wallet-metal-testbench/run-metal-m1-derivation-testbench.sh \
  --kernel derivation_m4_radix16_niels \
  --rounds 3 --warmup-rounds 1 --threads-per-group 32
```

## M5 – M4 plus Dalek field addition chains

M5 maintains the full M4 scalar multiplication path, but replaces the generic
binary exposure when decoding and encoding the points:

- field inversion `x^(p-2)`: same `pow22501` addition chain as Dalek, 254
  squares and 11 full multiplications;
- Square root `x^((p+3)/8)`: same chain, 252 squares and 11 full
  multiplications.

M4 executes a full multiplication for almost every set exponent bit for these
exponents in the reference field core. M5 does **not** change the field
representation, the reduction or the point formulas; Thus, the audit surface is
small compared to a new field core. The mandatory Dalek byte and invalid point
test remains unchanged.

```sh
WALLET_METAL_M1_POINTS=8192 \
WALLET_METAL_BENCH_RUN_ID=metal-m5-addition-chain-r1-mac-m4-YYYYMMDD-001 \
bash tools/wallet-metal-testbench/run-metal-m1-derivation-testbench.sh \
  --kernel derivation_m5_radix16_niels_addition_chain \
  --rounds 3 --warmup-rounds 1 --threads-per-group 32
```

## M12/M16 – 25/26-bit field core and blockwise batch inversion

`derivation_radix2625_chunkinvert.metal` is the current metal candidate. It
maintains Radix-16 point multiplication and Dalek addition chains, but uses
Dalek's unsigned 10-Limb field representation. The edition runs in three ordered
metal passes:

1. point decoding and scalar multiplication in projective coordinates;
2. Montgomery batch inversion in independent 16-point chunks;
3. Parallel affine conversion and compressed Edwards output.

The host uses separate projective, inverse, result and validity buffers for each
in-flight slot. The error path and the complete Dalek byte matching are
unchanged.

```sh
WALLET_METAL_M1_POINTS=8192 \
WALLET_METAL_BENCH_RUN_ID=metal-m16-pass-groups-r1-mac-m4-YYYYMMDD-001 \
WALLET_METAL_KERNEL_SOURCE="$PWD/tools/wallet-metal-testbench/derivation_radix2625_chunkinvert.metal" \
bash tools/wallet-metal-testbench/run-metal-m1-derivation-testbench.sh \
  --kernel derivation_m12_projective_chunkinvert \
  --rounds 60 --warmup-rounds 3 \
  --threads-per-group 64 \
  --projective-threads-per-group 256 \
  --inverse-threads-per-group 16 \
  --compress-threads-per-group 128 \
  --batch-inversion-chunk-size 16
```

M16 uses the same M12 core and the same mathematics. Only the thread group size
is selected separately for the three passes. The above values are the setting
formally confirmed on an Apple M4. Other GPUs must be matched separately with
the public testbench; `--threads-per-group` remains the common fallback value
for projective and compression pass.

The remaining development stages were measured separately and discarded or
adopted in M12:

- M7: first 25/26-bit port;
- M8: delayed carry on additions;
- M9: canonical limb comparisons;
- M10: commonly coded scalar numerals;
- M11: correct but slow serial batch inversion;
- M13: correct but slow pure 32-bit radix `2^13`-arithmetic.
- M14: correct but slower parallel thread group scan;
- M15: correct but slower 32-lane SIMD scan.

None of these files are product integration. The testbench must still not
process a real wallet key.
