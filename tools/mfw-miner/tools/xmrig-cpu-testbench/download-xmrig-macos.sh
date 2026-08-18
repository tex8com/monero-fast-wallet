#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo "download-xmrig-macos.sh requires an Apple Silicon Mac" >&2
  exit 2
fi

bench_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
version=v6.26.0
commit=b2ca72480c58d197e18c885d9fc1a0c8d517e60a
archive=xmrig-6.26.0-macos-arm64.tar.gz
archive_sha256=6ae4eb4216e99a201ae9a3d2c3a7c275207c5165cfc25da1f3d735d6c4829c18
sums_sha256=0a4b603f49b2fb803f23a2b6657e0fa110dd930ca6619926858ce66f1c60ddf5
signature_sha256=04083a4e5ff4a43f67def02162a6583c7bd5835f14570b39cd11beefc70af5d6
key_file_sha256=5d7bcb7873a2f1a6bfc391b76677ce291ad843da71453dece8634c436e47c9b6
key_fingerprint=9AC4CEA8E66E35A5C7CDDC1B446A53638BE94409
destination_input="${1:-${bench_dir}/.work/m4/downloads/xmrig-6.26.0-verified}"
release_url="https://github.com/xmrig/xmrig/releases/download/${version}"
key_url="https://raw.githubusercontent.com/xmrig/xmrig/${commit}/doc/gpg_keys/xmrig.asc"

if [[ -e "${destination_input}" ]]; then
  echo "destination already exists: ${destination_input}" >&2
  exit 2
fi

for command in curl gpg gpgconf shasum tar; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "missing required command: ${command}" >&2
    exit 3
  fi
done

mkdir -p "$(dirname "${destination_input}")"
destination="$(cd "$(dirname "${destination_input}")" && pwd)/$(basename "${destination_input}")"
mkdir -p "${destination}/extracted"
gpg_home="$(mktemp -d /tmp/mfw-xmrig-gpg.XXXXXX)"
chmod 700 "${gpg_home}"

cleanup() {
  if [[ -d "${gpg_home}" && "${gpg_home}" == /tmp/mfw-xmrig-gpg.* ]]; then
    gpgconf --homedir "${gpg_home}" --kill all >/dev/null 2>&1 || true
    rm -r -- "${gpg_home}"
  fi
}
trap cleanup EXIT

curl --proto '=https' --tlsv1.2 --silent --show-error -fL \
  --output "${destination}/${archive}" "${release_url}/${archive}"
curl --proto '=https' --tlsv1.2 --silent --show-error -fL \
  --output "${destination}/SHA256SUMS" "${release_url}/SHA256SUMS"
curl --proto '=https' --tlsv1.2 --silent --show-error -fL \
  --output "${destination}/SHA256SUMS.sig" "${release_url}/SHA256SUMS.sig"
curl --proto '=https' --tlsv1.2 --silent --show-error -fL \
  --output "${destination}/xmrig.asc" "${key_url}"

verify_sha256() {
  local expected="$1" file="$2" actual
  actual="$(shasum -a 256 "${file}" | awk '{print $1}')"
  if [[ "${actual}" != "${expected}" ]]; then
    echo "SHA-256 mismatch for ${file}: ${actual}" >&2
    exit 4
  fi
}

verify_sha256 "${sums_sha256}" "${destination}/SHA256SUMS"
verify_sha256 "${signature_sha256}" "${destination}/SHA256SUMS.sig"
verify_sha256 "${key_file_sha256}" "${destination}/xmrig.asc"

gpg --homedir "${gpg_home}" --batch --import \
  "${destination}/xmrig.asc"
fingerprints="$(gpg --homedir "${gpg_home}" --batch --with-colons \
  --fingerprint 2>/dev/null | awk -F: '$1 == "fpr" { print $10 }')"
if ! grep -qx "${key_fingerprint}" <<<"${fingerprints}"; then
  echo "XMRig signing-key fingerprint mismatch" >&2
  exit 5
fi

printf '%s\n' "${fingerprints}" >"${destination}/gpg-fingerprints.txt"
gpg --homedir "${gpg_home}" --batch --verify \
  "${destination}/SHA256SUMS.sig" "${destination}/SHA256SUMS" \
  2>&1 | tee "${destination}/gpg-verify.txt"

actual_sha256="$(shasum -a 256 "${destination}/${archive}" | awk '{print $1}')"
if [[ "${actual_sha256}" != "${archive_sha256}" ]]; then
  echo "archive SHA-256 mismatch: ${actual_sha256}" >&2
  exit 6
fi

(
  cd "${destination}"
  grep " \*${archive}$" SHA256SUMS | shasum -a 256 -c -
)

tar -xzf "${destination}/${archive}" -C "${destination}/extracted"
binary="${destination}/extracted/xmrig-6.26.0/xmrig"
if [[ ! -x "${binary}" ]]; then
  echo "verified archive did not contain the expected executable" >&2
  exit 7
fi

"${binary}" --version
codesign -dv --verbose=4 "${binary}" >"${destination}/codesign.txt" 2>&1 || true

printf 'verified_archive=%s\n' "${destination}/${archive}"
printf 'archive_sha256=%s\n' "${actual_sha256}"
printf 'signing_key_fingerprint=%s\n' "${key_fingerprint}"
printf 'binary=%s\n' "${binary}"
printf 'binary_sha256=%s\n' "$(shasum -a 256 "${binary}" | awk '{print $1}')"
