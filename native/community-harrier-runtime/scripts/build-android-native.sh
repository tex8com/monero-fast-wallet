#!/usr/bin/env bash
#
# Copyright (c) 2026 TEX8.
# SPDX-License-Identifier: AGPL-3.0-only
#
# Builds the Android arm64 shared boundary that contains the exact tokenizer
# revision and the JNI adapter for ExecuTorch Android 1.3.1.  ExecuTorch itself
# is supplied by the pinned Gradle dependency; no model or runtime is fetched
# here and no host/Apple artifact may be used for Android.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
runtime_dir="$(cd "${script_dir}/.." && pwd)"
repo_root="$(cd "${runtime_dir}/../.." && pwd)"

tokenizers_revision="0b10f027bc66e9d372e3321c9fa0142d1c52891b"
tokenizers_repository="https://github.com/meta-pytorch/tokenizers.git"
patch_path="${runtime_dir}/patches/0001-tokenizers-re2-large-special-token-dfa.patch"
android_ndk="${ANDROID_NDK_HOME:-${ANDROID_HOME:-${HOME}/Library/Android/sdk}/ndk/27.1.12297006}"
cache_dir="${TEX8_HARRIER_CACHE_DIRECTORY:-${HOME}/Library/Caches/monero-fast-wallet/harrier}"
output_root="${TEX8_COMMUNITY_HARRIER_OUTPUT_ROOT:-${repo_root}/build/mobile-community-harrier}"
# CMake caches the absolute source directory and rejects the cache after a
# checkout is moved or renamed.  Keep the default native cache specific to the
# current checkout path so an old repository cannot break a Release build.
runtime_cache_key="$(printf '%s' "${runtime_dir}" | cksum)"
runtime_cache_key="${runtime_cache_key%% *}"
build_dir="${TEX8_HARRIER_ANDROID_NATIVE_BUILD_DIRECTORY:-${cache_dir}/android-native-build-${runtime_cache_key}}"
tokenizers_dir="${cache_dir}/tokenizers-${tokenizers_revision:0:12}"

for command in cmake git; do
  command -v "${command}" >/dev/null 2>&1 || {
    echo "Missing required command: ${command}" >&2
    exit 2
  }
done
if [[ ! -f "${android_ndk}/build/cmake/android.toolchain.cmake" ]]; then
  echo "Android NDK 27.1.12297006 is required: ${android_ndk}" >&2
  exit 2
fi
ndk_hosts=("${android_ndk}"/toolchains/llvm/prebuilt/*)
if [[ ! -x "${ndk_hosts[0]}/bin/llvm-ar" ]]; then
  echo "Android NDK llvm-ar is unavailable" >&2
  exit 2
fi
llvm_ar="${ndk_hosts[0]}/bin/llvm-ar"
llvm_ranlib="${ndk_hosts[0]}/bin/llvm-ranlib"
llvm_readelf="${ndk_hosts[0]}/bin/llvm-readelf"
if [[ ! -x "${llvm_readelf}" ]]; then
  echo "Android NDK llvm-readelf is unavailable" >&2
  exit 2
fi

mkdir -p "${cache_dir}" "${output_root}/android-arm64"
if [[ ! -d "${tokenizers_dir}/.git" ]]; then
  git clone --filter=blob:none --recurse-submodules \
    "${tokenizers_repository}" "${tokenizers_dir}"
fi
git -C "${tokenizers_dir}" fetch --depth 1 origin "${tokenizers_revision}"
git -C "${tokenizers_dir}" checkout --detach "${tokenizers_revision}"
git -C "${tokenizers_dir}" submodule update --init --recursive
if [[ "$(git -C "${tokenizers_dir}" rev-parse HEAD)" != "${tokenizers_revision}" ]]; then
  echo "Tokenizer revision verification failed" >&2
  exit 1
fi
if git -C "${tokenizers_dir}" apply --reverse --check "${patch_path}" 2>/dev/null; then
  :
elif git -C "${tokenizers_dir}" apply --check "${patch_path}"; then
  git -C "${tokenizers_dir}" apply "${patch_path}"
else
  echo "The recorded tokenizer patch does not apply cleanly" >&2
  exit 1
fi
if [[ "$(git -C "${tokenizers_dir}" diff --name-only)" != "src/re2_regex.cpp" ]]; then
  echo "Tokenizer checkout contains unexpected tracked changes" >&2
  exit 1
fi

cmake -S "${runtime_dir}" -B "${build_dir}" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_TOOLCHAIN_FILE="${android_ndk}/build/cmake/android.toolchain.cmake" \
  -DANDROID_ABI=arm64-v8a \
  -DANDROID_PLATFORM=android-24 \
  -DTEX8_HARRIER_TOKENIZERS_SOURCE="${tokenizers_dir}" \
  -DTEX8_HARRIER_WITH_ANDROID_JNI_EXECUTORCH=ON \
  -DTEX8_HARRIER_BUILD_TESTBENCH=OFF
cmake --build "${build_dir}" --config Release --parallel

output="${output_root}/android-arm64/libtex8_community_harrier_runtime.so"
built_shared="$(find "${build_dir}" -type f -name 'libtex8_community_harrier_runtime.so' -print -quit)"
if [[ -z "${built_shared}" || ! -f "${built_shared}" ]]; then
  echo "No Android Harrier shared library was produced" >&2
  exit 1
fi
cp "${built_shared}" "${output}"
mkdir -p "${output_root}/jni/arm64-v8a"
cp "${output}" "${output_root}/jni/arm64-v8a/libtex8_community_harrier_runtime.so"
cp "${runtime_dir}/include/CommunityHarrierRuntimeC.h" \
  "${output_root}/android-arm64/CommunityHarrierRuntimeC.h"

# A different RE2 revision is present in the Monero JNI shared object.  Any
# dynamic RE2/C++ export here can therefore be preempted at runtime and must
# fail the build instead of becoming a device-only SIGSEGV.
dynamic_symbols="$("${llvm_readelf}" --wide --dyn-syms "${output}")"
if grep -q '_ZN3re2' <<<"${dynamic_symbols}"; then
  echo "Harrier boundary unexpectedly exports or imports RE2 C++ symbols" >&2
  exit 1
fi
required_exports=(
  tex8_community_harrier_android_install_java_vm_v1
  tex8_community_harrier_create_v1
  tex8_community_harrier_destroy_v1
  tex8_community_harrier_load_verified_v1
  tex8_community_harrier_embed_prepared_v1
  tex8_community_harrier_is_ready_v1
  tex8_community_harrier_last_error_v1
)
for required_export in "${required_exports[@]}"; do
  if ! grep -q " ${required_export}@@TEX8_COMMUNITY_HARRIER_1.0$" \
      <<<"${dynamic_symbols}"; then
    echo "Harrier boundary is missing C export: ${required_export}" >&2
    exit 1
  fi
done

cat > "${output_root}/manifest.env" <<EOF
# Generated by native/community-harrier-runtime/scripts/build-android-native.sh
ANDROID_ABI=arm64-v8a
ANDROID_API=24
EXECUTORCH_ANDROID_VERSION=1.3.1
TOKENIZERS_COMMIT=${tokenizers_revision}
HARRIER_LIBRARY=${output}
HARRIER_JNI_LIBS=${output_root}/jni
EOF
echo "Built Android Harrier boundary: ${output}"
