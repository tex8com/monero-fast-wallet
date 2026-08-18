#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo $0 ARTIFACT PRODUCT PLATFORM PACKAGE VERSION [GITHUB_URL|-]" >&2
  exit 1
fi
if [[ "$#" -lt 5 || "$#" -gt 6 ]]; then
  echo "Usage: sudo $0 ARTIFACT PRODUCT PLATFORM PACKAGE VERSION [GITHUB_URL|-]" >&2
  exit 1
fi

artifact="$1"
product="$2"
platform="$3"
package_kind="$4"
version="$5"
github_url="${6:--}"

/usr/local/libexec/mfw-download-gateway publish \
  --manifest /var/www/mfw-downloads/releases.json \
  --artifact-root /var/www/mfw-downloads \
  --artifact "$artifact" \
  --product "$product" \
  --platform "$platform" \
  --package "$package_kind" \
  --version "$version" \
  --github-url "$github_url"

curl -fsS http://127.0.0.1:8097/v1/mfw-site/releases >/dev/null
