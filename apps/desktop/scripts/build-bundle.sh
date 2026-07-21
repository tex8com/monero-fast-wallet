#!/usr/bin/env bash
set -euo pipefail

bundle="${1:?Usage: build-bundle.sh <dmg|nsis|appimage>}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
desktop_dir="$(cd "${script_dir}/.." && pwd)"

case "${bundle}" in
  dmg)
    [[ "$(uname -s)" == "Darwin" ]] || { echo "DMG builds require macOS." >&2; exit 1; }
    ;;
  nsis)
    [[ "${OS:-}" == "Windows_NT" ]] || { echo "NSIS builds require Windows." >&2; exit 1; }
    ;;
  appimage)
    [[ "$(uname -s)" == "Linux" ]] || { echo "AppImage builds require Linux." >&2; exit 1; }
    ;;
  *)
    echo "Unsupported bundle target: ${bundle}" >&2
    exit 1
    ;;
esac

tauri_config_args=()
if [[ "${bundle}" == "nsis" ]]; then
  tauri_config_args=(--config src-tauri/tauri.windows.conf.json)
elif [[ "${bundle}" == "appimage" ]]; then
  tauri_config_args=(--config src-tauri/tauri.linux.conf.json)
fi

if [[ "${bundle}" == "dmg" ]]; then
  # This exports the native wallet link configuration and stages the Rust
  # crypto dylib where the Tauri macOS bundler expects it.
  source "${script_dir}/prepare-macos-monero-core.sh"
fi

if [[ "${bundle}" == "appimage" ]]; then
  # Produces and stages the Linux shared Rust library, then exports the full
  # static libwallet_api link graph for a real AppImage wallet build.
  source "${script_dir}/prepare-linux-monero-core.sh"
fi

for required in DESKTOP_MONERO_SOURCE_DIR DESKTOP_MONERO_WALLET_API_LIBRARY; do
  if [[ -z "${!required:-}" ]]; then
    echo "${required} must point at the pinned, built Monero wallet core for a release package." >&2
    exit 1
  fi
done

fast_crypto_extension="a"
[[ "${bundle}" == "appimage" ]] && fast_crypto_extension="so"
fast_crypto_library="${DESKTOP_MONERO_FAST_CRYPTO_LIBRARY:-${DESKTOP_MONERO_SOURCE_DIR}/external/monero-fast-crypto/target/release/libmonero_fast_crypto.${fast_crypto_extension}}"
if [[ ! -d "${DESKTOP_MONERO_SOURCE_DIR}" || ! -f "${DESKTOP_MONERO_WALLET_API_LIBRARY}" || ! -f "${fast_crypto_library}" ]]; then
  echo "The configured Monero source, libwallet_api archive, or monero-fast-crypto archive does not exist." >&2
  exit 1
fi

cd "${desktop_dir}"
npm ci
export DESKTOP_REQUIRE_MONERO=1
export DESKTOP_MONERO_FAST_CRYPTO_LIBRARY="${fast_crypto_library}"
# Ship the unprivileged Linux notification agent alongside the desktop host.
# It is harmless on non-Linux targets and lets the app install a per-user
# service only after the user explicitly enables Fast Wallet signals.
cargo build --manifest-path src-tauri/Cargo.toml --release --bin monero-fast-walletd
tauri_build_args=(--bundles "${bundle}")
if (( ${#tauri_config_args[@]} > 0 )); then
  tauri_build_args+=("${tauri_config_args[@]}")
fi
npm run tauri build -- "${tauri_build_args[@]}"
