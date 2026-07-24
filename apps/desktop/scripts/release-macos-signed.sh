#!/usr/bin/env bash
set -euo pipefail

# Build the real native-core DMG, sign the exact bundle with the Developer ID
# certificate, then notarize and staple the DMG. This script deliberately
# fails closed when the local signing/notary credentials are absent; it never
# falls back to Tauri's ad-hoc developer signature.

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
desktop_dir="$(cd "${script_dir}/.." && pwd)"
target_dir="${CARGO_TARGET_DIR:-${desktop_dir}/src-tauri/target}"
app_path="${target_dir}/release/bundle/macos/Monero Fast Wallet.app"
notary_profile="${MONERO_DESKTOP_NOTARY_PROFILE:-monero-fast-wallet-notary}"
product_version="$(node -p "require('${desktop_dir}/package.json').version")"
output_dmg="${target_dir}/release/bundle/macos/Monero Fast Wallet_${product_version}_aarch64.dmg"

[[ "$(uname -s)" == "Darwin" ]] || { echo "Signed macOS releases require macOS." >&2; exit 1; }

security find-identity -v -p codesigning | grep -F 'Developer ID Application:' >/dev/null || {
  echo "Missing a valid Developer ID Application signing identity in the login keychain." >&2
  exit 1
}

# Validates the keychain profile without exposing its token or private key.
xcrun notarytool history --keychain-profile "${notary_profile}" >/dev/null

"${script_dir}/build-bundle.sh" dmg
"${script_dir}/sign-macos-app.sh" production release

[[ -d "${app_path}" ]] || { echo "Signed app bundle is missing: ${app_path}" >&2; exit 1; }
codesign --verify --deep --strict --verbose=2 "${app_path}"

# Create a fresh image only after the signed application has been sealed.
rm -f "${output_dmg}"
hdiutil create -volname "Monero Fast Wallet" -srcfolder "${app_path}" -format UDZO -ov "${output_dmg}"
xcrun notarytool submit "${output_dmg}" --keychain-profile "${notary_profile}" --wait
xcrun stapler staple "${app_path}"
xcrun stapler staple "${output_dmg}"
spctl --assess --type execute --verbose=4 "${app_path}"
spctl --assess --type open --context context:primary-signature --verbose=4 "${output_dmg}"
shasum -a 256 "${output_dmg}"

echo "Signed, notarized macOS release: ${output_dmg}"
