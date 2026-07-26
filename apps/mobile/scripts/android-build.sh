#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/android-common.sh"

VARIANT="${MONERO_WALLET_ANDROID_VARIANT:-release}"
VARIANT_CAPITALIZED="$(capitalize_variant "$VARIANT")"
ARCHITECTURES="${MONERO_WALLET_ANDROID_ARCHITECTURES:-arm64-v8a}"
MONERO_LINK_ROOT="${MONERO_WALLET_LINK_ROOT:-${REPO_ROOT}/build/android-monero-link-manifests}"
MONERO_TARGET="${MONERO_WALLET_ANDROID_TARGET:-android-arm64}"
REQUIRE_MONERO="${MONERO_WALLET_ANDROID_REQUIRE_MONERO:-1}"
GRADLE_TASK="${MONERO_WALLET_ANDROID_GRADLE_TASK:-assemble${VARIANT_CAPITALIZED}}"
EXTERNAL_BUILD_ROOT="${MONERO_WALLET_ANDROID_EXTERNAL_BUILD_ROOT:-/Volumes/4TB/monero-fast-wallet-build}"
APP_BUILD_DIR="${ANDROID_DIR}/app/build"

if [ -z "${MONERO_SOURCE_DIR:-}" ] \
  && [ -d "${EXTERNAL_BUILD_ROOT}/monero-v0.18.4.6-tex8-patched" ]; then
  MONERO_SOURCE_DIR="${EXTERNAL_BUILD_ROOT}/monero-v0.18.4.6-tex8-patched"
fi
MONERO_SOURCE_DIR="${MONERO_SOURCE_DIR:-${REPO_ROOT}/../monero-gui/monero}"

# Native Android artifacts are intentionally kept off the small system volume.
# A local override remains authoritative; this fallback only makes the standard
# external build location work without requiring a long environment variable.
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
  ":app:${GRADLE_TASK}"
  "-PreactNativeArchitectures=${ARCHITECTURES}"
)

# Keep Gradle's CMake object tree and caches beside the externally built
# Monero archives when that development volume is available. The root disk is
# intentionally not used for multi-gigabyte native intermediates.
if [ -d "${EXTERNAL_BUILD_ROOT}" ]; then
  APP_BUILD_DIR="${MONERO_WALLET_ANDROID_BUILD_DIR:-${EXTERNAL_BUILD_ROOT}/mobile-android-app-build}"
  export GRADLE_USER_HOME="${MONERO_WALLET_GRADLE_USER_HOME:-${EXTERNAL_BUILD_ROOT}/mobile-gradle-user-home}"
  export TMPDIR="${MONERO_WALLET_ANDROID_TMPDIR:-${EXTERNAL_BUILD_ROOT}/mobile-android-tmp}"
  mkdir -p "${GRADLE_USER_HOME}" "${TMPDIR}"
  GRADLE_ARGS+=(
    "--project-cache-dir=${MONERO_WALLET_ANDROID_PROJECT_CACHE_DIR:-${EXTERNAL_BUILD_ROOT}/mobile-android-project-cache}"
  )
  GRADLE_ARGS+=("-PmoneroWalletExternalBuildDir=${APP_BUILD_DIR}")

  # React Native dependencies own their Android Gradle outputs. AGP writes
  # those under node_modules by default, independently of the app's build
  # directory. Relocate only their reproducible build directories to the
  # external build volume so a native Monero build cannot fill the system
  # disk. Their small CMake staging directories stay in place because AGP
  # records their module-local absolute paths. Source packages, lockfiles,
  # signing keys, and wallet data remain in their original locations.
  MODULE_BUILD_ROOT="${EXTERNAL_BUILD_ROOT}/mobile-android-module-builds"
  while IFS= read -r -d '' module_output; do
    if [ -L "${module_output}" ]; then
      continue
    fi
    relative_output="${module_output#${MOBILE_DIR}/}"
    external_output="${MODULE_BUILD_ROOT}/${relative_output}"
    if [ -e "${external_output}" ]; then
      # Both locations are Gradle-generated output only. A previous interrupted
      # build can leave the external cache behind while AGP recreates the local
      # directory. Reuse the external output and replace only the local,
      # reproducible directory with a symlink; never touch package sources.
      rm -rf "${module_output}"
      ln -s "${external_output}" "${module_output}"
      continue
    fi
    mkdir -p "$(dirname "${external_output}")"
    mv "${module_output}" "${external_output}"
    ln -s "${external_output}" "${module_output}"
  done < <(find "${MOBILE_DIR}/node_modules" -type d -path '*/android/build' -prune -print0 2>/dev/null)
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

echo "Building Android ${VARIANT} for ${ARCHITECTURES}..."
cd "$ANDROID_DIR"
"${ANDROID_DIR}/gradlew" "${GRADLE_ARGS[@]}"

apk_dir="${APP_BUILD_DIR}/outputs/apk/${VARIANT}"
if [ -d "$apk_dir" ]; then
  find "$apk_dir" -maxdepth 1 -name "*.apk" -print
fi

bundle_dir="${APP_BUILD_DIR}/outputs/bundle/${VARIANT}"
if [ -d "$bundle_dir" ]; then
  find "$bundle_dir" -maxdepth 1 -name "*.aab" -print
fi
