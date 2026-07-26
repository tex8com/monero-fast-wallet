#!/usr/bin/env bash
set -euo pipefail

# Build a real macOS app first, then apply the stable Developer ID signature
# before creating the disk image.  Do not let Tauri create the final DMG: its
# DMG bundle step removes the .app, which previously led to an unsigned
# ad-hoc replacement being distributed and repeated Keychain prompts.

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
desktop_dir="$(cd "${script_dir}/.." && pwd)"
target_dir="${CARGO_TARGET_DIR:-${desktop_dir}/src-tauri/target}"
app_path="${target_dir}/release/bundle/macos/Monero Fast Wallet.app"
product_version="$(node -p "require('${desktop_dir}/package.json').version")"
output_dmg="${target_dir}/release/bundle/dmg/Monero Fast Wallet_${product_version}_aarch64.dmg"

[[ "$(uname -s)" == "Darwin" ]] || { echo "Signed macOS packages require macOS." >&2; exit 1; }

"${script_dir}/build-bundle.sh" app
"${script_dir}/sign-macos-app.sh" local release

[[ -d "${app_path}" ]] || { echo "Signed app bundle is missing: ${app_path}" >&2; exit 1; }
codesign --verify --deep --strict --verbose=2 "${app_path}"

# Keep the familiar drag-to-Applications installation layout while packaging
# the already sealed app. Honor TMPDIR so release builders can keep large
# temporary bundle copies off a space-constrained system volume.
staging_root="${MONERO_DMG_STAGING_ROOT:-${TMPDIR:-/tmp}}"
mkdir -p "${staging_root}"
staging_dir="$(mktemp -d "${staging_root%/}/monero-fast-wallet-dmg.XXXXXX")"
trap 'rm -rf -- "${staging_dir}"' EXIT
ditto "${app_path}" "${staging_dir}/Monero Fast Wallet.app"
ln -s /Applications "${staging_dir}/Applications"
mkdir -p "$(dirname "${output_dmg}")"
hdiutil create -ov -volname "Monero Fast Wallet" -srcfolder "${staging_dir}" -format UDZO "${output_dmg}"

echo "Signed macOS package: ${output_dmg}"
