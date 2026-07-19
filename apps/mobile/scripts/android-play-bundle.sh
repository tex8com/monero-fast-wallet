#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
keychain_service="com.tex8.monerowallet.play-upload-key"
keychain_account="${USER}"
key_alias="monerowallet-upload"
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
export MONERO_UPLOAD_KEY_ALIAS="${key_alias}"
export MONERO_UPLOAD_KEY_PASSWORD="${upload_password}"
export MONERO_WALLET_ANDROID_GRADLE_TASK="bundleRelease"

exec "${script_dir}/android-build.sh"
