# Monero Enthusiast Harrier testbench

This directory freezes the local embedding reference boundary before any
runtime is placed in a wallet build.

Pinned inputs:

- Microsoft `microsoft/harrier-oss-v1-270m` revision
  `31de22b673913c7d658c0f03f792d77c2dcf8ebd`;
- source weights SHA-256
  `90933b6826b61afd9331e0ebe3c0598b421a32eda5fb301a114fe36f306cb51a`;
- tokenizer SHA-256
  `6852f8d561078cc0cebe70ca03c5bfdd0d60a45f9d2e0e1e4cc05b68e9ec329e`;
- 640 float32 output dimensions, last non-padding token and L2 normalization;
- neutral `community-query-v2` instruction and a 256-token local query limit.

The canonical generator requires an isolated Python 3.11 environment and the
exact versions in `requirements.txt`. Export and portable-runtime execution use
the separate exact stack in `requirements-export.txt`, plus `flatc`. Do not
silently use another dependency set. Keep the large source model, virtual
environments and PTE build outputs outside the Git worktree.

Generate a fresh reference file and compare it byte-for-byte with
`reference_vectors.v2.json`:

```bash
python generate_reference_vectors.py \
  --model-cache /path/to/pinned-huggingface-cache \
  --output build/reference-vectors.json

cmp reference_vectors.v2.json build/reference-vectors.json
```

Export the accepted CPU baseline, execute all frozen cases and compare them:

```bash
python export_xnnpack.py \
  --model-dir /path/to/pinned-model-snapshot \
  --model-cache /path/to/pinned-huggingface-cache \
  --exporter-source /path/to/exact-optimum-executorch-checkout \
  --output /external/build/harrier-v1.pte \
  --report /external/build/export-report.json

python run_executorch_vectors.py \
  --pte /external/build/harrier-v1.pte \
  --expected-pte-sha256 237b9297d51ec3904042d06de340755365483da0be0054fa05b9d17468274d02 \
  --backend xnnpack-a8w8 \
  --model-cache /path/to/pinned-huggingface-cache \
  --output /external/build/xnnpack-vectors.json

python compare_embeddings.py \
  --reference reference_vectors.v2.json \
  --candidate /external/build/xnnpack-vectors.json \
  --backend xnnpack-a8w8 \
  --output /external/build/xnnpack-conformance.json
```

The generator loads the official model ID plus exact source revision from the
verified local cache. This avoids the known Transformers 4.57.x false
Mistral-regex warning for Gemma tokenizers loaded from a local directory that
also contains model files. It never enables remote inference or remote code.

Each platform runner must export exactly the same case identifiers and
640-dimensional finite L2-normalized vectors together with the exact model,
tokenizer, prompt, pooling, normalization and reference-case contract. Duplicate
case IDs, altered metadata, a mismatched backend/PTE hash and non-ExecuTorch
output fail closed. A runtime artifact is rejected if the minimum cosine against
the canonical vectors is below `0.98`.

## Current evidence

- The 36 canonical vectors were generated twice with byte-identical output.
  `reference_vectors.v2.json` has SHA-256
  `e5731dc99b676e4186646c9a1d277ad1d20717231ee04f70da0a3fd10d0c39fd`.
- XNNPACK A8W8/per-axis passed all 36 V2 cases with minimum cosine
  `0.997210`.
  The PTE is 270,419,584 bytes, has SHA-256
  `237b9297d51ec3904042d06de340755365483da0be0054fa05b9d17468274d02`,
  and contains 167 XNNPACK-delegated subgraphs with 2,289 delegated nodes.
- The native macOS ARM64 C++ adapter reproduced every frozen tokenizer
  sequence exactly and passed the same 36 V2 cases at minimum cosine
  `0.997210`. Its machine-readable result is
  `evidence/xnnpack-a8w8-native-macos-conformance.v2.json`.
- The isolated iPhone 17 Pro, iOS 26.5 simulator diagnostic passed all 36 V2
  cases at minimum cosine `0.997210`, with `98.717 ms` mean inference time.
  This proves the native iOS integration path, not physical-device
  performance. Evidence is in
  `evidence/xnnpack-a8w8-ios-simulator-conformance.v2.json`.
- An isolated ADB benchmark executed the accepted A8W8 PTE through the
  official ExecuTorch 1.3.1 Android AAR on a physical Pixel 8 Pro. Three runs
  of 30 measured embeddings, each after five warm-ups, produced an aggregate
  `0.682067` embeddings/s. The measured interval includes `forward`, JNI
  output materialization and output shape/norm validation; loading,
  tokenization, tensor creation, catalog search and React Native are excluded.
  Evidence is in
  `evidence/android-pixel8pro-xnnpack-a8w8-benchmark-2026-07-28.v1.json`.
- A separate physical Pixel 8 Pro end-to-end similarity gate embedded four
  long German product listings and 20 labeled query/listing pairs, then
  installed the vectors into the real `community-search-core` SQLite +
  USearch database on Android. The harder field-coverage suite passed 17 of 20
  expected top results: every title, late-bullet and negative-pair query
  passed, while three of four unique queries from the end of the long
  descriptions ranked only second. The listings contain 666–773 tokens and
  the current single-vector input retains only the first 256, so this is a
  real truncation failure rather than a database failure. Positive mean cosine
  was `0.656192`, negative mean cosine was `0.505467`, and ROC AUC was
  `0.885417`. Native database search averaged `0.505320 ms` across 2,000
  calls. Evidence is in
  `evidence/android-pixel8pro-product-similarity-vector-db-2026-07-28.v1.json`.
- The multi-vector follow-up kept the same four listings and 20 labeled
  queries but indexed seven bounded vectors per product: one title, three
  grouped-bullet and three overlapping-description vectors. All 28 product
  vectors stayed below 152 tokens, so none was truncated. On the same physical
  Pixel 8 Pro, 48 measured product/query embeddings reached `0.672927`/s.
  The real Android SQLite + USearch path installed four products and 28 vectors,
  deduplicated chunk hits back to products and passed 19 of 20 expected top
  results. Title, late-bullet and negative cases passed 16/16; description-tail
  coverage improved from 1/4 to 3/4. ROC AUC improved from `0.885417` to
  `0.989583` and the positive/negative mean-cosine gap from `0.150725` to
  `0.188236`. Search averaged `2.813681 ms` over 2,000 calls. The remaining
  rank-2 Rucksack description case is an embedding semantic mismatch against a
  generic Wallet bullet, not truncation or a database failure. Evidence is in
  `evidence/android-pixel8pro-product-multivector-similarity-vector-db-2026-07-29.v1.json`.
- An expanded Apple M4 diagnostic indexed 12 long products as 84 vectors and
  evaluated 60 distinct queries as 120 positive/hard-negative pairs through
  the same SQLite + USearch path. The legacy query instruction passed only
  47/60 Top-1 cases; all 13 failures incorrectly preferred the privacy-wallet
  listing. The otherwise identical broad instruction without the literal word
  `Monero` passed 60/60, as did a product-specific control. Product vectors
  were identical across all runs, isolating the defect to query-prompt bias.
  This diagnostic led to the versioned V2 fix. Historical evidence is in
  `evidence/macos-m4-expanded-product-prompt-ablation-2026-07-30.v1.json`.
- The production `community-query-v2` regression used the same 12 products,
  84 product vectors and 60 distinct queries. It passed 60/60 Top-1,
  60/60 Recall@5, MRR `1.0`, nDCG@5 `1.0` and all 120 polarity decisions.
  The legacy prompt is rejected and local V1/V2 query caches are securely
  discarded. Evidence is in
  `evidence/macos-m4-expanded-product-search-quality-2026-07-30.v2.json`.
- The large PTE remains outside Git. Repository evidence contains only the
  deterministic reference vectors and machine-readable export/conformance
  reports.

Generate the expanded quality fixture with either the production prompt or a
controlled test-only ablation:

```bash
python generate_expanded_product_quality_fixture.py \
  --model-dir /path/to/pinned-model-snapshot \
  --model-cache /path/to/pinned-huggingface-cache \
  --query-profile production-v2 \
  --output /external/build/expanded-prepared.json

python run_expanded_product_quality_pte.py \
  --pte /external/build/harrier-v1.pte \
  --fixture /external/build/expanded-prepared.json \
  --output /external/build/expanded-embeddings.json

cargo run --locked --release \
  --manifest-path ../../native/community-harrier-runtime/testbench/android-vector-db/Cargo.toml \
  -- \
  /external/build/expanded-embeddings.json \
  /external/build/expanded-search-storage
```

Allowed query profiles are `production-v2`, `legacy-monero-ablation-v1`,
`neutral-community-ablation-v1` and `product-specific-ablation-v1`. Only
`production-v2` is the current production contract; the others reproduce
controlled diagnostics.

Run the same isolated physical-Android benchmark with exactly one authorized
ARM64 device:

```bash
native/community-harrier-runtime/scripts/run-android-adb-benchmark.sh
```

Passing host conformance does not enable the feature: native packaging,
cold/warm latency, RAM, energy, thermal behavior, fallback behavior and
real-device tests are separate gates.

The official ExecuTorch 1.3.1 Apple prebuilts require iOS 17. The wallet still
targets iOS 15.1, so iOS 15–16 requires an exact source-built runtime rather
than an unreviewed deployment-target change.
