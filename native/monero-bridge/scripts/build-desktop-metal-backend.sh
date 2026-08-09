#!/usr/bin/env bash
# Compile the authenticated Monero wallet Metal kernel into the exact resource
# shipped by the macOS desktop application.
set -euo pipefail

if [[ "$#" -ne 2 ]]; then
  echo "usage: build-desktop-metal-backend.sh <patched-monero-source> <output-dir>" >&2
  exit 64
fi

metal_monero_source="$1"
metal_output_dir="$2"
metal_kernel="${metal_monero_source}/tools/wallet-metal-testbench/derivation_radix2625_chunkinvert.metal"
metal_output="${metal_output_dir}/monero_wallet_derivation.metallib"

[[ "$(uname -s)" == "Darwin" ]] || {
  echo "The desktop Metal backend can only be built on macOS." >&2
  exit 69
}
[[ -f "${metal_kernel}" ]] || {
  echo "Authenticated wallet Metal kernel not found: ${metal_kernel}" >&2
  exit 66
}
for metal_tool in metal metallib; do
  xcrun -sdk macosx --find "${metal_tool}" >/dev/null 2>&1 || {
    echo "Xcode Metal tool '${metal_tool}' is unavailable." >&2
    echo "Install it with: xcodebuild -downloadComponent MetalToolchain" >&2
    exit 69
  }
done

metal_temp_root="${TMPDIR:-/tmp}"
mkdir -p "${metal_temp_root}"
metal_temp_dir="$(mktemp -d "${metal_temp_root%/}/monero-wallet-metal.XXXXXX")"
trap 'rm -rf "${metal_temp_dir}"' EXIT
mkdir -p "${metal_output_dir}"

xcrun -sdk macosx metal \
  -c \
  -mmacosx-version-min=12.0 \
  "${metal_kernel}" \
  -o "${metal_temp_dir}/monero_wallet_derivation.air"
xcrun -sdk macosx metallib \
  "${metal_temp_dir}/monero_wallet_derivation.air" \
  -o "${metal_temp_dir}/monero_wallet_derivation.metallib"
install -m 0644 \
  "${metal_temp_dir}/monero_wallet_derivation.metallib" \
  "${metal_output}"

metal_sha256() {
  shasum -a 256 "$1" | awk '{print $1}'
}

{
  echo "schema=tex8_wallet_metal_desktop_v1"
  echo "minimum_macos=12.0"
  echo "kernel=${metal_kernel}"
  echo "kernel_sha256=$(metal_sha256 "${metal_kernel}")"
  echo "metal_compiler=$(xcrun -sdk macosx metal -v 2>&1 | tr '\n' ';')"
  echo "xcode=$(xcodebuild -version | tr '\n' ';')"
  echo "metallib=${metal_output}"
  echo "metallib_sha256=$(metal_sha256 "${metal_output}")"
  echo "metallib_bytes=$(stat -f '%z' "${metal_output}")"
} > "${metal_output_dir}/wallet-metal-build.env"

echo "wallet_metal_metallib=${metal_output}"
echo "wallet_metal_metadata=${metal_output_dir}/wallet-metal-build.env"
