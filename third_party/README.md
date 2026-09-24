# Third-Party Core Integration

Monero Core is always fetched from the official upstream repository. TEX8
changes live only as an ordered patch series under `monero-patches/`; the full
Core source is intentionally not vendored in this repository.

The verified base is Monero `v0.18.4.6`, commit
`dbcc7d212c094bd1a45f7291dbb99a4b4627a96d`. The exact source URL, immutable
base commit and patch order are in `monero-patches/upstream.lock` and
`monero-patches/series`.

To materialize a buildable Core checkout:

```sh
tools/monero-upstream/prepare-patched-core.sh \
  /Volumes/4TB/CACHE/monero-fast-wallet-build/monero-v0.18.4.6-tex8
```

The command refuses to overwrite an existing directory and stops on the first
patch conflict. This makes upstream changes explicit and reviewable rather
than silently carrying a modified Core worktree forward.

The current Monero product series contains 94 patches. Its authenticated
resulting tree is `dd34fc6f8bb43ef3b28c0889fb289963bdda3c23`. The tree pin,
rather than a locally generated `git am` commit, is authoritative because a
fresh application can create a different integration commit with identical
contents.

Additional benchmark-only instrumentation and the staged CUDA/full worktree
diff live in `monero-experimental-patches/`. They are preserved for review but
are not part of the ordered production series.

Cuprate remains a separately updateable fork. Its complete TEX8 production
history from base `3147170485c82baec4b5a5f10bdac67316c5923d` through
`cd1ec57ab44301b93a21e9b504b9d913b88fc871` is reproduced by the ordered
41-patch series in `cuprate-patches/`.

The Curve25519 CPU patches are under `curve25519-dalek-wallet-cpu/`. Source
harnesses and text evidence for the original Ref10 baseline, CPU, Metal,
mobile and CUDA measurements are indexed in
`../docs/WALLET_ACCELERATION_TESTBENCH_INDEX.md`.
