# Cuprate live deployment overlays

These overlays are separate from the historical 41-patch production series.
They apply to the exact, already deployed source ancestry recorded here and
must not be applied directly to the older series head.

- base commit: `8185b337ab5e26d93a61f2c231d52a573ae97bc1`
- pre-overlay production binary SHA-256:
  `8c3c54c6c535cf84997977446074f5d4025da44b121560b3d5fce60857d096ba`
- overlay order:
  1. `0001-wallet-sync-persistent-striped-grpc-lanes.patch`
  2. `0002-wallet-sync-split-oversized-lane-chunks.patch`
  3. `0003-wallet-sync-release-active-stream-count-on-all-exits.patch`
  4. `0004-wallet-sync-allow-six-persistent-lanes.patch`

The overlay keeps the legacy `StreamBlocks` method and adds the capability-safe
`StreamBlockLane` method. Build it natively on the server with Cargo's locked
dependency graph. Deploy only after source hashes, tests and the release binary
hash are recorded; retain an atomic rollback copy of the prior binary.

The second overlay keeps the 32-MiB per-lane memory bound. If exact EPEE
encoding exceeds it, the producer cancels the speculative next fetch, halves
the current block count, and retries the same height without closing the RPC.
Only an individually encoded block above the limit fails closed.

The third overlay makes the active-stream metric cancellation-safe. A guard
owned by the producer task releases the counter on success, early error,
cancellation and unwind; it changes telemetry only, not request validation or
wallet data.

The fourth overlay raises only the validated lane-count ceiling from four to
six. A physical Pixel full-range raw-transport test measured 40.300476 MiB/s
with four lanes and 59.588780 MiB/s with six; range ownership, ordering,
32-MiB response limits and queue bounds remain unchanged.
