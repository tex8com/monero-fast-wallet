# Monero benchmark and acceleration worktree snapshots

The main production patch order is
`third_party/monero-patches/series`. This directory preserves additional
worktree-only experiments that were not suitable for silently appending to
that ordered product series.

`0001-wallet-sync-trace-instrumentation.patch` is an optional benchmark-only
instrumentation diff against upstream Monero commit
`dbcc7d212c09`. It adds `MONERO_SYNC_TRACE=1` timing output and is not required
by production wallets.

`0002-wallet-cuda-stage-core-worktree.patch` records the complete staged core
diff from the CUDA/full acceleration worktree at base
`d8cec9300204301d58f0c98eeb7480971708b4a0`. Its SHA-256 as exported from Git
is:

```text
d4d4a3e73cfd309c29045dd5ec8450f0b7a2349b87c89972b1d831e5d269ec25
```

The CUDA testbench source itself is stored directly at
`tools/wallet-cuda-testbench`. These experimental patches are archival inputs;
they must be rebased and reviewed before being added to the production patch
series.
