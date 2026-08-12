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

## Hosted Fast Wallet watches

`mfw_fast_wallet_hosting_plan_compute_v1` is a pure, crash-safe planning ABI
for hosted receive watches. It accepts only lifecycle enums and booleans; it
cannot receive a wallet address, Worker descriptor/root, assignment handle,
installation capability, View Key or envelope.

For enrolment it returns exactly one durable next action:

`pending local → Gateway assignment → delivery enabled → seal watch → Relay accepted → active`.

`worker_enrolled` becomes true only at the final, durably committed stage.
Revocation is likewise ordered: delete the remote assignment first, then clear
the local assignment state. It intentionally never disables installation-wide
delivery, because another Fast Wallet may still use that installation.

The planner does not implement a network client and does not attest a Gateway
response. Each platform's secure storage and authorized transport adapter must
prove the corresponding input predicate before executing its returned action.
