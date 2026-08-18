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
if [[ -n "${CARGO_TARGET_DIR:-}" ]]; then
  target_dir="${CARGO_TARGET_DIR}"
else
  # Cargo can redirect its target through .cargo/config.toml without exporting
  # CARGO_TARGET_DIR. Resolve the effective directory instead of signing a
  # stale bundle from src-tauri/target.
  target_dir="$(
    cargo metadata \
      --manifest-path "${desktop_dir}/src-tauri/Cargo.toml" \
      --no-deps \
      --format-version 1 \
      | node -e 'let input=""; process.stdin.on("data", chunk => input += chunk); process.stdin.on("end", () => process.stdout.write(JSON.parse(input).target_directory));'
  )"
fi
app_path="${MONERO_DESKTOP_APP_PATH:-${target_dir}/${build_kind}/bundle/macos/Monero Fast Wallet.app}"
codesign_keychain_args=()
temporary_signing_dir=""
temporary_signing_keychain=""
temporary_certificate_pem=""
temporary_identity_p12=""
original_default_keychain=""
original_user_keychains=()

cleanup_temporary_signing_keychain() {
  if [[ -z "${temporary_signing_keychain}" ]]; then
    return
  fi
  if [[ ${#original_user_keychains[@]} -gt 0 ]]; then
    security list-keychains -d user -s "${original_user_keychains[@]}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${original_default_keychain}" ]]; then
    security default-keychain -d user -s "${original_default_keychain}" >/dev/null 2>&1 || true
  fi
  security delete-keychain "${temporary_signing_keychain}" >/dev/null 2>&1 || true
  # These are exact files inside a directory created by mktemp above. Remove
  # the generated PKCS#12 promptly because it contains the imported key.
  rm -f "${temporary_certificate_pem}" "${temporary_identity_p12}" "${temporary_signing_keychain}"
  rmdir "${temporary_signing_dir}" >/dev/null 2>&1 || true
}

trap cleanup_temporary_signing_keychain EXIT

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

prepare_temporary_developer_id_keychain() {
  local certificate_path="${repo_dir}/secrets/codesign/developer-id-application.cer"
  local private_key_path="${repo_dir}/secrets/codesign/developer-id-application.key"
  local keychain_password
  local p12_password
  local listed_keychain

  # Prefer a complete Developer ID identity that is already installed in the
  # user's Keychain. Re-exporting the same certificate and private key into a
  # generated PKCS#12 file is unnecessary on a configured build Mac and can
  # fail when the checked-in key uses an OpenSSL format that `security import`
  # does not accept. CI and clean build machines still use the isolated
  # temporary Keychain path below.
  if security find-identity -v -p codesigning 2>/dev/null \
    | grep -F "${identity}" >/dev/null; then
    codesign_keychain_args=(--keychain "${HOME}/Library/Keychains/login.keychain-db")
    return 0
  fi

  [[ -f "${certificate_path}" && -f "${private_key_path}" ]] || return 0
  command -v openssl >/dev/null || {
    echo "OpenSSL is required for isolated Developer ID signing." >&2
    exit 1
  }

  while IFS= read -r listed_keychain; do
    listed_keychain="${listed_keychain#"${listed_keychain%%[![:space:]]*}"}"
    listed_keychain="${listed_keychain#\"}"
    listed_keychain="${listed_keychain%\"}"
    [[ -n "${listed_keychain}" ]] && original_user_keychains+=("${listed_keychain}")
  done < <(security list-keychains -d user)
  original_default_keychain="$(security default-keychain -d user | tr -d '"' | sed 's/^[[:space:]]*//')"

  temporary_signing_dir="$(mktemp -d "${TMPDIR:-/tmp}/mfw-signing-keychain.XXXXXX")"
  temporary_signing_keychain="${temporary_signing_dir}/mfw-signing.keychain-db"
  temporary_certificate_pem="${temporary_signing_dir}/developer-id-application.pem"
  temporary_identity_p12="${temporary_signing_dir}/developer-id-application.p12"
  keychain_password="$(openssl rand -hex 32)"
  p12_password="$(openssl rand -hex 32)"

  openssl x509 -inform DER -in "${certificate_path}" -out "${temporary_certificate_pem}"
  openssl pkcs12 -export \
    -inkey "${private_key_path}" \
    -in "${temporary_certificate_pem}" \
    -name "${identity}" \
    -passout "pass:${p12_password}" \
    -out "${temporary_identity_p12}"

  security create-keychain -p "${keychain_password}" "${temporary_signing_keychain}"
  security set-keychain-settings -lut 21600 "${temporary_signing_keychain}"
  security unlock-keychain -p "${keychain_password}" "${temporary_signing_keychain}"
  security import "${temporary_identity_p12}" \
    -k "${temporary_signing_keychain}" \
    -P "${p12_password}" \
    -A >/dev/null
  security set-key-partition-list \
    -S apple-tool:,apple:,codesign: \
    -s \
    -k "${keychain_password}" \
    "${temporary_signing_keychain}" >/dev/null

  # `codesign --keychain` restricts identity lookup, but the Security framework
  # also requires that temporary Keychain to be in the user search list while
  # the private-key operation runs. Both preferences are restored by the trap.
  security list-keychains -d user -s \
    "${temporary_signing_keychain}" \
    "${original_user_keychains[@]}"
  security default-keychain -d user -s "${temporary_signing_keychain}"
  security find-identity -v -p codesigning "${temporary_signing_keychain}" | grep -F "${identity}" >/dev/null || {
    echo "The isolated Developer ID signing identity could not be prepared." >&2
    exit 1
  }
  codesign_keychain_args=(--keychain "${temporary_signing_keychain}")
}

if [[ "${mode}" != "development" ]]; then
  prepare_temporary_developer_id_keychain
fi

[[ -d "${app_path}" ]] || { echo "App bundle is missing: ${app_path}" >&2; exit 1; }
[[ "$(basename "${app_path}")" == "Monero Fast Wallet.app" ]] || {
  echo "The signed bundle must retain the canonical app name: ${app_path}" >&2
  exit 1
}
main_binary="${app_path}/Contents/MacOS/monero-wallet-desktop"
[[ -x "${main_binary}" ]] || {
  echo "The desktop executable is missing: ${main_binary}" >&2
  exit 1
}
command -v c++filt >/dev/null || {
  echo "c++filt is required to verify the native Monero wallet engine." >&2
  exit 1
}
# Never bless or launch the renderer-only development shell as a real wallet.
# A correctly linked binary contains the pinned libwallet_api implementation;
# the shell bridge deliberately contains no Monero::WalletManagerFactory.
if ! nm "${main_binary}" 2>/dev/null \
  | c++filt \
  | grep -F 'Monero::WalletManagerFactory::getWalletManager()' >/dev/null; then
  echo "Refusing to sign an app without the native Monero wallet engine: ${main_binary}" >&2
  echo "Build through scripts/prepare-macos-monero-core.sh or run npm run dev:wallet." >&2
  exit 1
fi
[[ -f "${profile_path}" ]] || { echo "Provisioning profile is missing: ${profile_path}" >&2; exit 1; }

application_identifier="$(security cms -D -i "${profile_path}" | plutil -p - | awk -F '"' '/"com.apple.application-identifier" =>/ { print $4; exit }')"
[[ "${application_identifier}" == "F98729Y989.com.tex8.monerowallet.desktop" ]] || {
  echo "Unexpected provisioning-profile application identifier: ${application_identifier}" >&2
  exit 1
}
profile_keychain_group="$(security cms -D -i "${profile_path}" | plutil -extract 'Entitlements.keychain-access-groups.0' raw -o - -)"
[[ "${profile_keychain_group}" == "F98729Y989.*" ]] || {
  echo "Unexpected provisioning-profile Keychain group: ${profile_keychain_group}" >&2
  exit 1
}
[[ "$(/usr/libexec/PlistBuddy -c 'Print :com.apple.application-identifier' "${entitlements_path}")" == "F98729Y989.com.tex8.monerowallet.desktop" ]] || {
  echo "The app entitlement does not match the provisioning profile." >&2
  exit 1
}
[[ "$(/usr/libexec/PlistBuddy -c 'Print :com.apple.developer.team-identifier' "${entitlements_path}")" == "F98729Y989" ]] || {
  echo "The app Team ID entitlement is missing or invalid." >&2
  exit 1
}
[[ "$(/usr/libexec/PlistBuddy -c 'Print :keychain-access-groups:0' "${entitlements_path}")" == "F98729Y989.com.tex8.monerowallet.desktop" ]] || {
  echo "The app Keychain access group is missing or invalid." >&2
  exit 1
}

cp "${profile_path}" "${app_path}/Contents/embedded.provisionprofile"

while IFS= read -r -d '' nested_code; do
  codesign --force "${codesign_keychain_args[@]}" --sign "${identity}" "${timestamp_args[@]}" --options runtime "${nested_code}"
done < <(find "${app_path}/Contents/Frameworks" -type f \( -name '*.dylib' -o -perm -u+x \) -print0 2>/dev/null)

# Tauri bundles our unprivileged Windows/Linux push helper in Contents/MacOS as
# well. Sign every additional executable before sealing the outer application.
while IFS= read -r -d '' nested_code; do
  [[ "${nested_code}" == "${main_binary}" ]] && continue
  codesign --force "${codesign_keychain_args[@]}" --sign "${identity}" "${timestamp_args[@]}" --options runtime "${nested_code}"
done < <(find "${app_path}/Contents/MacOS" -type f -perm -u+x -print0 2>/dev/null)

codesign --force "${codesign_keychain_args[@]}" --sign "${identity}" "${timestamp_args[@]}" --options runtime \
  --entitlements "${entitlements_path}" "${main_binary}"
codesign --force "${codesign_keychain_args[@]}" --sign "${identity}" "${timestamp_args[@]}" --options runtime \
  --entitlements "${entitlements_path}" "${app_path}"
codesign --verify --deep --strict --verbose=2 "${app_path}"
signed_team_identifier="$(codesign -dv --verbose=4 "${app_path}" 2>&1 | awk -F= '/^TeamIdentifier=/ { print $2; exit }')"
[[ "${signed_team_identifier}" == "F98729Y989" ]] || {
  echo "The signed application has no trusted TEX8 Team ID." >&2
  exit 1
}
verify_keychain_entitlements() {
  local signed_code="$1"
  local signed_entitlements
  local signed_application_identifier
  local signed_keychain_group

  signed_entitlements="$(codesign -d --entitlements :- "${signed_code}" 2>/dev/null)"
  signed_application_identifier="$(plutil -extract 'com\.apple\.application-identifier' raw -o - - <<<"${signed_entitlements}")"
  signed_keychain_group="$(plutil -extract 'keychain-access-groups.0' raw -o - - <<<"${signed_entitlements}")"
  [[ "${signed_application_identifier}" == "F98729Y989.com.tex8.monerowallet.desktop" ]] || {
    echo "The signed code is missing its Keychain application identity: ${signed_code}" >&2
    exit 1
  }
  [[ "${signed_keychain_group}" == "F98729Y989.com.tex8.monerowallet.desktop" ]] || {
    echo "The signed code is missing its Keychain access group: ${signed_code}" >&2
    exit 1
  }
}

verify_keychain_entitlements "${main_binary}"
verify_keychain_entitlements "${app_path}"
codesign -d --entitlements :- "${app_path}" 2>&1

echo "Signed ${app_path} for ${mode} APNs."
