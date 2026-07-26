#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"

action_count=0
while IFS= read -r action_ref; do
  action_count=$((action_count + 1))
  if [[ ! "${action_ref}" =~ ^[^[:space:]#]+@[0-9a-f]{40}$ ]]; then
    echo "GitHub Action is not pinned to a full commit: ${action_ref}" >&2
    exit 1
  fi
done < <(
  awk '/^[[:space:]]*-[[:space:]]+uses:/ { print $3 }' \
    "${repo_root}"/.github/workflows/*.yml \
    "${repo_root}"/.github/workflows/*.yaml 2>/dev/null || true
)
if [[ "${action_count}" -eq 0 ]]; then
  echo "no GitHub Actions found to validate" >&2
  exit 1
fi

while IFS= read -r dependency; do
  if [[ ! "${dependency}" =~ rev[[:space:]]*=[[:space:]]*\"[0-9a-f]{40}\" ]]; then
    echo "Cargo git dependency is not pinned to a full commit: ${dependency}" >&2
    exit 1
  fi
done < <(
  rg -n 'git[[:space:]]*=' "${repo_root}" \
    --glob 'Cargo.toml' \
    --glob '!build/**' \
    --glob '!third_party/**' \
    --glob '!tools/monero-upstream/**'
)

for package_json in \
  "${repo_root}/apps/mobile/package.json" \
  "${repo_root}/apps/desktop/package.json"; do
  if ! rg -q '"packageManager": "npm@11\.16\.0"' "${package_json}"; then
    echo "exact npm package manager is missing from ${package_json}" >&2
    exit 1
  fi
done
if [[ -e "${repo_root}/apps/mobile/yarn.lock" || -e "${repo_root}/apps/desktop/yarn.lock" ]]; then
  echo "mixed JavaScript lockfile policy detected" >&2
  exit 1
fi

for build_script in "${repo_root}"/native/monero-bridge/scripts/build-*.sh; do
  bash -n "${build_script}"
  if rg -q 'curl[[:space:]]' "${build_script}" \
    && ! rg -q 'verify_sha256' "${build_script}"; then
    echo "download without SHA-256 verification: ${build_script}" >&2
    exit 1
  fi
done
bash -n "${repo_root}/native/monero-bridge/scripts/checkout-pinned-source.sh"

if ! rg -q '^distributionSha256Sum=[a-f0-9]{64}$' \
  "${repo_root}/apps/mobile/android/gradle/wrapper/gradle-wrapper.properties"; then
  echo "Gradle wrapper checksum is missing" >&2
  exit 1
fi
for required_file in \
  "${repo_root}/apps/mobile/android/app/gradle.lockfile" \
  "${repo_root}/apps/mobile/android/gradle/verification-metadata.xml" \
  "${repo_root}/apps/mobile/ios/Podfile.lock" \
  "${repo_root}/apps/mobile/Gemfile.lock"; do
  if [[ ! -s "${required_file}" ]]; then
    echo "required dependency integrity file is missing: ${required_file}" >&2
    exit 1
  fi
done

echo "Supply-chain contract passed: actions, source revisions, package managers, downloads, and mobile artifacts are pinned."
