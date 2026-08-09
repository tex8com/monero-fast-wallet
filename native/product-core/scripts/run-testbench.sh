#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
core_root="$(cd "${script_dir}/.." && pwd)"
repo_root="$(cd "${core_root}/../.." && pwd)"

node "${core_root}/scripts/generate-bindings.mjs"
cargo fmt --manifest-path "${core_root}/Cargo.toml" -- --check
cargo clippy --manifest-path "${core_root}/Cargo.toml" --all-targets -- -D warnings
cargo test --manifest-path "${core_root}/Cargo.toml"
"${core_root}/scripts/run-c-abi-test.sh"
"${core_root}/scripts/run-cross-language-tests.sh"
node "${repo_root}/tools/wallet-testbench/test-product-core-abi-contract.mjs"
node "${repo_root}/tools/wallet-testbench/test-diagnostic-registry-contract.mjs"
node "${repo_root}/tools/wallet-testbench/test-app-vault-state-machine-contract.mjs"
cargo run --release --quiet --manifest-path "${core_root}/Cargo.toml" \
  --example telemetry_overhead
cargo run --release --quiet --manifest-path "${core_root}/Cargo.toml" \
  --example app_vault_switch_benchmark
