# Official Monero patch layer

This directory is the only supported source of TEX8 changes to Monero Core.
The Core itself and its declared submodules are always cloned from the official
Monero repository recorded in `upstream.lock`; they are never copied into this
product repository.

`series` is ordered and mandatory. The integration command applies every patch
with `git am --3way`. A rejected patch is a deliberate stop: resolve and test
the incompatibility in a new patch, never edit the fetched upstream tree by
hand and silently continue.

## Create a reproducible Core checkout

```sh
tools/monero-upstream/prepare-patched-core.sh \
  /Volumes/4TB/monero-fast-wallet-build/monero-v0.18.4.6-tex8
```

Then build it explicitly through the normal wallet build script:

```sh
MONERO_SOURCE_DIR=/Volumes/4TB/monero-fast-wallet-build/monero-v0.18.4.6-tex8 \
MONERO_BUILD_DIR=/Volumes/4TB/monero-fast-wallet-build/monero-wallet-api-grpc-macos12 \
MONERO_DEPENDS_PREFIX=/path/to/monero-depends-prefix \
PROTOC_PATH=/path/to/monero-depends-prefix/native/bin/protoc \
native/monero-bridge/scripts/build-local-monero-wallet-api.sh
```

Desktop macOS/Linux builds source
`native/monero-bridge/scripts/prepare-patched-monero-core.sh` automatically.
Unless `MONERO_SOURCE_DIR` is explicitly set to an already authenticated
checkout, it materializes the source below the product's ignored `build/`
directory. It verifies both the official base tree and the final patched tree
from `upstream.lock`, and rejects tracked, staged, or unexpected untracked
source changes before compiling.

## Upstream update process

1. Fetch an official release/tag in a fresh temporary checkout.
2. Change `upstream.lock` to its immutable commit.
3. Apply `series`; a conflict is a required porting task, not a bypass.
4. Split the port into narrowly scoped patches, then run wallet build and
   benchmark gates before updating `upstream.lock` in the product repository.

`0000-cover-letter.patch` is historical metadata and intentionally not part of
the applied series.
