# Third-party notices

Monero Fast Wallet includes or links to third-party software. Each exact
release artifact must ship a generated dependency inventory and license report;
this source-level file records the major boundaries that must never be lost.

## Monero

The wallet Core is based on the Monero project and retains Monero's
BSD-3-Clause copyright and license notices. Monero is an independent project;
its name does not imply endorsement of TEX8 or Monero Fast Wallet.

## Cuprate

The node implementation under `node/cuprate/` retains Cuprate's upstream
multi-license files (`LICENSE`, `LICENSE-AGPL`, and `LICENSE-MIT`). Modified
network-service deployments must satisfy the applicable AGPL source-offer
obligations.

## Rust, JavaScript, Android, Apple, Tauri, and React Native dependencies

Dependencies retain their respective upstream licenses. The checked-in lock
files are the dependency version authority for a build; they are not a
substitute for the artifact-specific SBOM and complete license report.

### libPhoneNumber-iOS

The iOS contact-number normalization boundary uses `libPhoneNumber-iOS`, which
is distributed under the Apache License 2.0. The exact locked version is
recorded in `apps/mobile/ios/Podfile.lock`; the corresponding Apache-2.0 text is
included in `LICENSES/Apache-2.0.txt`.

### tor-android

The Android wallet embeds Guardian Project's `tor-android` and `jtorctl` for
app-private Onion connections. `tor-android` retains its BSD-3-Clause notice;
the corresponding license text is included in `LICENSES/BSD-3-Clause.txt`.

### Tor.framework

The iOS wallet embeds the iCepa `Tor.framework` wrapper and its bundled Tor
runtime for app-private Onion connections. The wrapper retains its MIT notice;
the corresponding license text is included in `LICENSES/MIT.txt`.

## Generated and copied material

Cryptographic test vectors, generated bindings, icons, fonts, and other assets
may have component-specific notices. A closer notice controls over the
repository default and must remain present in source and distributed artifacts.

This file is intentionally not a frozen package inventory. Use the repository
compliance testbench for the exact commit and attach its generated outputs to
the release record.
