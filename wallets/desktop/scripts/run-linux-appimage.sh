#!/usr/bin/env bash
# Launch the just-built Linux release in the logged-in desktop session.
# Kept as a script so the AppImage path (which contains spaces) never has to
# be reconstructed by a remote-shell caller.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
desktop_dir="$(cd "${script_dir}/.." && pwd)"
appimage_dir="${MONERO_LINUX_APPIMAGE_DIR:-${desktop_dir}/src-tauri/target/release/bundle/appimage}"
appimage="$(find "${appimage_dir}" -maxdepth 1 -type f -name '*.AppImage' -print -quit)"

[[ -n "${appimage}" ]] || {
  echo "No Linux AppImage exists in ${appimage_dir}" >&2
  exit 1
}

chmod u+x "${appimage}"
if [[ -n "${MONERO_LINUX_APP_LOG:-}" ]]; then
  mkdir -p "$(dirname "${MONERO_LINUX_APP_LOG}")"
  exec >>"${MONERO_LINUX_APP_LOG}" 2>&1
fi
exec "${appimage}" --appimage-extract-and-run
