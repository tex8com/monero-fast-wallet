#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
keychain_service="com.tex8.monerowallet.play-upload-key"
keychain_account="${USER}"
default_key_alias="monerowallet-upload"
required_variables=(
  MONERO_UPLOAD_STORE_FILE
  MONERO_UPLOAD_STORE_PASSWORD
  MONERO_UPLOAD_KEY_ALIAS
  MONERO_UPLOAD_KEY_PASSWORD
)

# CI, Windows, and Linux must be able to provide the upload key through their
# protected environment/secret manager. Do not silently replace a partial
# release configuration with a local macOS credential.
provided_count=0
for variable_name in "${required_variables[@]}"; do
  if [[ -n "${!variable_name:-}" ]]; then
    ((provided_count += 1))
  fi
done

if (( provided_count > 0 && provided_count < ${#required_variables[@]} )); then
  echo "Android release signing needs all MONERO_UPLOAD_* variables when any one is set." >&2
  exit 1
fi

if (( provided_count == ${#required_variables[@]} )); then
  keystore_path="${MONERO_UPLOAD_STORE_FILE}"
else
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "Missing Android release signing credentials. Set all MONERO_UPLOAD_* variables on this platform." >&2
    exit 1
  fi

  keystore_dir="${HOME}/Library/Application Support/TEX8/MoneroWallet"
  keystore_path="${keystore_dir}/monerowallet-upload.keystore"

  if [[ ! -f "${keystore_path}" ]]; then
    echo "Missing Play upload keystore: ${keystore_path}" >&2
    exit 1
  fi

  if ! upload_password="$(security find-generic-password -a "${keychain_account}" -s "${keychain_service}" -w 2>/dev/null)"; then
    echo "Missing Play upload-key password in macOS Keychain (${keychain_service})." >&2
    exit 1
  fi

  export MONERO_UPLOAD_STORE_FILE="${keystore_path}"
  export MONERO_UPLOAD_STORE_PASSWORD="${upload_password}"
  export MONERO_UPLOAD_KEY_ALIAS="${MONERO_UPLOAD_KEY_ALIAS:-${default_key_alias}}"
  export MONERO_UPLOAD_KEY_PASSWORD="${upload_password}"
fi

if [[ ! -f "${MONERO_UPLOAD_STORE_FILE}" ]]; then
  echo "Configured Play upload keystore does not exist: ${MONERO_UPLOAD_STORE_FILE}" >&2
  exit 1
fi

MONERO_WALLET_ANDROID_GRADLE_TASK="bundleRelease"
if [[ "${MONERO_WALLET_ANDROID_ARTIFACT:-bundle}" == "apk" ]]; then
  MONERO_WALLET_ANDROID_GRADLE_TASK="assembleRelease"
elif [[ "${MONERO_WALLET_ANDROID_ARTIFACT:-bundle}" != "bundle" ]]; then
  echo "MONERO_WALLET_ANDROID_ARTIFACT must be either bundle or apk." >&2
  exit 1
fi
export MONERO_WALLET_ANDROID_GRADLE_TASK

exec "${script_dir}/android-build.sh"
