# Monero Fast Wallet Desktop

The desktop wallet is a Tauri application. Develop and build it locally; do
not edit it on a server.

## Quick start (macOS)

```bash
cd apps/desktop
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

