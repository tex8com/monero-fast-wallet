# Architecture

Monero Fast Wallet is a self-custodial wallet product for iOS, Android and
desktop. It is a monorepo: the applications, native bridges, node integration,
shared contracts and supporting services live together while retaining clear
security boundaries.

## Trust boundaries

- Seeds, spend keys, transaction construction and final transaction
  verification remain on the user's device or Ledger.
- The wallet uses established Monero wallet-core paths for wallet semantics and
  signing. Project additions do not introduce a hosted spending path.
- Monero Fast Node supplies compatible node and streaming functionality. A
  user can choose a different node when their privacy or availability needs
  require it.
- The wallet uses one native `NetworkSyncCoordinator` for each active network:
  node handshakes equal active networks, not wallet count.
- Optional Fast Receive functionality uses an isolated view key and opaque
  wake-up notifications. It is a convenience mode, not a replacement for local
  verification.

## Repository layout

- `wallets/` contains mobile, desktop, CLI and TUI wallet applications.
- `native/` contains the native wallet bridge, shared product core and protocol
  libraries.
- `node/` contains the integrated Monero Fast Node source.
- `backend/` and `services/` contain optional supporting services.
- `packages/` contains shared application contracts.
- `third_party/` contains upstream-derived and vendored material with retained
  licenses and notices.

Read the component README before changing a security-critical or
upstream-derived area.
