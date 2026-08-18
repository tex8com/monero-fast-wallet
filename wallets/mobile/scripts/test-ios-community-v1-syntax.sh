#!/usr/bin/env bash
set -euo pipefail

script_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sdk_path="$(xcrun --sdk iphonesimulator --show-sdk-path)"
clang_path="$(xcrun --sdk iphonesimulator --find clang++)"

"${clang_path}" \
  -std=c++17 \
  -fobjc-arc \
  -fblocks \
  -fsyntax-only \
  -Werror=return-type \
  -Wno-nullability-completeness \
  -target arm64-apple-ios15.0-simulator \
  -isysroot "${sdk_path}" \
  "${script_root}/ios/Tests/CommunityV1ControllerSyntax.mm"
