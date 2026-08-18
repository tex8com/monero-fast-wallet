#!/usr/bin/env bash
#
# Reject Android APKs that cannot be mapped on 16-KB-page devices.  This checks
# both APK ZIP alignment and every packaged arm64 shared object; zipalign alone
# cannot catch an ELF whose PT_LOAD segments still use 4-KB alignment.
set -euo pipefail

apk_path="${1:?Usage: verify-android-16kb-elf.sh /path/to/app.apk}"
if [[ ! -f "${apk_path}" ]]; then
  echo "APK not found: ${apk_path}" >&2
  exit 2
fi

android_sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-${HOME}/Library/Android/sdk}}"
ndk_root="${ANDROID_NDK_HOME:-${android_sdk}/ndk/27.1.12297006}"
objdump_path="$(find "${ndk_root}"/toolchains/llvm/prebuilt -path '*/bin/llvm-objdump' -type f -print -quit)"
zipalign_path="$(find "${android_sdk}"/build-tools -path '*/zipalign' -type f -print | sort | tail -1)"

command -v unzip >/dev/null 2>&1 || {
  echo "Required inspection tool is unavailable: unzip" >&2
  exit 2
}
if [[ -z "${objdump_path}" || ! -x "${objdump_path}" ]]; then
  echo "Required Android inspection tool is unavailable: llvm-objdump" >&2
  exit 2
fi
if [[ -z "${zipalign_path}" || ! -x "${zipalign_path}" ]]; then
  echo "Required Android inspection tool is unavailable: zipalign" >&2
  exit 2
fi

"${zipalign_path}" -c -P 16 -v 4 "${apk_path}" >/dev/null

inspection_dir="$(mktemp -d /tmp/mfw-16kb-elf.XXXXXX)"
trap 'rm -rf "${inspection_dir}"' EXIT
libraries=()
while IFS= read -r entry; do
  libraries+=("${entry}")
done < <(unzip -Z1 "${apk_path}" 'lib/arm64-v8a/*.so')
if [[ "${#libraries[@]}" -eq 0 ]]; then
  echo "APK contains no arm64 shared libraries: ${apk_path}" >&2
  exit 2
fi

failed=0
for entry in "${libraries[@]}"; do
  library_path="${inspection_dir}/$(basename "${entry}")"
  unzip -p "${apk_path}" "${entry}" > "${library_path}"
  if "${objdump_path}" -p "${library_path}" | \
    grep -Eq 'LOAD.*align 2\*\*((0|[1-9])|1[0-3])($|[[:space:]])'; then
    echo "16-KB ELF alignment failed: ${entry}" >&2
    failed=1
  fi
done

if [[ "${failed}" -ne 0 ]]; then
  exit 1
fi
echo "16-KB APK and ELF alignment verified: ${#libraries[@]} arm64 shared libraries"
