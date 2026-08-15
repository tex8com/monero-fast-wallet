#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"

if [[ "$(cargo audit --version)" != "cargo-audit-audit 0.22.2" ]]; then
  echo "cargo-audit 0.22.2 is required for reproducible policy output" >&2
  exit 2
fi

clean_lockfiles=(
  "${repo_root}/services/enthusiast-discovery/Cargo.lock"
  "${repo_root}/services/monero-news/Cargo.lock"
  "${repo_root}/services/notification-gateway/Cargo.lock"
  "${repo_root}/services/notification-registration-adapter/Cargo.lock"
  "${repo_root}/services/notify-scanner/Cargo.lock"
)

audit_output="$(mktemp)"
trap 'rm -f "${audit_output}"' EXIT

run_clean_audit() {
  if ! cargo audit "$@" >"${audit_output}" 2>&1; then
    cat "${audit_output}" >&2
    return 1
  fi
  cat "${audit_output}"
  if rg -q '^error:' "${audit_output}"; then
    echo "cargo-audit could not complete every lockfile check" >&2
    return 1
  fi
}

run_clean_audit --file "${clean_lockfiles[0]}" --deny warnings
for lockfile in "${clean_lockfiles[@]:1}"; do
  run_clean_audit --no-fetch --file "${lockfile}" --deny warnings
done

CARGO_AUDIT_NO_FETCH=1 "${script_dir}/check-desktop-security-warnings.sh"
CARGO_AUDIT_NO_FETCH=1 "${script_dir}/check-cuprate-security-exception.sh"

echo "All Rust lockfile security policies passed."
