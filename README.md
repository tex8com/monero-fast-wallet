# Monero Fast Wallet

Self-custodial Monero mobile wallet powered by our forked Monero
`libwallet_api` / `wallet2` core, with optional fast receive notifications.

The product goal is a Monero wallet that opens and feels ready quickly while
remaining compatible with normal Monero infrastructure. The wallet brain is not
`monero-wallet-cli` and not `monero-wallet-rpc`; those are only useful as
developer tools. The production app talks to a native iOS/Android bridge, which
talks directly to our forked Monero wallet library.

The default mode keeps all wallet secrets local. The optional fast receive mode
creates a separate notification receive identity whose private view key can be
hosted by our server-side scanner. The private spend key never leaves the
phone.

## Architecture Decision

Use our Monero fork from the beginning:

```text
React Native UI
  -> TypeScript WalletService
  -> Native wallet module
       iOS: Swift / Objective-C++
       Android: Kotlin / JNI
  -> native/monero-bridge C++ WalletEngine facade
  -> third_party/monero forked libwallet_api / wallet2
  -> remote node: monerod or our Cuprate fast-rpc/gRPC node
```

Rejected for the production wallet brain:

- parsing `monero-wallet-cli` stdout/stderr
- running `monero-wallet-rpc` as the in-app core
- storing seed, spend key, or main wallet private view key in JavaScript

Allowed for development only:

- `monero-wallet-cli` for manual comparison and debugging
- `monero-wallet-rpc` for early local harnesses and contract tests

## Core Principles

- Self-custody by default.
- Our forked `libwallet_api` / `wallet2` is the native wallet core.
- React Native owns UX only; wallet secrets and wallet state stay native.
- `monero-wallet-cli` and `monero-wallet-rpc` are not the product core.
- No private spend keys on servers.
- Main wallet stays private and local.
- Fast receive is opt-in and uses a separate receive identity.
- Server notifications are hints; the app verifies wallet state locally.
- Keep compatibility with upstream Monero and normal remote nodes.
- Use Cuprate as a fast node/scanner path without changing Monero consensus.
- Default mobile node mode is optimized Cuprate gRPC, while Settings can switch
  the same wallet core back to original Monero-compatible daemon RPC.

## Repository Shape

```text
apps/
  mobile/              React Native wallet app
native/
  monero-bridge/       C++ facade plus iOS/Android bridge to our wallet core
services/
  notify-scanner/      view-key scanner and push notification service
  wallet-api/          device registration and opt-in API
node/
  cuprate/             Cuprate node fork source
  cuprate-deploy/      node deployment, configs, benchmarks
third_party/
  monero/              pinned Monero fork with libwallet_api/wallet2
docs/
  ROADMAP.md
  ARCHITECTURE.md
  NATIVE_WALLET_BRIDGE.md
  PRIVACY_MODEL.md
  REPOSITORY_STRATEGY.md
  SOURCES.md
```

## Imported Local Sources

- Wallet app imported from `$HOME/Documents/Projects/tex8/prototypes/monero-wallet/app`
- Cuprate node source imported from `$HOME/Documents/Projects/cuprate`
- Monero GUI/Core fork source: `$HOME/Documents/Projects/monero-gui/monero`

Generated dependencies and build output are intentionally not imported:
`node_modules`, iOS `Pods`, iOS builds, Ruby vendor bundles, and Rust `target`.

## Native Bridge Status

Current local status on 2026-06-04:

- The React Native app has iOS and Android native modules backed by the shared
  C++ `WalletEngine` facade.
- Local macOS bridge smoke links against the forked Monero `libwallet_api`.
- Android `arm64-v8a` dependency archives and forked Monero `wallet_api`
  archives build locally.
- Android JNI links successfully against real gRPC-enabled Monero wallet
  archives, including `libcuprate_grpc_stream.a`.
- Android debug and instrumentation-test APKs build with the gRPC-enabled
  backend, and the debug APK packages
  `lib/arm64-v8a/libmonero_wallet_bridge_jni.so`.
- Android runtime smoke is implemented as an instrumentation test; execution on
  a real device/emulator is pending.
- iOS `ios-sim-arm64` and `ios-device` dependency archives and forked Monero
  `wallet_api` archives build locally.
- iOS links the React Native app against the real forked Monero wallet core via
  `build/ios-monero-link-manifests/$(PLATFORM_NAME)/libtex8_monero_wallet_core.a`.
- iOS arm64 simulator and unsigned `iphoneos` Debug builds succeed with the
  real backend. iOS gRPC stream support is still disabled until iOS gRPC static
  dependencies are added.
