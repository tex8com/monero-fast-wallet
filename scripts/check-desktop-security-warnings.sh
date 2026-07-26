#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
lockfile="${repo_root}/apps/desktop/src-tauri/Cargo.lock"
expires_on="2026-10-24"
today="${SECURITY_EXCEPTION_DATE_OVERRIDE:-$(date -u +%F)}"
audit_json="$(mktemp)"
audit_stderr="$(mktemp)"
trap 'rm -f "${audit_json}" "${audit_stderr}"' EXIT

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

audit_fetch_args=()
if [[ "${CARGO_AUDIT_NO_FETCH:-0}" == "1" ]]; then
  audit_fetch_args+=(--no-fetch)
fi

if ! cargo audit \
  "${audit_fetch_args[@]}" \
  --file "${lockfile}" \
  --json >"${audit_json}" 2>"${audit_stderr}"; then
  cat "${audit_stderr}" >&2
  exit 1
fi
cat "${audit_stderr}" >&2
if rg -q '^error:' "${audit_stderr}"; then
  echo "cargo-audit could not complete every desktop check" >&2
  exit 1
fi

if [[ "$(jq '.vulnerabilities.found' "${audit_json}")" != "false" ]]; then
  echo "desktop Rust vulnerability found" >&2
  exit 1
fi

expected_warnings="$(
  printf '%s\n' \
    'RUSTSEC-2024-0370:proc-macro-error@1.0.4' \
    'RUSTSEC-2024-0411:gdkwayland-sys@0.18.2' \
    'RUSTSEC-2024-0412:gdk@0.18.2' \
    'RUSTSEC-2024-0413:atk@0.18.2' \
    'RUSTSEC-2024-0414:gdkx11-sys@0.18.2' \
    'RUSTSEC-2024-0415:gtk@0.18.2' \
    'RUSTSEC-2024-0416:atk-sys@0.18.2' \
    'RUSTSEC-2024-0417:gdkx11@0.18.2' \
    'RUSTSEC-2024-0418:gdk-sys@0.18.2' \
    'RUSTSEC-2024-0419:gtk3-macros@0.18.2' \
    'RUSTSEC-2024-0420:gtk-sys@0.18.2' \
    'RUSTSEC-2024-0429:glib@0.18.5' \
    'RUSTSEC-2025-0075:unic-char-range@0.9.0' \
    'RUSTSEC-2025-0080:unic-common@0.9.0' \
    'RUSTSEC-2025-0081:unic-char-property@0.9.0' \
    'RUSTSEC-2025-0098:unic-ucd-version@0.9.0' \
    'RUSTSEC-2025-0100:unic-ucd-ident@0.9.0' \
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

echo "Desktop Rust audit passed with 17 exact, time-boxed transitive maintenance warnings."
