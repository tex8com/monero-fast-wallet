# Shared Product Core ABI

`mfw-product-core` is the versioned, platform-neutral contract shared by the
product CLI, React Native adapters and Tauri. It owns the generated ABI
constants, deterministic event encoding, diagnostic registry/result schemas,
strict diagnostic-field allowlist and the asynchronous local telemetry writer.
The registry metadata is generated once into `packages/wallet-shared`; Mobile
and Desktop bind their bounded platform probes to those canonical IDs instead
of defining a second registry.

The renderer never receives wallet secrets. Events contain enums, bounded
numeric measurements and per-run pseudonyms only. Hot loops write to
thread-local histograms; file I/O is performed by a dedicated writer thread.

Run the complete local acceptance gate with:

```sh
bash native/product-core/scripts/run-testbench.sh
```

This regenerates all C, Rust, TypeScript, Kotlin and Swift bindings, rejects
generated drift, runs unit/clippy/C-ABI/cross-language tests, exercises the
diagnostic sanitizer and records a paired synthetic instrumentation-overhead
measurement. That last measurement is not a wallet-sync benchmark.

The product CLI packages Product-Core as a sibling dynamic library (`.dylib`
on macOS, `.so` on Linux). This avoids linking two Rust standard-library copies
into one process. Tauri links the Rust crate directly; Mobile compiles the same
generated ABI/version/hash contracts into its native and platform adapters.
