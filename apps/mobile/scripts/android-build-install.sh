#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/android-common.sh"

ADB_BIN="$(resolve_adb)"
APP_ID="${MONERO_WALLET_ANDROID_APP_ID:-com.tex8.monerowallet}"
VARIANT="${MONERO_WALLET_ANDROID_VARIANT:-release}"
VARIANT_CAPITALIZED="$(capitalize_variant "$VARIANT")"
ARCHITECTURES="${MONERO_WALLET_ANDROID_ARCHITECTURES:-arm64-v8a}"
MONERO_SOURCE_DIR="${MONERO_SOURCE_DIR:-$HOME/Documents/Projects/monero-gui/monero}"
MONERO_LINK_ROOT="${MONERO_WALLET_LINK_ROOT:-${REPO_ROOT}/build/android-monero-link-manifests}"
MONERO_TARGET="${MONERO_WALLET_ANDROID_TARGET:-android-arm64}"
REQUIRE_MONERO="${MONERO_WALLET_ANDROID_REQUIRE_MONERO:-1}"

GRADLE_ARGS=(
  ":app:install${VARIANT_CAPITALIZED}"
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

DEVICE="$(select_android_device "$ADB_BIN")"

echo "Installing ${APP_ID} ${VARIANT} on ${DEVICE}..."
cd "$ANDROID_DIR"
"${ANDROID_DIR}/gradlew" "${GRADLE_ARGS[@]}"
"$ADB_BIN" -s "$DEVICE" shell monkey -p "$APP_ID" -c android.intent.category.LAUNCHER 1 >/dev/null
