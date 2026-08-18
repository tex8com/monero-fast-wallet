# Monero Fast Wallet Desktop

The desktop wallet is a Tauri application. Develop and build it locally; do
not edit it on a server.

## Quick start (macOS)

```bash
cd wallets/desktop
npm install
npm run dev:wallet
```

## Verify and build

```bash
npm run check
npm run desktop:test
npm run bundle:mac:unsigned
```

The application bundle is created locally. Commit and push source changes from
the repository root; deployment hosts only receive an already reviewed release.

## Default mainnet privacy routing

The desktop wallet starts an embedded Tor SOCKS proxy. Its first-party mainnet
daemon RPC route uses the selected Tor v3 Onion endpoint (`:18089`), and
first-party application services use Onion origins. The separately configured
MFN gRPC/ScanPack block stream uses the Clearnet `:18091` endpoint for
throughput. This is a deliberate default split: a Clearnet block stream still
reveals a network connection to the stream provider. A user-selected custom
node or scanner origin can use a different route.
