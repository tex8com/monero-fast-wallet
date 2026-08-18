#!/usr/bin/env bash
# Run the strict AppImage build with a durable guest-side log. This is useful
# on a VM because the Parallels command channel intentionally detaches long
# compiles; the build result must remain inspectable afterwards.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
log_file="${MONERO_LINUX_RELEASE_LOG:-${HOME}/monero-fast-wallet-linux-release.log}"

mkdir -p "$(dirname "${log_file}")"
exec > >(tee -a "${log_file}") 2>&1
echo "[$(date -Is)] Starting strict Linux desktop bundle: $*"
exec "${script_dir}/build-bundle.sh" "$@"
