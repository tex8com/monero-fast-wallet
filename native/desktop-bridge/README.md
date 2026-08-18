# Desktop Native Bridge

This directory defines the Rust-to-C++ boundary for `wallets/desktop`.

```text
React desktop UI -> Tauri command permissions -> Rust host
  -> native/desktop-bridge C ABI -> native/monero-bridge WalletEngine
  -> pinned forked Monero libwallet_api / wallet2
```

The C ABI is deliberately small. It currently exposes only a non-sensitive
link/readiness check, so a desktop shell cannot pretend it has a wallet backend
when it has been compiled without the forked Monero library.

Future C ABI methods must accept and return validated data-transfer objects
only. They must never expose C++ objects, seeds, spend keys, primary private
view keys, Ledger APDUs, or raw wallet passwords to the React renderer.

The Rust host stores only an optional wallet password in the operating system's
secure storage. It has no command to retrieve that password into JavaScript.
