#!/usr/bin/env bash
# Source this file before an Android release build. It obtains the local Play
# upload-key credentials without printing them and never writes them to disk.

set -euo pipefail

keychain_service="com.tex8.monerowallet.play-upload-key"
keychain_account="${USER}"
default_key_alias="monerowallet-upload"
required_variables=(
  MONERO_UPLOAD_STORE_FILE
  MONERO_UPLOAD_STORE_PASSWORD
  MONERO_UPLOAD_KEY_ALIAS
  MONERO_UPLOAD_KEY_PASSWORD
)

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
  :
elif [[ "$(uname -s)" == "Darwin" ]]; then
  keystore_path="${HOME}/Library/Application Support/TEX8/MoneroWallet/monerowallet-upload.keystore"
  [[ -f "${keystore_path}" ]] || {
    echo "Missing Play upload keystore: ${keystore_path}" >&2
    exit 1
  }
  if ! upload_password="$(security find-generic-password -a "${keychain_account}" -s "${keychain_service}" -w 2>/dev/null)"; then
    echo "Missing Play upload-key password in macOS Keychain (${keychain_service})." >&2
    exit 1
  fi
  export MONERO_UPLOAD_STORE_FILE="${keystore_path}"
  export MONERO_UPLOAD_STORE_PASSWORD="${upload_password}"
  export MONERO_UPLOAD_KEY_ALIAS="${MONERO_UPLOAD_KEY_ALIAS:-${default_key_alias}}"
  export MONERO_UPLOAD_KEY_PASSWORD="${upload_password}"
else
  echo "Missing Android release signing credentials. Set all MONERO_UPLOAD_* variables." >&2
  exit 1
fi

[[ -f "${MONERO_UPLOAD_STORE_FILE}" ]] || {
  echo "Configured Play upload keystore does not exist: ${MONERO_UPLOAD_STORE_FILE}" >&2
  exit 1
}
