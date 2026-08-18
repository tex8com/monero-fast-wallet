#!/usr/bin/env bash
set -euo pipefail

# Builds the real arm64 Monero wallet core for Apple-Silicon iOS Simulator.
# Ledger transport remains intentionally unavailable there, but software-wallet
# create/restore/open, sync, receive and transaction flows use this same core.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$APP_ROOT/../.." && pwd)"
BUILD_ROOT="${MONERO_IOS_BUILD_ROOT:-/Volumes/4TB/monero-fast-wallet-build}"

if [ ! -d "$BUILD_ROOT" ]; then
  BUILD_ROOT="$REPO_ROOT/build"
fi

export PATH="$HOME/Library/Python/3.9/bin:$PATH"
export TARGETS="${MONERO_IOS_TARGETS:-ios-sim-arm64}"
export CLEAN_AFTER_INSTALL=1
export JOBS="${JOBS:-8}"
export MONERO_IOS_DEPENDENCY_ROOT="$BUILD_ROOT/ios-deps"
export MONERO_IOS_GRPC_DEPENDENCY_ROOT="$MONERO_IOS_DEPENDENCY_ROOT"
export MONERO_ENABLE_GRPC_STREAM=ON
export MONERO_IOS_HOST_TOOLS_ROOT="$BUILD_ROOT/host-protobuf-tools"
export PROTOC_PATH="$BUILD_ROOT/host-protobuf-tools/protobuf-v31.1/bin/protoc"
export GRPC_CPP_PLUGIN_PATH="$BUILD_ROOT/host-grpc-tools/v1.80.0/bin/grpc_cpp_plugin"

MONERO_COMMON_CORE_BUILD_ROOT="$BUILD_ROOT" \
  source "$REPO_ROOT/native/monero-bridge/scripts/prepare-common-monero-core.sh"

# Core-derived mobile archives are namespaced by the authenticated source
# tree. This makes it impossible for an older, identically named archive to
# satisfy a new app build merely because it still exists on the build volume.
export MONERO_FAST_CRYPTO_ROOT="${MONERO_FAST_CRYPTO_ROOT:-$BUILD_ROOT/mobile-fast-crypto-$MONERO_COMMON_CORE_TREE}"
export MONERO_FAST_WALLET_PROTOCOL_ROOT="${MONERO_FAST_WALLET_PROTOCOL_ROOT:-$BUILD_ROOT/mobile-fast-wallet-protocol-$MONERO_COMMON_CORE_TREE}"
IOS_WALLET_BUILD_ROOT="${MONERO_IOS_WALLET_BUILD_ROOT:-$BUILD_ROOT/ios-monero-wallet-$MONERO_COMMON_CORE_TREE}"
IOS_LINK_MANIFEST_ROOT="${MONERO_IOS_LINK_MANIFEST_ROOT:-$BUILD_ROOT/ios-monero-link-manifests-$MONERO_COMMON_CORE_TREE}"
PRODUCT_CORE_ROOT="${MFW_PRODUCT_CORE_MOBILE_ROOT:-$BUILD_ROOT/mobile-product-core-$MONERO_COMMON_CORE_TREE}"

TARGETS=ios-sim-arm64 OUTPUT_DIR="$MONERO_FAST_WALLET_PROTOCOL_ROOT" \
  "$REPO_ROOT/native/fast-wallet-protocol/build-mobile.sh"

if [ ! -f "$PRODUCT_CORE_ROOT/ios-sim-arm64/libmfw_product_core.a" ]; then
  TARGETS=ios-sim-arm64 OUTPUT_DIR="$PRODUCT_CORE_ROOT" \
    "$REPO_ROOT/native/product-core/build-mobile.sh"
fi

if [ ! -x "$PROTOC_PATH" ]; then
  OUTPUT_ROOT="$BUILD_ROOT/host-protobuf-tools" \
    "$REPO_ROOT/native/monero-bridge/scripts/build-host-protobuf-tools.sh"
fi
if [ ! -x "$GRPC_CPP_PLUGIN_PATH" ]; then
  OUTPUT_ROOT="$BUILD_ROOT/host-grpc-tools" \
    "$REPO_ROOT/native/monero-bridge/scripts/build-host-grpc-cpp-plugin.sh"
fi

OUTPUT_ROOT="$MONERO_IOS_DEPENDENCY_ROOT" \
  "$REPO_ROOT/native/monero-bridge/scripts/build-ios-monero-deps.sh"
OUTPUT_ROOT="$MONERO_IOS_GRPC_DEPENDENCY_ROOT" \
  "$REPO_ROOT/native/monero-bridge/scripts/build-ios-grpc.sh"
OUTPUT_ROOT="$IOS_WALLET_BUILD_ROOT" SKIP_FAST_CRYPTO=0 \
  MFW_PRODUCT_CORE_ROOT="$REPO_ROOT/native/product-core" \
  MFW_PRODUCT_CORE_LIBRARY="$PRODUCT_CORE_ROOT/ios-sim-arm64/libmfw_product_core.a" \
  "$REPO_ROOT/native/monero-bridge/scripts/build-ios-monero-wallet-api.sh"
MONERO_IOS_BUILD_ROOT="$IOS_WALLET_BUILD_ROOT" \
  OUTPUT_DIR="$IOS_LINK_MANIFEST_ROOT" \
  STRICT_OPTIONAL=1 \
  "$REPO_ROOT/native/monero-bridge/scripts/generate-ios-monero-link-manifests.sh"

echo "Authenticated Monero tree: $MONERO_PATCHED_SOURCE_TREE"
echo "iOS core ready: $IOS_LINK_MANIFEST_ROOT"
