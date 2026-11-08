# Third-party notices

Monero Fast Wallet includes or links to third-party software. Each exact
release artifact must ship a generated dependency inventory and license report;
this source-level file records the major boundaries that must never be lost.

## Monero

The wallet Core is based on the Monero project and retains Monero's
BSD-3-Clause copyright and license notices. Monero is an independent project;
its name does not imply endorsement of TEX8 or Monero Fast Wallet.

## Cuprate

The node implementation under `node/mfn-monero-fast-node/` retains Cuprate's upstream
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
recorded in `wallets/mobile/ios/Podfile.lock`; the corresponding Apache-2.0 text is
included in `LICENSES/Apache-2.0.txt`.

### tor-android

The Android wallet embeds Guardian Project's `tor-android` and `jtorctl` for
app-private Onion connections. `tor-android` retains its BSD-3-Clause notice;
the corresponding license text is included in `LICENSES/BSD-3-Clause.txt`.

### Tor.framework

The iOS wallet embeds the iCepa `Tor.framework` wrapper and its bundled Tor
runtime for app-private Onion connections. The wrapper retains its MIT notice;
the corresponding license text is included in `LICENSES/MIT.txt`.

### GLib0.18.5 security backport

`third_party/glib-0.18.5/` retains the gtk-rs Project Developers' MIT license
and copyright. The API-preserving VariantStrIter fix is pinned to official
upstream commit `b5a4071e439bef2b5eea76c3aa25e5ae84839e34`; original package
checksums, patch and regression instructions are in `third_party/glib-backport/`.

### crypto-bigint and parent API adapters

Production uses the unmodified crates.io `crypto-bigint 0.7.10` release by the
RustCrypto Developers under Apache-2.0 OR MIT. Its exact archive checksum and
the API migration evidence are recorded in `third_party/crypto-bigint-migration/`.
The local adapters use that fixed arithmetic implementation; they do not rename
the vulnerable 0.5 release or maintain a separate big-integer implementation.

The `dalek-ff-group 0.4.6` and `0.5.0`, `minimal-ed448 0.4.2`, and
`monero-generators 0.4.0` source trees retain Luke Parker's MIT notices;
`monero-generators` also retains the monero-oxide Developers' copyright.
The Serai packages originate from `https://github.com/serai-dex/serai`, and
`monero-generators` comes from the monero-oxide revision
`7c288b058ae7f1e3d36600a2af11b3176102bcfc`.
The `elliptic-curve 0.13.8` adapter retains the RustCrypto Developers'
Apache-2.0 OR MIT licenses from `https://github.com/RustCrypto/traits`.
Each local source tree keeps its original license text and provenance.

The `k256 0.13.4`, `p256 0.13.2`, and `primeorder 0.13.6` API adapters retain
the RustCrypto Developers' Apache-2.0 OR MIT licenses from
`https://github.com/RustCrypto/elliptic-curves`. They are retained for the
migration's compatibility tests and are not production path patches. The
artifact-specific dependency inventory determines whether any such package is
actually compiled or distributed; optional Cargo metadata alone does not.

### Arti client-only RSA and SSH forks

`third_party/tor-llcrypto-0.47.0/`, `tor-key-forge-0.47.0/`,
`tor-cert-0.47.0/`, and `tor-netdoc-0.47.0/` originate from The Tor Project's
Arti revision `ce8bc6e0998bd5a4efdf06dd62dce53c98ea1087` at
`https://gitlab.torproject.org/tpo/core/arti`. They retain The Tor Project's
MIT OR Apache-2.0 notices and both license texts.
`third_party/ssh-key-fork-arti-0.6.7/` retains the RustCrypto Project
Developers' Apache-2.0 OR MIT notices from
`https://github.com/RustCrypto/SSH/tree/master/ssh-key`.
Exact registry archives, file hashes, local changes, and copied Arti license
origins are recorded in `third_party/tor-rsa-client/`.

These are application-specific Tor client forks. They retain public-key
decoding and Tor's raw-hash PKCS#1 v1.5 signature verification, using OpenSSL
public operations. Private RSA generation/signing and corresponding relay
APIs are deliberately unavailable; unsupported private RSA imports fail.
The SSH fork retains codecs needed by the client while removing unused
asymmetric cryptographic backends. It is not a general replacement for the
complete upstream SSH or Tor relay APIs.
The Rust `openssl` bindings retain their Apache-2.0 notices; OpenSSL 3
itself retains its Apache-2.0 notices. Each release must inventory the actual
linked or bundled OpenSSL libraries and ship their applicable license texts.

## Generated and copied material

Cryptographic test vectors, generated bindings, icons, fonts, and other assets
may have component-specific notices. A closer notice controls over the
repository default and must remain present in source and distributed artifacts.

This file is intentionally not a frozen package inventory. Use the repository
compliance testbench for the exact commit and attach its generated outputs to
the release record.
