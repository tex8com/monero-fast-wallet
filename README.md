# Monero Fast Wallet

GitHub: `https://github.com/tex8com/monero-fast-wallet`

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

Android and iOS are one mobile product target. A wallet feature is not complete
until both platforms expose the same user-facing behavior, or the remaining
platform gap is explicitly documented.

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
- Usability is a primary security feature; the product must be usable by
  non-technical people without understanding Monero internals.
- Trust and reputation are first-class product concerns for contact and payment
  flows.
- Nearby Monero enthusiast discovery is an optional social feature for
  conversation and private meetups, not a P2P trading service. Exact location
  and wallet identity must never be linked.
- Our forked `libwallet_api` / `wallet2` is the native wallet core.
- React Native owns UX only; wallet secrets and wallet state stay native.
- `monero-wallet-cli` and `monero-wallet-rpc` are not the product core.
- No private spend keys on servers.
- Main wallet stays private and local.
- Fast receive is opt-in and uses a separate receive identity.
- Server notifications are hints; the app verifies wallet state locally.
- [Desktop notification contract and APNs release gate](docs/DESKTOP_PUSH_NOTIFICATIONS.md)
- Keep compatibility with upstream Monero and normal remote nodes.
- Use Cuprate as a fast node/scanner path without changing Monero consensus.
- Default mobile node mode is optimized Cuprate gRPC, while Settings can switch
  the same wallet core back to original Monero-compatible daemon RPC.
- Ledger Nano hardware-wallet support is required for Monero. Hardware signing
  must go through the native wallet core on both Android and iOS; seed/private
  spend key material must never enter JavaScript or the server.
- Product direction for community discovery, phone-number sending, reputation,
  escrow, and Fast Wallet positioning is tracked in
  `docs/PRODUCT_TRUST_USABILITY_PLAN.md`. Marketplace UI is retained only as an
  unrouted prototype and is not part of the current wallet experience.
- A cross-platform desktop wallet now has a Tauri 2 + React + Rust shell. It
  uses a deliberately small Rust/C++ bridge to the same `WalletEngine`. The
  Apple Silicon macOS 12 build links the forked Monero core and bundled Rust
  fast-crypto dylib; its native suite passed real local create/open/subaddress
  tests and the DMG launches successfully. It remains an unsigned developer
  artifact: signing/notarization, physical Ledger, Windows/Linux core links,
  and broader release acceptance are gated as defined in
  `docs/DESKTOP_APP_PLAN.md`.

## Repository Shape

This repository is the product integration monorepo. It should contain the
mobile app, native bridge, scanner services, testbench, deployment notes, and
release documentation.

Monero and Cuprate should remain separately updateable forks. The product repo
pins the exact fork revisions used for a release instead of becoming the only
source of truth for upstream fork history.

Current remotes:

```text
product:      https://github.com/tex8com/monero-fast-wallet.git
Monero fork:  https://github.com/tex8com/monero.git
Cuprate fork: https://github.com/tex8com/cuprate.git
```

Recommended public-source shape:

- `monero-fast-wallet`: app, native bridge, scanner, docs, testbench, release
  manifests.
- `tex8com/monero`: forked Monero wallet core, kept close to official Monero
  tags.
- `tex8com/cuprate`: forked Cuprate node, kept close to upstream Cuprate where
  possible.
- Release tags in `monero-fast-wallet` record the exact Monero and Cuprate
  commits used by the app.

```text
apps/
  mobile/              React Native wallet app
  desktop/             Tauri 2 + React + Rust desktop wallet host
native/
  monero-bridge/       C++ facade plus iOS/Android bridge to our wallet core
  desktop-bridge/      narrow C ABI between Rust desktop host and WalletEngine
services/
  notify-scanner/      hosted view-key registration/removal API and scanner
  enthusiast-discovery/ anonymous approximate-area community API
node/
  cuprate/             pinned Cuprate fork source snapshot
third_party/
  monero-patches/      ordered production Monero Core patch series
  cuprate-patches/     ordered production Cuprate patch series
  curve25519-dalek-wallet-cpu/
                       ordered CPU acceleration patch series
  monero-experimental-patches/
                       optional tracing and CUDA-stage worktree snapshots
tools/
  wallet-*-testbench/  CPU, Metal, mobile and CUDA benchmark sources
docs/
  ROADMAP.md
  PRODUCT_TRUST_USABILITY_PLAN.md
  ARCHITECTURE.md
  NATIVE_WALLET_BRIDGE.md
  BACKEND_TESTING.md
  PRIVACY_MODEL.md
  DESKTOP_APP_PLAN.md
  DESKTOP_PARITY_MATRIX.md
  REPOSITORY_STRATEGY.md
  SOURCES.md
```

## Imported Local Sources

- Wallet app imported from `$HOME/Documents/Projects/tex8/prototypes/monero-wallet/app`
- Cuprate node source imported from `$HOME/Documents/Projects/cuprate`
- Monero GUI/Core fork source: `$HOME/Documents/Projects/monero-gui/monero`

Generated dependencies and build output are intentionally not imported:
`node_modules`, iOS `Pods`, iOS builds, Ruby vendor bundles, and Rust `target`.

## Wallet Core Source

The wallet core comes from the official Monero implementation through our fork.

- Official wallet engine: `src/wallet/wallet2.*`
- Official C++ library API: `src/wallet/api/*`, including `libwallet_api`
- Our local fork checkout: `$HOME/Documents/Projects/monero-gui/monero`
- Fork remote: `https://github.com/tex8com/monero.git`
- Current pinned commit:
  `cdcfa8151322a3fdd9306af97ab0c54092ac1e37`
- Reproducible product series:
  `third_party/monero-patches/series`
- Acceleration sources and evidence:
  `docs/WALLET_ACCELERATION_TESTBENCH_INDEX.md`

The app does not shell out to `monero-wallet-cli`. The production path is:

```text
React Native -> native module -> WalletEngine -> forked libwallet_api/wallet2
```

`monero-wallet-cli` remains a development and acceptance-test tool because it
uses the same underlying wallet code path.

## Open Source Plan

The repo should be prepared as an open-source product from the start:

- keep secrets, wallet files, build outputs, and server env files out of Git
- document exactly which fork commits are used for each release
- keep user-facing wallet code separate from production server secrets
- preserve upstream license notices for Monero, Cuprate, RandomX, and mobile
  dependencies
- keep Tex8-specific wallet changes small, named, and testbench-covered
- publish only reproducible source states: commit, push, tag, then build

Before the first public release, add or verify:

- `LICENSE` and third-party license summary
- [`SECURITY.md`](SECURITY.md), the
  [threat model](docs/THREAT_MODEL.md), the
  [incident runbook](docs/SECURITY_INCIDENT_RESPONSE.md), and working private
  reporting/response ownership
- build instructions for Android, iOS, scanner, and forked wallet core
- privacy model and fast receive warning text
- testbench instructions and latest passing gate matrix
- the [secure release checklist](docs/SECURE_RELEASE_CHECKLIST.md) with pinned
  Monero/Cuprate commits and artifact evidence

## Native Bridge Status

Current mobile-native status on 2026-07-10 local:

- The React Native app has iOS and Android native modules backed by the shared
  C++ `WalletEngine` facade.
- Node profile metadata stays in AsyncStorage, but daemon passwords now go
  through native secure storage: iOS Keychain and Android Keystore-backed
  AES-GCM storage. Wallet daemon application can use the stored password
  without returning it back to JavaScript.
- Local macOS bridge smoke links against the forked Monero `libwallet_api`.
- Android `arm64-v8a` dependency archives and forked Monero `wallet_api`
  archives build locally.
- Android JNI links successfully against real gRPC-enabled Monero wallet
  archives, including `libcuprate_grpc_stream.a`.
- Android Monero wallet archives now build with `hidapi`/`libusb`, so the
  official Monero `device_ledger` and `device_io_hid` code is present in
  `libdevice.a`.
- Android release APKs build with the gRPC-enabled backend through
  `npm run android:build`, and the APK packages
  `lib/arm64-v8a/libmonero_wallet_bridge_jni.so` plus the bundled JavaScript.
- Android exposes Ledger USB transport diagnostics and can request Android USB
  host permission before creating a Ledger-backed wallet. Its native BLE path
  scans Ledger Nano X service UUIDs, exchanges official `0x05` GATT frames, and
  routes APDUs into the forked Monero `device_ledger` callback transport.
- Android runtime smoke is implemented as an instrumentation test; execution on
  a real device/emulator is pending.
- iOS `ios-sim-arm64` and `ios-device` dependency archives, gRPC/protobuf
  dependency archives, fast-crypto archives, and forked Monero `wallet_api`
  archives build locally.
- iOS links the React Native app against the real forked Monero wallet core via
  `build/ios-monero-link-manifests/$(PLATFORM_NAME)/libtex8_monero_wallet_core.a`.
- iOS arm64 simulator and unsigned `iphoneos` Debug builds succeed with the
  real gRPC-enabled backend, including `libcuprate_grpc_stream.a`.
- iOS links `CoreBluetooth.framework` and implements the matching Ledger Nano X
  BLE transport. The real-wallet-core simulator app links successfully; the
  simulator correctly reports that physical BLE hardware is unavailable.
- The iOS Release simulator build links the real wallet core and Firebase
  Messaging under bundle id `com.tex8.monerowallet`; native diagnostics open
  the registered Mainnet wallet, apply Cuprate RPC/gRPC, and confirm the hosted
  Fast Wallet registration without errors.
- Android and iOS share the Firebase Messaging lifecycle, anonymous Tex8 push
  subscription registration, token refresh, foreground/background event
  parsing, and Fast Wallet status plumbing. Real FCM/APNs delivery remains a
  physical-device/provider-credential acceptance gate.
- The bridge now exposes real transaction history and a two-step software send
  path through `getTransactions`, `prepareTransaction`, and
  `commitTransaction`; Home/Send render wallet history from `wallet2` instead
  of static placeholders.
- Fast Wallet identities are first-class spendable wallets in the same wallet
  registry as privacy and Ledger wallets. Their restore height is persisted and
  supplied when reopening. If an old cache is behind that height, the bridge
  performs one guarded soft rescan before enabling send; subsequent blocks are
  followed continuously. Offline height fallback now uses Monero's
  conservative estimate instead of a future-prone raw clock estimate.
- Ledger Nano support is mandatory. The shared bridge contract now has
  create-from-device, status, reconnect, and show-address-on-device methods,
  and the app has a Ledger setup path plus Receive-screen address confirmation.
  Android retains its USB/HID build and permission gate. Android and iOS both
  implement native Ledger Nano X BLE discovery, `0x05` framing, response
  assembly, timeout handling, and the callback connection to forked Monero
  `device_ledger`. Physical Nano X creation, address confirmation, signing, and
  reconnect acceptance are still pending before mainnet beta.
- The 2026-07-10 Mainnet Fast Receive E2E sent a small payment through Cuprate,
  detected it in the mempool, confirmed it, found it through the native gRPC
  wallet core, and removed the temporary hosted watch.
- The same encrypted Fast Wallet later sent a smaller payment back to an owned
  funded test wallet through Cuprate RPC + gRPC. It reached
  `commit_status=ok`, appeared as outgoing and pending in the Fast Wallet, and
  was detected by the destination wallet in the mempool. Exact transaction
  evidence remains in local, non-versioned acceptance logs.
