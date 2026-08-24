# Monero Fast Wallet Desktop

The desktop wallet is a Tauri application. Develop and build it locally; do
not edit it on a server.

## Quick start (macOS)

```bash
cd wallets/desktop
npm install
npm run dev:wallet
```

`npm install` is only needed the first time or after dependency changes.
`dev:wallet` builds, signs, and launches the development app with the stable
macOS application identity so Keychain access behaves like the release app.

## Verify and build a signed macOS package

```bash
npm run check
npm run desktop:test
npm run bundle:mac
```

`bundle:mac` prepares and compiles the pinned Monero core, builds the Tauri 2
application, signs the app with the configured Developer ID, verifies the
signature, and creates a drag-to-Applications DMG. A clean native-core build can
take several minutes.

Cargo may redirect build output to an external volume. To locate the exact app
and DMG produced by the build:

```bash
MFW_CARGO_TARGET="$(
  cargo metadata \
    --manifest-path src-tauri/Cargo.toml \
    --no-deps \
    --format-version 1 \
  | node -e 'let input=""; process.stdin.on("data", chunk => input += chunk); process.stdin.on("end", () => process.stdout.write(JSON.parse(input).target_directory));'
)"

open -n "${MFW_CARGO_TARGET}/release/bundle/macos/Monero Fast Wallet.app"
open "${MFW_CARGO_TARGET}/release/bundle/dmg/Monero Fast Wallet_0.1.0_aarch64.dmg"
```

For a public macOS release that is also submitted to Apple, notarized, and
stapled, use:

```bash
npm run release:mac
```

This requires a valid `Developer ID Application` identity and the configured
notarytool Keychain profile (`monero-fast-wallet-notary` by default). Override
the profile with `MONERO_DESKTOP_NOTARY_PROFILE` when necessary.

An unsigned package remains available only for isolated diagnostics:

```bash
npm run bundle:mac:unsigned
```

Commit and push source changes from the repository root; deployment hosts only
receive an already reviewed release.

## Default mainnet privacy routing

The desktop wallet starts an embedded Tor SOCKS proxy. Its first-party mainnet
daemon RPC route uses the selected Tor v3 Onion endpoint (`:18089`), and
first-party application services use Onion origins. The separately configured
MFN gRPC/ScanPack block stream uses the Clearnet `:18091` endpoint for
throughput. This is a deliberate default split: a Clearnet block stream still
reveals a network connection to the stream provider. A user-selected custom
node or scanner origin can use a different route.
