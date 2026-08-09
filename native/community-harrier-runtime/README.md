# Community Harrier native runtime

Wallet-independent C++ boundary for the local Monero Enthusiast embedding
model. It accepts only assets that the Rust artifact verifier has already
validated against a signed manifest. It never downloads a model and has no
HTTP, Monero, wallet, React or JavaScript dependency.

The implementation uses:

- ExecuTorch 1.3.1 with the XNNPACK A8W8 PTE;
- the exact `meta-pytorch/tokenizers` revision recorded in `upstream.lock`;
- a static 1 × 256 `int64` input contract;
- last-token pooling and L2 normalization inside the PTE;
- a mutex because one ExecuTorch `Module` is not thread-safe.

The testbench first compares every native token sequence with the frozen
Hugging Face sequence, then executes all 36 embeddings. Its output is accepted
only by `tools/community-harrier-testbench/compare_embeddings.py`.

Large PTE/runtime packages and third-party source trees stay outside Git.
Build scripts must verify every version/hash before passing those paths to
CMake. Three recorded patches are applied. The first raises RE2's bounded DFA
ceiling for Gemma's unusually large added-token expression; it does not alter
tokenization. The second lets the tokenizer use a product-owned external
RE2/Abseil graph. The third adapts SentencePiece to packaged Abseil through a
build-owned include shim without mutating authenticated source. Native token
IDs remain part of the 36-case conformance gate.

## Reproduce the Apple ARM64 host gate

`scripts/build-apple-native.sh` fetches only the exact Apple packages and
tokenizer revision recorded in `upstream.lock`, verifies all SHA-256 values,
applies the recorded tokenizer patch, builds the C++ adapter and runs the
native vectors plus cosine gate:

```bash
TEX8_HARRIER_CACHE_DIRECTORY=/external/cache/harrier \
TEX8_HARRIER_PTE_PATH=/external/artifacts/harrier-v1.pte \
TEX8_HARRIER_TOKENIZER_PATH=/external/model/tokenizer.json \
TEX8_HARRIER_PROTOBUF_PREFIX=/external/pinned-grpc-sdk/v1.80.0 \
./scripts/build-apple-native.sh
```

For the Desktop product, `TEX8_HARRIER_PROTOBUF_PREFIX` is mandatory and must
contain the same pinned Protobuf 31.1 package used by gRPC 1.80.0. The build
fails if `protoc` differs, if SentencePiece still embeds legacy Protobuf
runtime objects, or if the recorded patch set changes unexpected source
files. It emits `tex8-harrier-build-contract.txt`; Desktop refuses to link a
runtime without the external-Protobuf 31.1 contract. A standalone vendored
build overwrites that file with a deliberately incompatible `vendored` mode,
so a prior external contract cannot remain stale. The host gRPC SDK emits a
separate contract and is rebuilt if its macOS deployment target is not 12.0.

The accepted macOS ARM64 V2 run matched all 36 frozen native token sequences
and passed with minimum cosine `0.997210`. It uses the neutral
`community-query-v2` reference boundary. The PTE itself is unchanged; only
query preparation and the corresponding canonical vectors changed.

## Run the isolated iOS Simulator gate

The simulator diagnostic is deliberately separate from the wallet feature
gate. It bundles one pre-verified PTE, the frozen tokenizer and the 36
repository conformance cases into a temporary iOS 17+ app, executes them in an
already booted Apple Silicon simulator and reads completion from unified logs:

```bash
./scripts/run-ios-simulator-diagnostic.sh xnnpack-a8w8
```

The diagnostic logs case IDs, timings and cosine values, but never prepared
text or embeddings, and it does not enable Monero Enthusiast in the wallet.

The 2026-07-30 iPhone 17 Pro simulator V2 run completed all 36 cases. A8W8
passed at minimum cosine `0.997210` with a `1,551.229 ms` model load and
`98.717 ms` mean inference time. Simulator timings validate integration on
the Mac host, not real iPhone speed, memory pressure, energy, thermals or
sustained performance.

Meta's official ExecuTorch 1.3.1 Apple binary packages declare macOS 12 and
iOS 17 as their minimum platforms. They can therefore support the current
macOS build and iOS 17+, but cannot be placed into the app's existing iOS
15.1 target. iOS 15–16 needs an exact source-built ExecuTorch 1.3.1 package
and its own device conformance evidence; the build must not silently raise the
wallet's minimum iOS version.
