#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/android-common.sh"

ADB_BIN="$(resolve_adb)"
APP_ID="${MONERO_WALLET_ANDROID_APP_ID:-com.tex8.monerowallet}"
VARIANT="${MONERO_WALLET_ANDROID_VARIANT:-debug}"
VARIANT_CAPITALIZED="$(capitalize_variant "$VARIANT")"
ARCHITECTURES="${MONERO_WALLET_ANDROID_ARCHITECTURES:-arm64-v8a}"
MONERO_LINK_ROOT="${MONERO_WALLET_LINK_ROOT:-${REPO_ROOT}/build/android-monero-link-manifests}"
MONERO_TARGET="${MONERO_WALLET_ANDROID_TARGET:-android-arm64}"
REQUIRE_MONERO="${MONERO_WALLET_ANDROID_REQUIRE_MONERO:-1}"
EXTERNAL_BUILD_ROOT="${MONERO_WALLET_ANDROID_EXTERNAL_BUILD_ROOT:-/Volumes/4TB/monero-fast-wallet-build}"
FAST_WALLET_PROTOCOL_ROOT="${MONERO_FAST_WALLET_PROTOCOL_ROOT:-${EXTERNAL_BUILD_ROOT}/mobile-fast-wallet-protocol}"
if [ ! -d "${EXTERNAL_BUILD_ROOT}" ]; then
  FAST_WALLET_PROTOCOL_ROOT="${MONERO_FAST_WALLET_PROTOCOL_ROOT:-${REPO_ROOT}/build/mobile-fast-wallet-protocol}"
fi

if [ -z "${MONERO_SOURCE_DIR:-}" ] \
  && [ -d "${EXTERNAL_BUILD_ROOT}/monero-v0.18.4.6-tex8-patched" ]; then
  MONERO_SOURCE_DIR="${EXTERNAL_BUILD_ROOT}/monero-v0.18.4.6-tex8-patched"
fi
MONERO_SOURCE_DIR="${MONERO_SOURCE_DIR:-${REPO_ROOT}/../monero-gui/monero}"

if [ -z "${MONERO_WALLET_LINK_ROOT:-}" ] \
  && [ ! -f "${MONERO_LINK_ROOT}/${MONERO_TARGET}/link.cmake" ]; then
  for external_manifest_root in \
    "${EXTERNAL_BUILD_ROOT}/android-monero-link-manifests-tex8-patched" \
    "${EXTERNAL_BUILD_ROOT}/android-monero-link-manifests"; do
    if [ -f "${external_manifest_root}/${MONERO_TARGET}/link.cmake" ]; then
      MONERO_LINK_ROOT="${external_manifest_root}"
      break
    fi
  done
fi

GRADLE_ARGS=(
  ":app:install${VARIANT_CAPITALIZED}"
  "-PreactNativeArchitectures=${ARCHITECTURES}"
)

FAST_WALLET_PROTOCOL_ARTIFACT="${FAST_WALLET_PROTOCOL_ROOT}/${MONERO_TARGET}/libfast_wallet_protocol.a"
if fast_wallet_protocol_artifact_needs_rebuild \
  "${FAST_WALLET_PROTOCOL_ARTIFACT}" \
  "${MONERO_SOURCE_DIR}"; then
  TARGETS="${MONERO_TARGET}" \
    OUTPUT_DIR="${FAST_WALLET_PROTOCOL_ROOT}" \
    MONERO_SOURCE_DIR="${MONERO_SOURCE_DIR}" \
    "${REPO_ROOT}/native/fast-wallet-protocol/build-mobile.sh"
fi
GRADLE_ARGS+=("-PmoneroFastWalletProtocolRoot=${FAST_WALLET_PROTOCOL_ROOT}")
if [ -n "${FAST_WALLET_GATEWAY_ORIGIN:-}" ]; then
  GRADLE_ARGS+=("-PfastWalletGatewayOrigin=${FAST_WALLET_GATEWAY_ORIGIN}")
fi
if [ -n "${FAST_WALLET_REGISTRATION_ORIGIN:-}" ]; then
  GRADLE_ARGS+=("-PfastWalletRegistrationOrigin=${FAST_WALLET_REGISTRATION_ORIGIN}")
fi

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

if "${ANDROID_DIR}/gradlew" ":app:tasks" --all | grep -Eq "^[[:space:]]*install${VARIANT_CAPITALIZED}([[:space:]]|$)"; then
  "${ANDROID_DIR}/gradlew" "${GRADLE_ARGS[@]}"
else
  "${ANDROID_DIR}/gradlew" ":app:assemble${VARIANT_CAPITALIZED}" "${GRADLE_ARGS[@]:1}"
  APK_PATH="${ANDROID_DIR}/app/build/outputs/apk/${VARIANT}/app-${VARIANT}.apk"

  if [ ! -f "${APK_PATH}" ]; then
    echo "Expected APK was not produced: ${APK_PATH}" >&2
    exit 1
  fi

  "$ADB_BIN" -s "$DEVICE" install -r "$APK_PATH"
fi
"$ADB_BIN" -s "$DEVICE" shell monkey -p "$APP_ID" -c android.intent.category.LAUNCHER 1 >/dev/null
