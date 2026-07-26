# Historic Monero-Ref10 testbench

This testbench only measures the historical implementation of
`crypto_ops::generate_key_derivation` as it looked immediately before the
fast-crypto commit `e0a84c6e8`:

```text
ge_frombytes_vartime → ge_scalarmult → ge_mul8 → ge_tobytes
```

It uses only `MWMTV1` vectors of the Rust testbench: a deterministic public
canonical scalar, public points and the expected Dalek output. Before the timer,
it checks each point byte by byte against Dalek and verifies that an invalid
point is discarded.

Example of a serial original reference:

```sh
WALLET_ORIGINAL_REF10_WORKERS=1 \
WALLET_ORIGINAL_REF10_RUN_ID=original-ref10-serial-r1-mac-m4-YYYYMMDD-001 \
bash tools/wallet-original-crypto-testbench/run-original-ref10-benchmark.sh
```

`workers=10` measures the same historical core with a deliberately external,
persistent benchmark parallelisation. This is not a claim that the historical
wallet had this level of parallelization; the serial measurement remains the
behavioral reference of the original function.
