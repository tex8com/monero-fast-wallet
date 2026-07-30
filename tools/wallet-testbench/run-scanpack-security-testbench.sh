#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

run_gate() {
  local name="$1"
  shift
  printf 'gate: %s\n' "${name}"
  "$@"
  printf 'ok - %s\n' "${name}"
}

run_gate \
  "signed ScanPack format, atomic commit and unsafe-file rejection" \
  cargo test --locked --manifest-path "${repo_root}/native/scanpack-format/Cargo.toml"

run_gate \
  "read-only ScanPack generation, freshness and manipulation contract" \
  cargo test --locked --manifest-path "${repo_root}/services/notify-scanner/Cargo.toml" \
  scanpack::tests:: --lib

run_gate \
  "cursor gap, source-failure and reorg convergence contract" \
  cargo test --locked --manifest-path "${repo_root}/services/notify-scanner/Cargo.toml" \
  scanner::tests:: --lib

run_gate \
  "Cuprate writer append, reorg and crash-window contract" \
  cargo test --locked --manifest-path "${repo_root}/node/cuprate/Cargo.toml" \
  -p cuprated scanpack_writer::tests:: --no-default-features

printf '%s\n' "ScanPack security testbench passed."
