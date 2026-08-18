#!/usr/bin/env bash
# Start the real desktop wallet with Tauri hot reload while keeping every
# expensive native artifact on the external build disk. This script is for
# development only; release packaging continues through build-bundle.sh.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
desktop_dir="$(cd "${script_dir}/.." && pwd)"
build_root="${MONERO_DESKTOP_EXTERNAL_BUILD_ROOT:-/Volumes/4TB/monero-fast-wallet-build}"

if [[ ! -d "${build_root}" ]]; then
  echo "External Monero build directory is unavailable: ${build_root}" >&2
  exit 1
fi

export MONERO_DESKTOP_DEPENDS_PREFIX="${MONERO_DESKTOP_DEPENDS_PREFIX:-${build_root}/desktop-monero-deps/aarch64-apple-darwin-macos12}"
# Keep the authenticated TEX8 patch series separate from older Monero GUI
# builds. Reusing a CMake directory generated from another source checkout
# causes CMake to abort before the desktop wallet can start.
export MONERO_DESKTOP_BUILD_DIR="${MONERO_DESKTOP_BUILD_DIR:-${build_root}/desktop-monero-wallet-api-macos12-tex8-patched}"
export MONERO_DESKTOP_FAST_CRYPTO_TARGET_DIR="${MONERO_DESKTOP_FAST_CRYPTO_TARGET_DIR:-${build_root}/desktop-fast-crypto-target}"

# Sourcing creates or validates the native core, stages the dylib, and exports
# the constrained linker contract consumed by the Tauri host.
source "${script_dir}/prepare-macos-monero-core.sh"

# Tauri/Rust itself also has a sizeable incremental cache. It must live on the
# same external build disk; Vite still hot-reloads normal React changes.
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-${build_root}/desktop-tauri-target}"

cd "${desktop_dir}"
exec npm run tauri dev
