#!/usr/bin/env bash
set -euo pipefail

# A raw `tauri dev` executable is linker/ad-hoc signed. macOS intentionally
# treats every rebuild as different code, so it cannot be used for Keychain
# acceptance testing. Build a real .app, apply the stable project Developer ID
# identity and provisioning profile, then run that exact signed executable.

[[ "$(uname -s)" == "Darwin" ]] || {
  echo "The signed desktop development runner requires macOS." >&2
  exit 1
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
desktop_dir="$(cd "${script_dir}/.." && pwd)"
build_root="${MONERO_DESKTOP_EXTERNAL_BUILD_ROOT:-/Volumes/4TB/CACHE/monero-fast-wallet-build}"

[[ -d "${build_root}" ]] || {
  echo "External Monero build directory is unavailable: ${build_root}" >&2
  exit 1
}

export MONERO_DESKTOP_DEPENDS_PREFIX="${MONERO_DESKTOP_DEPENDS_PREFIX:-${build_root}/desktop-monero-deps/aarch64-apple-darwin-macos12}"
export MONERO_DESKTOP_FAST_CRYPTO_TARGET_DIR="${MONERO_DESKTOP_FAST_CRYPTO_TARGET_DIR:-${build_root}/desktop-fast-crypto-target}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-${build_root}/desktop-tauri-target}"

source "${script_dir}/prepare-macos-monero-core.sh"

cd "${desktop_dir}"
npm ci
npm run tauri build -- --debug --bundles app

source_app_path="${CARGO_TARGET_DIR}/debug/bundle/macos/Monero Fast Wallet.app"
[[ -d "${source_app_path}" ]] || {
  echo "Built desktop application is missing: ${source_app_path}" >&2
  exit 1
}

# The Cargo target is shared so native dependencies do not have to be rebuilt
# for every test run. Another build can nevertheless replace its .app after it
# has been signed. Sign and launch a private runtime copy so the code identity
# macOS evaluates can no longer change underneath the running process.
runtime_dir="$(mktemp -d "${TMPDIR:-/tmp}/mfw-signed-runtime.XXXXXX")"
app_path="${runtime_dir}/Monero Fast Wallet.app"
cleanup_runtime_bundle() {
  rm -rf "${runtime_dir}"
}
trap cleanup_runtime_bundle EXIT
ditto "${source_app_path}" "${app_path}"

# Use the project Developer ID material in an isolated, temporary build
# Keychain. This gives the development app the same stable application identity
# as the release without requiring any certificate or Keychain action from an
# end user (or from a developer's login Keychain).
MONERO_DESKTOP_APP_PATH="${app_path}" "${script_dir}/sign-macos-app.sh" local debug

binary_path="${app_path}/Contents/MacOS/monero-wallet-desktop"
[[ -x "${binary_path}" ]] || {
  echo "Signed desktop executable is missing: ${binary_path}" >&2
  exit 1
}

echo "Starting the signed development app: ${app_path}"
"${binary_path}"
