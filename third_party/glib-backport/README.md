# GLib0.18.5 VariantStrIter backport

`../glib-0.18.5` contains the original crates.io GLib0.18.5 source with only the
upstream fix for RUSTSEC-2024-0429 applied. Its public API and package version
remain unchanged. `upstream.json` pins the original archive, every original
file and the exact upstream fix commit. The original MIT license and copyright
remain in the vendored package.

The fix makes the output pointer passed to the variadic GLib function mutable.
It is upstream commit `b5a4071e439bef2b5eea76c3aa25e5ae84839e34`:
https://github.com/gtk-rs/gtk-rs-core/commit/b5a4071e439bef2b5eea76c3aa25e5ae84839e34

Apply the retained upstream patch to the verified original package from the
repository root with:

```sh
git apply -p2 --directory=third_party/glib-0.18.5 \
  third_party/glib-backport/0001-variant-str-iter-mutable-out-pointer.patch
```

The release regression deliberately reconstructs the original upstream source,
verifies every byte, and runs both variants against real system GLib. The
unpatched optimized build must reproduce the memory-safety failure. The patched
build must pass forward/backward/nth/last, mixed/empty iteration, Unicode and
borrowed-storage checks. This test must run on Linux with the GLib development
libraries and the pinned Rust toolchain; a debug build does not reproduce the
optimizer defect.

```sh
python3 third_party/glib-backport/test-release.py \
  --lockfile wallets/desktop/src-tauri/Cargo.lock \
  --target-dir /tmp/mfw-glib-backport-target \
  --output /tmp/mfw-glib-backport-results.json
```

This source patch fixes the identified GLib defect. It does not waive other
advisories or prove release-artifact acceptance; the desktop release still
needs its normal dependency, packaging and runtime checks.
