#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${script_dir}/android-release-signing.sh"

MONERO_WALLET_ANDROID_GRADLE_TASK="bundleRelease"
if [[ "${MONERO_WALLET_ANDROID_ARTIFACT:-bundle}" == "apk" ]]; then
  MONERO_WALLET_ANDROID_GRADLE_TASK="assembleRelease"
elif [[ "${MONERO_WALLET_ANDROID_ARTIFACT:-bundle}" != "bundle" ]]; then
  echo "MONERO_WALLET_ANDROID_ARTIFACT must be either bundle or apk." >&2
  exit 1
fi
export MONERO_WALLET_ANDROID_GRADLE_TASK

exec "${script_dir}/android-build.sh"
