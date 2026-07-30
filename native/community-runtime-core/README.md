# Community Runtime Core

Native orchestration boundary for Monero Enthusiast V1.

It keeps the following operations below React/Tauri renderers:

1. verify a pinned Ed25519 artifact manifest and stream-hash the exact PTE,
   tokenizer and native conformance report;
2. load the verified assets into the wallet-independent C++ ExecuTorch adapter;
3. normalize a submitted query and attach the frozen Harrier instruction;
4. run local inference and pass the 640-float vector directly into
   `community-search-core`;
5. return only final public search-result DTOs.

There is no HTTP client, wallet dependency or API that returns embeddings or
token IDs. Platform code supplies pinned catalog/artifact verification keys and
private application-storage paths. Missing keys or assets fail closed.

The `native-harrier` feature declares the small C ABI implemented by
`native/community-harrier-runtime`. The final platform target must link that C++
library and its verified ExecuTorch/tokenizer dependencies.
