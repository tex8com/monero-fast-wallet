#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../../.." && pwd)"
cargo test --locked --manifest-path "${repo_root}/wallets/tui/Cargo.toml" --no-fail-fast
printf '%s\n' 'PASS tui_unit'
