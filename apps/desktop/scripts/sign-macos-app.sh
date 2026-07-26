#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <development|local|production> [debug|release]" >&2
  exit 64
}

mode="${1:-}"
build_kind="${2:-debug}"
[[ "${mode}" == "development" || "${mode}" == "local" || "${mode}" == "production" ]] || usage
[[ "${build_kind}" == "debug" || "${build_kind}" == "release" ]] || usage

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
desktop_dir="$(cd "${script_dir}/.." && pwd)"
repo_dir="$(cd "${desktop_dir}/../.." && pwd)"
# Honour CARGO_TARGET_DIR so the signed bundle is the exact one produced by
# the Monero-core build. Development keeps the large native target cache on
# the external build disk; silently signing src-tauri/target would otherwise
# sign an older shell build instead.
target_dir="${CARGO_TARGET_DIR:-${desktop_dir}/src-tauri/target}"
app_path="${target_dir}/${build_kind}/bundle/macos/Monero Fast Wallet.app"

if [[ "${mode}" == "development" ]]; then
  profile_path="${repo_dir}/secrets/codesign/Monero_Fast_Wallet_Desktop_Development.provisionprofile"
  entitlements_path="${desktop_dir}/src-tauri/Entitlements.plist"
  identity="${MONERO_DESKTOP_CODESIGN_IDENTITY:-Apple Development: Roland Kohlhuber (MQFCV562XY)}"
  timestamp_args=(--timestamp=none)
else
  profile_path="${repo_dir}/secrets/codesign/Monero_Fast_Wallet_Desktop_Developer_ID.provisionprofile"
  entitlements_path="${desktop_dir}/src-tauri/Entitlements.production.plist"
  identity="${MONERO_DESKTOP_CODESIGN_IDENTITY:-Developer ID Application: Nordhain LLC (F98729Y989)}"
  if [[ "${mode}" == "production" ]]; then
    # A trusted timestamp is mandatory for a notarizable Developer ID artifact.
    timestamp_args=(--timestamp)
  else
    # Local test packages keep the same stable Developer ID identity used by
    # releases, but do not depend on the external Apple timestamp service.
    # They are intentionally not notarized; release-macos-signed.sh remains
    # the only production publication path.
    timestamp_args=(--timestamp=none)
  fi
fi

[[ -d "${app_path}" ]] || { echo "App bundle is missing: ${app_path}" >&2; exit 1; }
[[ -f "${profile_path}" ]] || { echo "Provisioning profile is missing: ${profile_path}" >&2; exit 1; }

application_identifier="$(security cms -D -i "${profile_path}" | plutil -p - | awk -F '"' '/"com.apple.application-identifier" =>/ { print $4; exit }')"
[[ "${application_identifier}" == "F98729Y989.com.tex8.monerowallet.desktop" ]] || {
  echo "Unexpected provisioning-profile application identifier: ${application_identifier}" >&2
  exit 1
}

cp "${profile_path}" "${app_path}/Contents/embedded.provisionprofile"

while IFS= read -r -d '' nested_code; do
  codesign --force --sign "${identity}" "${timestamp_args[@]}" --options runtime "${nested_code}"
done < <(find "${app_path}/Contents/Frameworks" -type f \( -name '*.dylib' -o -perm -u+x \) -print0 2>/dev/null)

# Tauri bundles our unprivileged Windows/Linux push helper in Contents/MacOS as
# well. Sign every additional executable before sealing the outer application.
while IFS= read -r -d '' nested_code; do
  [[ "${nested_code}" == "${app_path}/Contents/MacOS/monero-wallet-desktop" ]] && continue
  codesign --force --sign "${identity}" "${timestamp_args[@]}" --options runtime "${nested_code}"
done < <(find "${app_path}/Contents/MacOS" -type f -perm -u+x -print0 2>/dev/null)

codesign --force --sign "${identity}" "${timestamp_args[@]}" --options runtime \
  --entitlements "${entitlements_path}" "${app_path}/Contents/MacOS/monero-wallet-desktop"
codesign --force --sign "${identity}" "${timestamp_args[@]}" --options runtime \
  --entitlements "${entitlements_path}" "${app_path}"
codesign --verify --deep --strict --verbose=2 "${app_path}"
codesign -d --entitlements :- "${app_path}" 2>&1

echo "Signed ${app_path} for ${mode} APNs."
