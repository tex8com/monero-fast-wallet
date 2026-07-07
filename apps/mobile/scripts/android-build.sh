#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/android-common.sh"

VARIANT="${MONERO_WALLET_ANDROID_VARIANT:-release}"
VARIANT_CAPITALIZED="$(capitalize_variant "$VARIANT")"
ARCHITECTURES="${MONERO_WALLET_ANDROID_ARCHITECTURES:-arm64-v8a}"
MONERO_SOURCE_DIR="${MONERO_SOURCE_DIR:-$HOME/Documents/Projects/monero-gui/monero}"
MONERO_LINK_ROOT="${MONERO_WALLET_LINK_ROOT:-${REPO_ROOT}/build/android-monero-link-manifests}"
MONERO_TARGET="${MONERO_WALLET_ANDROID_TARGET:-android-arm64}"
REQUIRE_MONERO="${MONERO_WALLET_ANDROID_REQUIRE_MONERO:-1}"
GRADLE_TASK="${MONERO_WALLET_ANDROID_GRADLE_TASK:-assemble${VARIANT_CAPITALIZED}}"

GRADLE_ARGS=(
  ":app:${GRADLE_TASK}"
  "-PreactNativeArchitectures=${ARCHITECTURES}"
)

if [ "$REQUIRE_MONERO" = "1" ]; then
  if [ ! -f "${MONERO_LINK_ROOT}/${MONERO_TARGET}/link.cmake" ]; then
    echo "Missing Android Monero link manifest: ${MONERO_LINK_ROOT}/${MONERO_TARGET}/link.cmake" >&2
    echo "Build Android Monero artifacts first:" >&2
    echo "  cd ${REPO_ROOT}" >&2
    echo "  native/monero-bridge/scripts/build-host-protobuf-tools.sh" >&2
    echo "  TARGETS=${MONERO_TARGET} native/monero-bridge/scripts/build-android-monero-deps.sh" >&2
    echo "  TARGETS=${MONERO_TARGET} SKIP_FAST_CRYPTO=1 native/monero-bridge/scripts/build-android-monero-wallet-api.sh" >&2
    exit 1
  fi

  GRADLE_ARGS+=(
    "-PmoneroWalletBridgeWithMonero=true"
    "-PmoneroSourceDir=${MONERO_SOURCE_DIR}"
    "-PmoneroWalletLinkRoot=${MONERO_LINK_ROOT}"
  )
fi

echo "Building Android ${VARIANT} for ${ARCHITECTURES}..."
cd "$ANDROID_DIR"
"${ANDROID_DIR}/gradlew" "${GRADLE_ARGS[@]}"

apk_dir="${ANDROID_DIR}/app/build/outputs/apk/${VARIANT}"
if [ -d "$apk_dir" ]; then
  find "$apk_dir" -maxdepth 1 -name "*.apk" -print
fi
