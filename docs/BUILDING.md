# Building from source

Use a clean checkout and the lockfiles supplied by each component. Do not use
real wallets, seeds, keys or production credentials in local development.

## Prerequisites

- Node.js 22.11 or newer
- Rust as pinned in `rust-toolchain.toml`
- Xcode for iOS and macOS builds
- Android SDK, NDK and Java for Android builds
- Native Monero dependencies required by the relevant build scripts

## Mobile

```bash
cd wallets/mobile
npm ci
npm run lint
npm test -- --runInBand
```

## Desktop

```bash
cd wallets/desktop
npm ci
npm run build
npm run test:parity-contract
npm run test:platform-contract
npm run test:wallet-contract
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

## Services

Each Rust service owns its own `Cargo.toml` and lockfile. Run its locked test
suite from the repository root, for example:

```bash
cargo test --locked --manifest-path backend/fast-wallet-worker/scanner-core/Cargo.toml
```

Build output, local caches, credentials and generated wallet files must remain
outside Git.
