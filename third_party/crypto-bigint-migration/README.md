# crypto-bigint 0.7.10 migration

This change replaces vulnerable `crypto-bigint 0.5.5` with the **unmodified official
0.7.10 release**. It does not rename 0.5.5, hide an advisory, or maintain a private
big-integer arithmetic backport. Parent package versions remain their upstream
versions; the patch files document their local API adapters.

The official 0.7.10 crate archive SHA-256 is
`9c035cb64cba03dad2fb921f3e218785e8cf9a41790da5eb3a1400f62fa2be11`.
`crypto-bigint-0.7.10-origin.json` records the download origin. Cargo's product
locks must select this exact version and checksum, with no 0.5.5 entry remaining.

## Why this version

[RUSTSEC-2026-0387](https://rustsec.org/advisories/RUSTSEC-2026-0387.html)
reports timing leaks in subtraction, zero counting, division and Montgomery
arithmetic, plus later `UintRef`/boxed APIs. Its patched range begins at 0.7.6.
The 0.7.6–0.7.8 releases are yanked; 0.7.10 is the selected stable release.
The upstream fixes are documented in
[0.7.6's changelog](https://github.com/RustCrypto/crypto-bigint/blob/v0.7.6/CHANGELOG.md)
and PRs [1311](https://github.com/RustCrypto/crypto-bigint/pull/1311),
[1355](https://github.com/RustCrypto/crypto-bigint/pull/1355),
[1358](https://github.com/RustCrypto/crypto-bigint/pull/1358), and
[1360](https://github.com/RustCrypto/crypto-bigint/pull/1360).
All arithmetic and compiler barriers come from the official fixed crate and
its `ctutils` dependency.

## Adapter boundaries

- Dalek 0.4/0.5 and Ed448 replace `Residue` with `ConstMontyForm` and retain
  the old outer `subtle` API through crypto-bigint's official `subtle` feature.
- Public constant inverses use the checked, const-capable `expect_copied`.
  Divisors use the new checked `NonZero` API.
- The old `hi.concat(lo)` convention changed to `lo.concat(hi)`. The Dalek
  wide modulus is adapted explicitly; wide-reduction oracle tests cover it.
- Integer encodings use byte slices or explicit byte-array conversion.
  Scalar/point wire encodings are preserved.
- The Monero generator adapter retains the exact original pinned `monero-io`
  Git revision rather than changing its source to a registry package.
- The elliptic-curve adapter preserves the existing generic-array byte API and
  adapts the caller's rand_core 0.6 RNG to the new 0.10 trait. Integer operations
  still execute in the official 0.7.10 crate.
- Patched package MSRVs are 1.87, matching the new dependency. The project uses
  Rust 1.97.0.

`field-api-port.patch` and `ec-api-port.patch` are review diffs against the
original package sources. Their `*-origin.json` files include file hashes.
Original licenses and upstream manifests are retained inside each vendor tree.
`Cargo.toml.orig` is upstream provenance, not Cargo's active dependency manifest.
`VENDOR-SOURCES.json` records the complete modified source hashes, which the
validation script verifies before compiling.

Some parent and concrete-curve packages are optional. Cargo metadata can list
their dependency edges even when their features are inactive. Confirm the final
product's actual `cargo tree --edges normal` as well as its complete lock;
metadata reachability alone does not prove a package is compiled or exercised.

## Validation

Run `scripts/check-crypto-bigint-migration.sh` with the project Rust toolchain.
Set `MFW_CRYPTO_VALIDATION_OUTPUT_DIR` and optionally `CARGO_TARGET_DIR` to choose
external artifact directories. At most two Cargo jobs are allowed.

The optimized validation fixture compares Dalek/Ed448 arithmetic and wide
reductions with an independent `num-bigint` oracle, checks canonical decoding
and inverses/constants, and runs the existing Monero `hash_to_ec` vectors.
Separate regression tests cover the advisory's integer and Montgomery/boxed
operations, including limb-boundary zero counts and divisor patterns.

The timing executable uses synthetic public operands, balanced randomly
interleaved classes, and records raw nanosecond samples and Welch statistics.
Its exported operation wrappers also provide stable symbols in release
assembly for inspection. **These measurements are diagnostics, not a proof of
constant-time execution.** VM scheduling, compiler options, hardware and later
dependency changes limit their interpretation. Release-target tests and the
final product's actual dependency tree remain required; fixture success alone
does not establish that every shipped build used these patches.

Linux and other standalone build roots must receive the same path patches and
updated product locks. In particular, rebuilding only the desktop app while
reusing an old fast-wallet-protocol static archive is insufficient.
