# saturating-time 0.5.0: Windows clock-resolution fix

This directory contains the unmodified published 0.5.0 package plus the narrowly
scoped changes described below. The package name, version, features, manifest,
lockfile, and dependencies remain unchanged. Desktop Cargo selects it through a
`[patch.crates-io]` path override; this is not an Arti/TLS version change.

## Authenticated upstream

- Registry: https://crates.io/crates/saturating-time/0.5.0
- Original archive: `upstream/saturating-time-0.5.0.crate`
- SHA-256 (the existing desktop Cargo.lock registry checksum):
  `a586db154f85f3faf78398c37b6792d71f99d2253d3277571e14f8a8c6e49a65`
- VCS commit recorded in that archive:
  `ce8bc6e0998bd5a4efdf06dd62dce53c98ea1087`, `crates/saturating-time`.
- `upstream/PROVENANCE.json` records every original file hash and the source and
  hash of both upstream license texts. The published crate omitted the license
  files; `LICENSE-MIT` and `LICENSE-APACHE` are copied from that exact VCS commit.
- Registry version inspection on 2026-10-30 found 0.5.0 to be the newest release;
  it still contains both defects reported below for 0.4.0.

## Local changes

1. The sealed internal `SaturatingTime` trait requires `PartialEq`.
2. `find_limit` stops when checked arithmetic returns the unchanged timestamp.
   Windows `SystemTime` truncates durations to 100 ns; a smaller search step can
   therefore succeed without making progress, which previously looped forever.
3. Successful saturating addition/subtraction uses lazy limit fallbacks, so it
   does not calculate a platform limit unnecessarily.

No clock values, network behavior, TLS backend, or saturation boundaries are
hardcoded in production. All original package files are byte-identical except
`src/lib.rs` and `src/internal.rs`.

The new `src/regression_tests.rs` exercises the actual private search with a
100 ns mock clock and a bounded call budget, both exact boundaries, real
saturation, and successful arithmetic whose limit fallback panics if evaluated.
The original `SystemTime`/`Instant` tests remain active. Their boundary examples
and assertions use a portable one-second step instead of assuming nanosecond
resolution, and their span assertion uses the standard library's actual
platform span instead of assuming every platform spans `Duration::MAX`.

Upstream reports:

- https://gitlab.torproject.org/tpo/core/arti/-/work_items/2726
- https://gitlab.torproject.org/tpo/core/arti/-/work_items/2678

## Verification

```sh
cargo test --offline --locked --manifest-path third_party/saturating-time/Cargo.toml
cargo fmt --manifest-path third_party/saturating-time/Cargo.toml -- --check
```

Run on Windows as well as the host; a host-only test is not a Tor bootstrap or
Windows runtime acceptance. Remove this override only after a released upstream
fix passes the same regression tests and the Windows Tor bootstrap check.
