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
export TARGETS=ios-sim-arm64
export CLEAN_AFTER_INSTALL=1
export JOBS="${JOBS:-8}"
export MONERO_IOS_DEPENDENCY_ROOT="$BUILD_ROOT/ios-deps"
export MONERO_FAST_CRYPTO_ROOT="$BUILD_ROOT/mobile-fast-crypto"

OUTPUT_ROOT="$MONERO_IOS_DEPENDENCY_ROOT" \
  "$REPO_ROOT/native/monero-bridge/scripts/build-ios-monero-deps.sh"
OUTPUT_ROOT="$BUILD_ROOT/ios-monero-wallet" SKIP_FAST_CRYPTO=0 \
  "$REPO_ROOT/native/monero-bridge/scripts/build-ios-monero-wallet-api.sh"
MONERO_IOS_BUILD_ROOT="$BUILD_ROOT/ios-monero-wallet" \
  OUTPUT_DIR="$BUILD_ROOT/ios-monero-link-manifests" \
  "$REPO_ROOT/native/monero-bridge/scripts/generate-ios-monero-link-manifests.sh"

echo "Simulator core ready: $BUILD_ROOT/ios-monero-link-manifests/iphonesimulator/libtex8_monero_wallet_core.a"
