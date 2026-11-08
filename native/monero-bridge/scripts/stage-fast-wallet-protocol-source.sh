#!/usr/bin/env bash
# Preserve the repository-relative dependency layout in an isolated build.

stage_fast_wallet_protocol_sources() {
  local source_repo="$1"
  local stage_root="$2"
  local protocol_root="${3:-${source_repo}/native/fast-wallet-protocol}"
  local product_root="${4:-${source_repo}/native/product-core}"
  local component component_source destination input patch_path vendor_name

  for component in fast-wallet-protocol mfw-recipient-protocol product-core; do
    component_source="${source_repo}/native/${component}"
    [[ "${component}" != fast-wallet-protocol ]] || component_source="${protocol_root}"
    [[ "${component}" != product-core ]] || component_source="${product_root}"
    destination="${stage_root}/native/${component}"
    mkdir -p "${destination}"
    cp "${component_source}/Cargo.toml" "${component_source}/Cargo.lock" "${destination}/"
    for input in src include test-vectors schema generated README.md; do
      if [[ -e "${component_source}/${input}" ]]; then
        cp -R "${component_source}/${input}" "${destination}/"
      fi
    done
  done

  # The native Cargo roots name only reviewed, package-local vendor sources.
  # Keep those exact relative paths; never copy a target cache or arbitrary
  # absolute dependency path into the build snapshot.
  while IFS= read -r patch_path; do
    [[ -n "${patch_path}" ]] || continue
    vendor_name="${patch_path##*/}"
    if [[ ! "${vendor_name}" =~ ^[a-zA-Z0-9._-]+$ ]] \
      || [[ "${patch_path}" != "../../third_party/${vendor_name}" ]] \
      || [[ -L "${source_repo}/third_party/${vendor_name}" ]] \
      || [[ ! -f "${source_repo}/third_party/${vendor_name}/Cargo.toml" ]] \
      || [[ -e "${source_repo}/third_party/${vendor_name}/target" ]]; then
      echo "Invalid or unprepared Rust security dependency: ${patch_path}" >&2
      return 1
    fi
    mkdir -p "${stage_root}/third_party"
    if [[ ! -e "${stage_root}/third_party/${vendor_name}" ]]; then
      cp -R "${source_repo}/third_party/${vendor_name}" "${stage_root}/third_party/${vendor_name}"
    fi
  done < <(
    sed -nE 's/^.*path[[:space:]]*=[[:space:]]*"(\.\.\/\.\.\/third_party\/[^\"]+)".*$/\1/p' \
      "${protocol_root}/Cargo.toml" \
      "${source_repo}/native/mfw-recipient-protocol/Cargo.toml"
  )
}
