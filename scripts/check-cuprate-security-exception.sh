#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
manifest="${repo_root}/node/mfn-monero-fast-node/Cargo.toml"
lockfile="${repo_root}/node/mfn-monero-fast-node/Cargo.lock"
exception_id="RUSTSEC-2023-0071"
expires_on="2026-10-24"
today="${SECURITY_EXCEPTION_DATE_OVERRIDE:-$(date -u +%F)}"
audit_json="$(mktemp)"
audit_stderr="$(mktemp)"
trap 'rm -f "${audit_json}" "${audit_stderr}"' EXIT

if [[ ! "${today}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  echo "invalid security exception date: ${today}" >&2
  exit 2
fi
if [[ "${today}" > "${expires_on}" || "${today}" == "${expires_on}" ]]; then
  echo "${exception_id} exception expired on ${expires_on}" >&2
  exit 1
fi

dependency_tree="$(cargo tree \
  --locked \
  --manifest-path "${manifest}" \
  --edges normal \
  --invert rsa \
  --prefix none)"

if ! rg -q '^rsa v0\.9\.10$' <<<"${dependency_tree}"; then
  echo "${exception_id} dependency version changed; reassessment required" >&2
  exit 1
fi
if ! rg -q '^arti-client v0\.44\.0$' <<<"${dependency_tree}" \
  || ! rg -q '^tor-key-forge v0\.44\.0$' <<<"${dependency_tree}" \
  || ! rg -q '^ssh-key-fork-arti v0\.6\.7$' <<<"${dependency_tree}"; then
  echo "${exception_id} dependency route changed; reassessment required" >&2
  exit 1
fi

if rg -n \
  --glob '*.rs' \
  --glob '!target/**' \
  'rsa::(KeyPair|RsaPrivateKey)|RsaPrivateKey|KeyPair::generate' \
  "${repo_root}/node/mfn-monero-fast-node" >/dev/null; then
  echo "${exception_id} private RSA use appeared in Cuprate workspace code" >&2
  exit 1
fi

command -v jq >/dev/null || {
  echo "jq is required to validate the exact cargo-audit warning set" >&2
  exit 2
}

audit_command=(
  cargo audit
  --file "${lockfile}"
  --ignore "${exception_id}"
  --no-yanked
  --json
)
if [[ "${CARGO_AUDIT_NO_FETCH:-0}" == "1" ]]; then
  audit_command+=(--no-fetch)
fi

if ! "${audit_command[@]}" >"${audit_json}" 2>"${audit_stderr}"; then
  cat "${audit_stderr}" >&2
  exit 1
fi
cat "${audit_stderr}" >&2
if rg -q '^error:' "${audit_stderr}"; then
  echo "cargo-audit could not complete every Cuprate check" >&2
  exit 1
fi

if [[ "$(jq '.vulnerabilities.found' "${audit_json}")" != "false" ]]; then
  echo "unexpected non-exempt Cuprate vulnerability found" >&2
  exit 1
fi

expected_warnings="$(
  printf '%s\n' \
    'RUSTSEC-2024-0436:paste@1.0.15' \
    'RUSTSEC-2025-0141:bincode@2.0.1' \
    | sort
)"
actual_warnings="$(
  jq -r '
    .warnings[]?[]?
    | ((.advisory.id // "YANKED") + ":" + .package.name + "@" + .package.version)
  ' "${audit_json}" | sort
)"

if [[ "${actual_warnings}" != "${expected_warnings}" ]]; then
  echo "Cuprate cargo-audit warning set changed; reassessment required" >&2
  diff -u <(printf '%s\n' "${expected_warnings}") <(printf '%s\n' "${actual_warnings}") || true
  exit 1
fi

echo "Cuprate audit passed with one time-boxed vulnerability exception and two tracked informational warnings."
