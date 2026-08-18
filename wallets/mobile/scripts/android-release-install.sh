#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${script_dir}/android-release-signing.sh"

# Fail before expensive native compilation when the product-only Firebase
# configuration is absent or belongs to another application.
firebase_config="${script_dir}/../android/app/google-services.json"
if ! node - "${firebase_config}" <<'NODE'
const fs = require("fs");
const configPath = process.argv[2];
const packageName = "com.tex8.monerowallet";

try {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const packages = (config.client || []).map(
    client => client?.client_info?.android_client_info?.package_name,
  );
  if (!packages.includes(packageName)) throw new Error("package mismatch");
} catch {
  console.error(
    `Missing or invalid product Firebase config: ${configPath}. ` +
    `Obtain the google-services.json registered for ${packageName}; do not use another app's file.`,
  );
  process.exit(1);
}
NODE
then
  exit 1
fi

# Preserve physical-device wallets and app state unless the caller explicitly
# requests a disposable test install.
export MONERO_WALLET_ANDROID_CLEAR_APP_DATA="${MONERO_WALLET_ANDROID_CLEAR_APP_DATA:-0}"
exec "${script_dir}/android-build-install.sh"
