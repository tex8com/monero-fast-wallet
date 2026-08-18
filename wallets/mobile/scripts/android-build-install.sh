#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/android-common.sh"

ADB_BIN="$(resolve_adb)"
APP_ID="${MONERO_WALLET_ANDROID_APP_ID:-com.tex8.monerowallet}"
# Pixel installs must exercise the same release artifact that is shared for
# testing. A debug build can still be requested explicitly for local React
# Native work, but it is never the implicit device path.
VARIANT="${MONERO_WALLET_ANDROID_VARIANT:-release}"
VARIANT_CAPITALIZED="$(capitalize_variant "$VARIANT")"
ARCHITECTURES="${MONERO_WALLET_ANDROID_ARCHITECTURES:-arm64-v8a}"
DISABLE_COMMUNITY_V1="${MONERO_WALLET_SIMULATOR_DISABLE_COMMUNITY_V1:-0}"
CLEAR_APP_DATA="${MONERO_WALLET_ANDROID_CLEAR_APP_DATA:-1}"
SKIP_GOOGLE_SERVICES="${MONERO_WALLET_SKIP_GOOGLE_SERVICES:-}"
if [ -z "${SKIP_GOOGLE_SERVICES}" ]; then
  if [ "${APP_ID}" = "com.tex8.monerowallet" ]; then
    SKIP_GOOGLE_SERVICES=0
  else
    SKIP_GOOGLE_SERVICES=1
  fi
fi
MONERO_LINK_ROOT="${MONERO_WALLET_LINK_ROOT:-${REPO_ROOT}/build/android-monero-link-manifests}"
MONERO_TARGET="${MONERO_WALLET_ANDROID_TARGET:-android-arm64}"
REQUIRE_MONERO="${MONERO_WALLET_ANDROID_REQUIRE_MONERO:-1}"
EXTERNAL_BUILD_ROOT="${MONERO_WALLET_ANDROID_EXTERNAL_BUILD_ROOT:-/Volumes/4TB/monero-fast-wallet-build}"
FAST_WALLET_PROTOCOL_ROOT="${MONERO_FAST_WALLET_PROTOCOL_ROOT:-${EXTERNAL_BUILD_ROOT}/mobile-fast-wallet-protocol}"
COMMUNITY_HARRIER_ROOT="${MONERO_COMMUNITY_HARRIER_ROOT:-${EXTERNAL_BUILD_ROOT}/mobile-community-harrier}"
COMMUNITY_MATRIX_ROOT="${MONERO_COMMUNITY_MATRIX_ROOT:-${EXTERNAL_BUILD_ROOT}/mobile-community-matrix}"
COMMUNITY_ASSET_ROOT="${MONERO_COMMUNITY_ASSET_ROOT:-${EXTERNAL_BUILD_ROOT}/community-v1-release-assets}"
if [ ! -d "${EXTERNAL_BUILD_ROOT}" ]; then
  FAST_WALLET_PROTOCOL_ROOT="${MONERO_FAST_WALLET_PROTOCOL_ROOT:-${REPO_ROOT}/build/mobile-fast-wallet-protocol}"
  COMMUNITY_HARRIER_ROOT="${MONERO_COMMUNITY_HARRIER_ROOT:-${REPO_ROOT}/build/mobile-community-harrier}"
  COMMUNITY_MATRIX_ROOT="${MONERO_COMMUNITY_MATRIX_ROOT:-${REPO_ROOT}/build/mobile-community-matrix}"
  COMMUNITY_ASSET_ROOT="${MONERO_COMMUNITY_ASSET_ROOT:-${REPO_ROOT}/build/community-v1-release-assets}"
else
  # The Fast Wallet protocol build runs before Gradle's own cache setup.
  # Point its mktemp/Cargo intermediates at the external build volume too.
  export TMPDIR="${MONERO_WALLET_ANDROID_TMPDIR:-${EXTERNAL_BUILD_ROOT}/mobile-android-tmp}"
  mkdir -p "${TMPDIR}"
fi

if [ "$REQUIRE_MONERO" = "1" ]; then
  MONERO_COMMON_CORE_BUILD_ROOT="$EXTERNAL_BUILD_ROOT" \
    source "$REPO_ROOT/native/monero-bridge/scripts/prepare-common-monero-core.sh"
else
  MONERO_SOURCE_DIR="${MONERO_SOURCE_DIR:-${REPO_ROOT}/../monero-gui/monero}"
fi

link_manifest_matches_common_core() {
  local manifest="$1"
  [ -f "$manifest" ] &&
    grep -Fq "set(MONERO_PATCHED_SOURCE_TREE \"${MONERO_COMMON_CORE_TREE}\")" "$manifest"
}

if [ -z "${MONERO_WALLET_LINK_ROOT:-}" ] \
  && ! link_manifest_matches_common_core \
    "${MONERO_LINK_ROOT}/${MONERO_TARGET}/link.cmake"; then
  for external_manifest_root in \
    "${EXTERNAL_BUILD_ROOT}/android-monero-link-manifests-${MONERO_COMMON_CORE_TREE}" \
    "${EXTERNAL_BUILD_ROOT}/android-monero-link-manifests-tex8-patched" \
    "${EXTERNAL_BUILD_ROOT}/android-monero-link-manifests"; do
    if link_manifest_matches_common_core \
      "${external_manifest_root}/${MONERO_TARGET}/link.cmake"; then
      MONERO_LINK_ROOT="${external_manifest_root}"
      break
    fi
  done
fi

GRADLE_ARGS=(
  ":app:assemble${VARIANT_CAPITALIZED}"
  "-PreactNativeArchitectures=${ARCHITECTURES}"
  "-PmoneroWalletApplicationId=${APP_ID}"
)
if [ "${DISABLE_COMMUNITY_V1}" != "0" ] &&
   [ "${DISABLE_COMMUNITY_V1}" != "1" ]; then
  echo "MONERO_WALLET_SIMULATOR_DISABLE_COMMUNITY_V1 must be 0 or 1." >&2
  exit 1
fi
if [ "${CLEAR_APP_DATA}" != "0" ] && [ "${CLEAR_APP_DATA}" != "1" ]; then
  echo "MONERO_WALLET_ANDROID_CLEAR_APP_DATA must be 0 or 1." >&2
  exit 1
fi
if [ "${DISABLE_COMMUNITY_V1}" = "1" ]; then
  if [ "${APP_ID}" = "com.tex8.monerowallet" ]; then
    echo "Community V1 may be disabled only for a separate simulator application ID." >&2
    exit 1
  fi
  GRADLE_ARGS+=("-PmoneroEnthusiastV1DevelopmentDisabled=true")
fi
if [ "${SKIP_GOOGLE_SERVICES}" != "0" ] &&
   [ "${SKIP_GOOGLE_SERVICES}" != "1" ]; then
  echo "MONERO_WALLET_SKIP_GOOGLE_SERVICES must be 0 or 1." >&2
  exit 1
fi
if [ "${SKIP_GOOGLE_SERVICES}" = "1" ]; then
  GRADLE_ARGS+=(
    "-PmoneroSkipGoogleServices=true"
    "-PmoneroDevelopmentDependencyLockingLenient=true"
  )
  export MONERO_WALLET_SKIP_FIREBASE_NATIVE=1
fi

reset_react_native_autolinking

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

# The product application requires the complete, real Community runtime. Build
# its Android-specific bridge and Rust archive before Gradle so CMake cannot
# silently create a reduced "Not ready" application.
COMMUNITY_HARRIER_LIBRARY="${COMMUNITY_HARRIER_ROOT}/android-arm64/libtex8_community_harrier_runtime.so"
COMMUNITY_HARRIER_JNI_LIBS="${COMMUNITY_HARRIER_ROOT}/jni"
COMMUNITY_MATRIX_LIBRARY="${COMMUNITY_MATRIX_ROOT}/android-arm64/libcommunity_matrix_core.a"
if [ ! -f "${COMMUNITY_HARRIER_LIBRARY}" ] || \
   find "${REPO_ROOT}/native/community-harrier-runtime" -type f -newer "${COMMUNITY_HARRIER_LIBRARY}" -print -quit | grep -q .; then
  TEX8_COMMUNITY_HARRIER_OUTPUT_ROOT="${COMMUNITY_HARRIER_ROOT}" \
    "${REPO_ROOT}/native/community-harrier-runtime/scripts/build-android-native.sh"
fi
if [ ! -f "${COMMUNITY_MATRIX_LIBRARY}" ] || \
   find "${REPO_ROOT}/native/community-matrix-core" -type f -newer "${COMMUNITY_MATRIX_LIBRARY}" -print -quit | grep -q . || \
   [ "${COMMUNITY_HARRIER_LIBRARY}" -nt "${COMMUNITY_MATRIX_LIBRARY}" ]; then
  TARGETS=android-arm64 \
    WITH_COMMUNITY_RUNTIME=1 \
    HARRIER_LIBRARY_SUFFIX=.so \
    TEX8_COMMUNITY_HARRIER_LIBRARY_ROOT="${COMMUNITY_HARRIER_ROOT}" \
    CARGO_TARGET_DIR="${EXTERNAL_BUILD_ROOT}/mobile-community-matrix-cargo-target" \
    OUTPUT_DIR="${COMMUNITY_MATRIX_ROOT}" \
    "${REPO_ROOT}/native/community-matrix-core/build-mobile.sh"
fi
GRADLE_ARGS+=(
  "-PmoneroCommunityMatrixLibrary=${COMMUNITY_MATRIX_LIBRARY}"
  "-PmoneroCommunityHarrierLibrary=${COMMUNITY_HARRIER_LIBRARY}"
  "-PmoneroCommunityHarrierJniLibs=${COMMUNITY_HARRIER_JNI_LIBS}"
  "-PmoneroCommunityAssetRoot=${COMMUNITY_ASSET_ROOT}"
)
if [ -n "${FAST_WALLET_GATEWAY_ORIGIN:-}" ]; then
  GRADLE_ARGS+=("-PfastWalletGatewayOrigin=${FAST_WALLET_GATEWAY_ORIGIN}")
fi
if [ -n "${FAST_WALLET_REGISTRATION_ORIGIN:-}" ]; then
  GRADLE_ARGS+=("-PfastWalletRegistrationOrigin=${FAST_WALLET_REGISTRATION_ORIGIN}")
fi

if [ -d "${EXTERNAL_BUILD_ROOT}" ]; then
  APP_BUILD_DIR="${MONERO_WALLET_ANDROID_BUILD_DIR:-${EXTERNAL_BUILD_ROOT}/mobile-android-install-build}"
  export GRADLE_USER_HOME="${MONERO_WALLET_GRADLE_USER_HOME:-${EXTERNAL_BUILD_ROOT}/mobile-gradle-user-home}"
  export TMPDIR="${MONERO_WALLET_ANDROID_TMPDIR:-${EXTERNAL_BUILD_ROOT}/mobile-android-tmp}"
  mkdir -p "${APP_BUILD_DIR}" "${GRADLE_USER_HOME}" "${TMPDIR}"
  GRADLE_ARGS+=(
    "--project-cache-dir=${MONERO_WALLET_ANDROID_PROJECT_CACHE_DIR:-${EXTERNAL_BUILD_ROOT}/mobile-android-install-project-cache}"
    "-PmoneroWalletExternalBuildDir=${APP_BUILD_DIR}"
  )
fi

if [ "$REQUIRE_MONERO" = "1" ]; then
  MONERO_LINK_ROOT="$(ensure_android_monero_link_root \
    "${MONERO_LINK_ROOT}" "${MONERO_TARGET}" "${MONERO_COMMON_CORE_TREE}" "${EXTERNAL_BUILD_ROOT}")"

  GRADLE_ARGS+=(
    "-PmoneroWalletBridgeWithMonero=true"
    "-PmoneroSourceDir=${MONERO_SOURCE_DIR}"
    "-PmoneroWalletLinkRoot=${MONERO_LINK_ROOT}"
  )
fi

DEVICE="$(select_android_device "$ADB_BIN")"

echo "Building ${APP_ID} ${VARIANT} for ${DEVICE}..."
cd "$ANDROID_DIR"

# Do not probe :app:tasks in a separate Gradle invocation. The app project
# validates the packaged Community runtime while it is configured, and that
# probe did not receive the build's -P paths.  It therefore failed before the
# real build could start. Assemble with the selected build context, verify the
# resulting APK for 16-KB-page compatibility, and only then install it.
"${ANDROID_DIR}/gradlew" "${GRADLE_ARGS[@]}"
APK_PATH="${APP_BUILD_DIR:-${ANDROID_DIR}/app/build}/outputs/apk/${VARIANT}/app-${VARIANT}.apk"
"${REPO_ROOT}/wallets/mobile/scripts/verify-android-16kb-elf.sh" "${APK_PATH}"
echo "Installing verified ${APP_ID} ${VARIANT} on ${DEVICE}..."
"$ADB_BIN" -s "$DEVICE" install -r "${APK_PATH}" >/dev/null
if [ "${CLEAR_APP_DATA}" = "1" ]; then
  # This is the local development installer. The current Pixel workflow uses
  # disposable wallets, so every install starts without registrations, wallet
  # files, cached sessions, or Android-restored application state.
  "$ADB_BIN" -s "$DEVICE" shell pm clear "$APP_ID" >/dev/null
fi
# Android may retain the previous process across an in-place APK update. Stop
# it before handing the device back to the user. Installation and diagnostics
# must not change the foreground activity; callers can inspect or launch it
# explicitly when they choose.
"$ADB_BIN" -s "$DEVICE" shell am force-stop "$APP_ID" >/dev/null
