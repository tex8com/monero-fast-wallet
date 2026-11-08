#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
lockfile="${repo_root}/wallets/desktop/src-tauri/Cargo.lock"
audit_json="$(mktemp)"
audit_stderr="$(mktemp)"
source_snapshot="$(mktemp)"
trap 'rm -f "${audit_json}" "${audit_stderr}" "${source_snapshot}"' EXIT

command -v python3 >/dev/null || { echo "python3 is required for the desktop security gate" >&2; exit 2; }
python3 "${script_dir}/verify-security-source-pins.py" --write-snapshot "${source_snapshot}"

# An unavailable registry/index is an incomplete check, not a reason to disable
# yanked-package checks. No vulnerability is ignored by this gate.
audit_command=(cargo audit --file "${lockfile}" --json)
if [[ "${CARGO_AUDIT_NO_FETCH:-0}" == "1" ]]; then
  audit_command+=(--no-fetch)
fi
if "${audit_command[@]}" >"${audit_json}" 2>"${audit_stderr}"; then
  audit_exit=0
else
  audit_exit=$?
fi
cat "${audit_stderr}" >&2
if [[ ${audit_exit} -ne 0 ]]; then
  echo "Desktop cargo-audit failed or could not complete (exit ${audit_exit})." >&2
  exit 1
fi
if grep -Eiq '^(error:|warning:.*(could not|couldn.t|failed|unable))' "${audit_stderr}"; then
  echo "Desktop cargo-audit reported an incomplete check." >&2
  exit 1
fi

# Recheck pins and dependency inputs after the audit, so a concurrent change
# cannot inherit an earlier result.
python3 "${script_dir}/verify-security-source-pins.py" \
  --audit-json "${audit_json}" --snapshot "${source_snapshot}"
