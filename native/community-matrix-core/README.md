# Community Matrix Core

Audited Matrix SDK boundary for Monero Enthusiast V1 direct chat.

- pinned `matrix-sdk` 0.18.0 with Olm/Megolm E2EE and bundled persistent
  SQLite crypto/state stores;
- HTTPS-only production homeservers;
- encrypted direct rooms only, with exactly two active members;
- no room key, Matrix session, recovery input or plaintext search index crosses
  the React/Tauri bridge;
- only the decrypted messages currently displayed by the user, plus one
  explicitly selected report preview, may cross the audited display bridge;
  platform renderers must keep that text ephemeral and must never log, cache or
  persist it;
- no listing ID, product terms or prepared “reply to offer” field exists;
- local send-rate limits and Matrix ignore/unignore support;
- cross-signing and key backup are enabled through the SDK recovery API;
- the SQLite store passphrase and Matrix session JSON must come from native OS
  secure storage and must never be logged, backed up in plaintext or placed in
  renderer state.

The Core has no wallet dependency. Account provisioning, generic push wakes
and voluntary single-message moderation intake are separate services; the
homeserver and push provider never receive room plaintext.

For mobile release packaging, build this crate with the `community-runtime`
feature. That produces one aggregate Rust archive containing Matrix and the
signed local catalog/runtime ABI, avoiding a duplicate Rust standard library.
The separate verified Harrier C++ archive and its ExecuTorch/tokenizer link
inputs remain platform artifacts. `build-mobile.sh` requires their exact
per-target path when `WITH_COMMUNITY_RUNTIME=1`; a release build fails closed
when either half is absent.

## Portable native ABI

`include/community_matrix_core.h` exposes the same pinned Rust/Matrix SDK
implementation to Android, iOS, macOS, Windows and Linux. The opaque handle
owns its Tokio runtime and encrypted Matrix store. Platform adapters supply the
OS-protected store passphrase and session JSON, invoke the ABI away from the UI
thread, and immediately zeroize returned secret buffers.

The ABI rejects production HTTP homeservers, unencrypted or non-direct rooms,
oversized messages and invalid pagination. It includes login/restore/session
refresh, bounded sync, direct-room creation, text send/read, selected-message
report preview, block/unblock and recovery. No wallet API is linked into this
library.
