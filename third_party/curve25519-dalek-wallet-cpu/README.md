# Wallet CPU backend

This directory packages the measured wallet-specific `curve25519-dalek`
changes without replacing or silently editing Cargo's registry cache.

The source of truth is the official Dalek repository at the immutable base
commit recorded in `upstream.lock`. The ordered patches expose the prepared
same-scalar batch API, the two-way serial multiplication path, reusable batch
compression storage, and stable Rust AVX-512 IFMA selection. They contain no
wallet keys or benchmark corpus.

`native/monero-bridge/scripts/prepare-wallet-crypto-cpu-backend.sh` checks out
the base, applies this series as commits, and verifies the resulting
`curve25519-dalek` Git tree before Cargo may use it. Desktop build scripts then
select it through Cargo's `[patch.crates-io]` configuration; no absolute local
path is recorded in `Cargo.lock`.

The patch set is shared by all desktop CPU builds:

- AArch64 uses the serial backend and the same-scalar batch path.
- x86-64 keeps Dalek's runtime AVX2/AVX-512 feature selection.
- unsupported instruction sets retain Dalek's serial fallback.

Architecture-specific compiler targets remain a packaging policy. Production
packages must target the oldest supported CPU for that artifact. A local M4
benchmark may explicitly set `MONERO_FAST_CRYPTO_TARGET_CPU=apple-m4`, but that
artifact must not be distributed as a general Apple Silicon build.
