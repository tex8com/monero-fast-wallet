# MFW Tor client-only RSA backend

This is a deliberately client-only fork of four Arti 0.47.0 crates and the SSH 0.6.7 codec. It removes
RustCrypto `rsa` from the desktop client's dependency graph; it does not pretend
that RUSTSEC-2023-0071 has an upstream fixed release. The upstream advisory says
there is no patched version:
https://rustsec.org/advisories/RUSTSEC-2023-0071.html

`upstream.json` pins every original crates.io archive by its published SHA-256,
Arti VCS commit and per-file hashes. `client-only.patch` records the local source
changes. Package versions are unchanged: Cargo resolves these explicitly through
local `[patch.crates-io]` entries, not an invented upstream release. Original
MIT/Apache-2.0 licenses and Tor copyright notices are retained.

The public RSA verifier delegates to OpenSSL's public-only PKCS#1 v1.5 operation.
Tor signs the raw digest without a DigestInfo OID, so the usual Ring or OpenSSL
SHA-1 signature verifier is not a compatible substitute. The verifier checks exact
modulus-width signatures, full type-1 padding, raw digest equality and the same
public-component bounds as the former implementation. PKCS#1 public DER must be
canonical and fully consumed. Public DER, Tor fingerprints, key equality and SSH
public-key serialization retain their wire representation.

The OpenSSL public operation is documented here:
https://docs.openssl.org/3.0/man3/RSA_public_decrypt/
It performs no private RSA operation. The API is deprecated by OpenSSL in favor of
EVP for new applications, but retained as its supported legacy raw PKCS#1
verification interface. Do not substitute `RSA_NO_PADDING` or weaken padding
checks in production.

The SSH codec fork also removes the optional asymmetric crypto dependencies and
features (`rsa`, `dsa`, `ed25519`, `p256`, `p384`, `p521`, `crypto`) from its
manifest, so Cargo cannot resolve them even as unused lockfile packages. These
feature requests fail at Cargo resolution; they are not empty no-op features.
The original raw key/mpint/SSH encoders and decoders remain unchanged, including
an optional SEC1 ECDSA *codec* with no NIST curve/signing implementation. `std`
is the only default. Existing original crypto-gated source is retained for
provenance but is not reachable through any declared Cargo feature. Explicit
check-cfg declarations recognize those deliberately unavailable upstream cfg
names without making Cargo features available.

## Deliberately unavailable APIs

- `tor-llcrypto::pk::rsa::KeyPair`, private-key conversions, signing/generation,
  the backend-specific RustCrypto `as_key` accessor and `rsa::Error` re-export.
  Public unsigned component accessors replace the latter backend coupling.
- `tor-key-forge` private RSA key generation/import/encoding and RSA keypair
  wrapper macros. SSH private RSA imports return `UnsupportedKeyAlgorithm`;
  there is no dummy private-key type or pretend signing implementation.
- `tor-cert` RSA cross-certificate signing module. RSA cross-certificate
  decoding/signature validation remains compiled and checked.
- `tor-netdoc` authority-certificate constructors/signing and raw-RSA signing
  helper. Parsing, consensus/certificate verification, Ed25519 signing and time
  validity checks remain. Only tests of the deliberately removed private APIs
  were removed; public parser/verification tests and the known Tor RSA vector
  are retained, with new adversarial public-verification tests.

The `tor-llcrypto/relay` feature now fails explicitly at compile time. This fork
must not be reused as an Arti relay/authority library. It is applied only to the
desktop Cargo root; separate service/server/mobile roots are not changed or
claimed repaired by this work. The retained upstream package-local Cargo.lock
files are provenance, not the desktop/fixture resolution: root lockfiles govern
actual builds.

## Native backend and rebuild boundaries

Linux links its existing system OpenSSL (Ubuntu 24.04 libssl3t64/libssl-dev),
already required/staged by `prepare-linux-monero-core.sh`. macOS uses the existing
Monero Core depends SDK via `OPENSSL_DIR`, `OPENSSL_STATIC=1` and
`OPENSSL_NO_VENDOR=1` in the platform build script. No second Homebrew/vendored
OpenSSL version should enter the Mac link. Its force-loaded Core archives still
require a fresh link/closure inspection; source configuration is not proof.
Windows/MSVC alone uses `openssl/vendored`, compiling and statically linking a
native MSVC archive. It needs the upstream openssl-src prerequisites (Perl, C
toolchain and make); the existing MinGW Core OpenSSL archive is not a substitute.
Neither a macOS nor Windows new package is validated by the Linux test run. Both
require a fresh platform build, dependency/package inspection and runtime tests
before any replacement release. Existing installed/released packages remain
unchanged.

## Regression evidence

`test-release.py` creates a clean, source-hash-checked copy of just the five
vendored packages outside the source tree. It runs the known upstream Tor RSA
signature/fingerprint vector, adversarial padding/DER/width/key/hash/component
checks, SSH public-key roundtrip/private-RSA rejection, and existing public
certificate/netdoc/SSH parser tests. It also checks that all seven removed
asymmetric feature requests are rejected before compilation. The runner uses
optimized `--release` tests (opt-level 3, debug assertions off);
compiler concurrency is limited to two jobs. Earlier exploratory logs marked
`test profile [unoptimized + debuginfo]` are Debug evidence only.
The desktop target graph must additionally contain no reachable `rsa` package;
passing source tests alone does not prove the installed AppImage or real push
notification behavior.

Example (Linux system OpenSSL):

```sh
python3 third_party/tor-rsa-client/test-release.py \
  --work-dir /tmp/mfw-rsa-client-fixture \
  --lockfile wallets/desktop/src-tauri/Cargo.lock \
  --output /tmp/mfw-rsa-client-results.json
```

The isolated fixture lock can add upstream development dependencies, but does
not write to the desktop lockfile. Every tested source file and both the input
lock and resolved fixture lock are hashed in the report.
