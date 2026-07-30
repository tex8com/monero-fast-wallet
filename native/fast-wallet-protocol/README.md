# Fast Wallet Protocol

Project-authored native protocol core for the selected-worker Fast Wallet V1.

The initial implementation pins RFC 9180
`DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / ChaCha20Poly1305`, canonical
binary schemas, Ed25519 worker descriptors, fixed-size watch envelopes, strict
expiry/network/purpose/assignment binding, and zeroizing secret containers.

This crate does not expose a private view key through React, Tauri IPC, generic
JSON, logs, or the Relay. Platform adapters must obtain the key from the
already-open native Monero wallet and pass it directly into this crate.
