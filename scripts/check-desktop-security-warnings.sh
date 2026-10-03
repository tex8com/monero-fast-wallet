#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
lockfile="${repo_root}/wallets/desktop/src-tauri/Cargo.lock"
expires_on="2026-11-01"
unpatched_exception_id="RUSTSEC-2023-0071"
unpatched_exception_package="rsa@0.9.10"
today="${SECURITY_EXCEPTION_DATE_OVERRIDE:-$(date -u +%F)}"
audit_json="$(mktemp)"
raw_audit_json="$(mktemp)"
audit_stderr="$(mktemp)"
trap 'rm -f "${audit_json}" "${raw_audit_json}" "${audit_stderr}"' EXIT

if [[ ! "${today}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  echo "invalid security warning date: ${today}" >&2
  exit 2
fi
if [[ "${today}" > "${expires_on}" || "${today}" == "${expires_on}" ]]; then
  echo "desktop transitive-warning exception expired on ${expires_on}" >&2
  exit 1
fi

command -v jq >/dev/null || {
  echo "jq is required to validate the exact cargo-audit warning set" >&2
  exit 2
}

# The sparse local crates.io mirror does not retain every historical yanked
# marker. Advisories remain checked below; yanked-state availability is not a
# security finding and must not make this reproducible policy flaky.
audit_command=(cargo audit --file "${lockfile}" --no-yanked --json)
if [[ "${CARGO_AUDIT_NO_FETCH:-0}" == "1" ]]; then
  audit_command+=(--no-fetch)
fi

if "${audit_command[@]}" >"${raw_audit_json}" 2>"${audit_stderr}"; then
  raw_audit_exit=0
else
  raw_audit_exit=$?
fi
if [[ ${raw_audit_exit} -gt 1 ]] || ! jq empty "${raw_audit_json}" >/dev/null 2>&1; then
  cat "${audit_stderr}" >&2
  exit 1
fi
cat "${audit_stderr}" >&2
if rg -q '^error:' "${audit_stderr}"; then
  echo "cargo-audit could not complete every desktop check" >&2
  exit 1
fi

expected_vulnerabilities="${unpatched_exception_id}:${unpatched_exception_package}"
actual_vulnerabilities="$(jq -r '.vulnerabilities.list[]? | (.advisory.id + ":" + .package.name + "@" + .package.version)' "${raw_audit_json}" | sort)"
if [[ "${actual_vulnerabilities}" != "${expected_vulnerabilities}" ]]; then
  echo "desktop Rust vulnerability set changed; reassessment required" >&2
  diff -u <(printf '%s\n' "${expected_vulnerabilities}") <(printf '%s\n' "${actual_vulnerabilities}") || true
  exit 1
fi

# rsa has no upstream fix. It is pulled only by Arti's local SSH-key parsing,
# not by wallet transaction or TLS code. Keep the temporary exception exact,
# visible, and automatically expiring rather than hiding all audit findings.
audit_command+=(--ignore "${unpatched_exception_id}")
if ! "${audit_command[@]}" >"${audit_json}" 2>"${audit_stderr}"; then
  cat "${audit_stderr}" >&2
  exit 1
fi
if [[ "$(jq '.vulnerabilities.found' "${audit_json}")" != "false" ]]; then
  echo "desktop Rust vulnerability found" >&2
  exit 1
fi

expected_warnings="$(
  printf '%s\n' \
    'RUSTSEC-2024-0370:proc-macro-error@1.0.4' \
    'RUSTSEC-2024-0429:glib@0.18.5' \
    'RUSTSEC-2024-0388:derivative@2.2.0' \
    'RUSTSEC-2024-0436:paste@1.0.15' \
    'RUSTSEC-2025-0141:bincode@2.0.1' \
    'RUSTSEC-2026-0319:anymap2@0.13.0' \
    | sort
)"
actual_warnings="$(
  jq -r '
    .warnings[]?[]?
    | ((.advisory.id // "YANKED") + ":" + .package.name + "@" + .package.version)
  ' "${audit_json}" | sort
)"

if [[ "${actual_warnings}" != "${expected_warnings}" ]]; then
  echo "desktop cargo-audit warning set changed; reassessment required" >&2
  diff -u <(printf '%s\n' "${expected_warnings}") <(printf '%s\n' "${actual_warnings}") || true
  exit 1
fi

echo "Desktop Rust audit passed with 6 exact transitive warnings and one time-boxed, upstream-unpatched Arti exception."
