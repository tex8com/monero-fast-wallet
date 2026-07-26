# Wallet Crypto-Testbench

This testbench measures only the Monero key derivation `D = 8 * a * R`. It does
not contain node transport, database access, ScanPack, blockparser or wallet
commit. Thus, its derivatives must never be equated with blocks, payload MiB/s
or complete wallet sync duration.

## Variants

- `dalek_direct_parallel`: Direct `curve25519-dalek` call using the original
  algorithm.
- `wallet_scalar_ffi_parallel`: Current product adapter
  `fast_generate_key_derivation` under the same worker budget.

Before each time measurement, the testbench validates the byte equality of the
two paths for all points as well as the error path for an invalidly coded point.
The corpus consists of deterministically generated, valid Edwards25519 points;
Corpus construction and testing are outside of timekeeping. This simulates the
form of the transactional public keys in the wallet, but does not replace a
complete wallet sync test.

## Implementation

```sh
tools/wallet-crypto-testbench/run-derivation-benchmark.sh \
  --workers 10 --points 131072 --rounds 100 --warmup-rounds 2 --variant all
```

Each run creates a new result folder at `build/wallet-crypto-testbench/` with
build log, full environment, source checksums, raw values and `/usr/bin/time`
resource values.
