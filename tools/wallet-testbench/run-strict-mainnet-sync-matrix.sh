#!/usr/bin/env bash
# Run one strict Original/Fast/ScanPack Mainnet matrix at one frozen Cuprate tip.
# The production configuration is restored on every exit path.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
matrix_id="${1:-$(date -u +%Y%m%dT%H%M%SZ)-r1}"
[[ "${matrix_id}" =~ ^[A-Za-z0-9._-]+$ ]] || {
  echo "unsafe matrix id" >&2
  exit 2
}

restore_height="${STRICT_MATRIX_RESTORE_HEIGHT:-3577876}"
timeout_seconds="${STRICT_MATRIX_TIMEOUT_SECONDS:-1800}"
rpc="${STRICT_MATRIX_RPC:-xmr.tex8.com:18089}"
grpc="${STRICT_MATRIX_GRPC:-xmr.tex8.com:18091}"
original_runner="${STRICT_MATRIX_ORIGINAL_RUNNER:-/Volumes/4TB/monero-fast-wallet-build/native-bridge-monero-upstream-instrumented-static/monero_wallet_original_restore_benchmark}"
product_runner="${STRICT_MATRIX_PRODUCT_RUNNER:-/Volumes/4TB/monero-fast-wallet-build/wallet-testbench/reference-ledger-9cf448b0/monero_wallet_bridge_smoke}"
base="${repo_root}/build/wallet-testbench/jan-2026-mainnet"
matrix_dir="${base}/strict-matrix-${matrix_id}"
remote_backup="/srv/monero-fast-wallet/cuprate-strict-matrix-${matrix_id}.original.toml"
remote_config="/etc/cuprate/cuprated.toml"
remote_firewall_comment="mfw-strict-matrix-${matrix_id}"
restored=0

[[ "${restore_height}" =~ ^[1-9][0-9]*$ ]] || { echo "invalid restore height" >&2; exit 2; }
[[ "${timeout_seconds}" =~ ^[1-9][0-9]*$ ]] || { echo "invalid timeout" >&2; exit 2; }
[[ -x "${original_runner}" ]] || { echo "original runner missing" >&2; exit 2; }
[[ -x "${product_runner}" ]] || { echo "product runner missing" >&2; exit 2; }
[[ ! -e "${matrix_dir}" ]] || { echo "matrix directory already exists" >&2; exit 2; }
# This matrix freezes the server tip by changing and restarting Cuprate. It
# must never do so by accident: explicit user approval is required outside the
# script, then represented by this one-shot opt-in at invocation time.
[[ "${STRICT_MATRIX_ALLOW_CUPRATE_CONFIGURATION:-0}" == "1" ]] || {
  echo "REFUSED: strict matrix changes Cuprate configuration; explicit approval required" >&2
  exit 3
}

umask 077
mkdir -p "${matrix_dir}"
original_sha="$(shasum -a 256 "${original_runner}" | awk '{print $1}')"
product_sha="$(shasum -a 256 "${product_runner}" | awk '{print $1}')"

query_tip() {
  curl -fsS --max-time 10 "http://${rpc}/get_info" |
    node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(String(JSON.parse(s).height)))"
}

wait_for_rpc() {
  local attempt
  for attempt in $(seq 1 90); do
    if query_tip >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "Cuprate RPC did not become ready" >&2
  return 1
}

restore_server() {
  if [[ "${restored}" == 1 ]]; then
    return 0
  fi
  ssh -o BatchMode=yes tex8 bash -s -- \
    "${remote_backup}" "${remote_config}" "${remote_firewall_comment}" <<'REMOTE'
set -euo pipefail
backup="$1"
config="$2"
firewall_comment="$3"
config_restored=0
if [[ -f "$backup" ]]; then
  sudo -n /usr/bin/tee "$config" <"$backup" >/dev/null
  rm -f "$backup"
  config_restored=1
fi
while sudo -n /usr/sbin/iptables -C OUTPUT \
    -m owner --uid-owner cuprate -m conntrack --ctstate NEW \
    ! -d 127.0.0.0/8 -m comment --comment "$firewall_comment" \
    -j REJECT 2>/dev/null; do
  sudo -n /usr/sbin/iptables -D OUTPUT \
    -m owner --uid-owner cuprate -m conntrack --ctstate NEW \
    ! -d 127.0.0.0/8 -m comment --comment "$firewall_comment" \
    -j REJECT
done
if [[ "$config_restored" == "1" ]]; then
  sudo -n systemctl restart monero-fast-node.service
fi
REMOTE
  restored=1
}

cleanup() {
  status=$?
  set +e
  restore_server
  wait_for_rpc
  exit "${status}"
}
trap cleanup EXIT INT TERM

ssh -o BatchMode=yes tex8 "test ! -e '${remote_backup}' && cp '${remote_config}' '${remote_backup}' && chmod 600 '${remote_backup}'"

# Cuprate's current P2P implementation requires a positive outbound buffer.
# Freeze the already committed chain by rejecting only NEW non-loopback
# connections from the dedicated cuprate service UID. Existing public
# RPC/gRPC replies are ESTABLISHED traffic and remain available. The exact
# tagged rule is removed by restore_server on every exit path.
ssh -o BatchMode=yes tex8 bash -s -- "${remote_firewall_comment}" <<'REMOTE'
set -euo pipefail
firewall_comment="$1"
if sudo -n /usr/sbin/iptables -C OUTPUT \
    -m owner --uid-owner cuprate -m conntrack --ctstate NEW \
    ! -d 127.0.0.0/8 -m comment --comment "$firewall_comment" \
    -j REJECT 2>/dev/null; then
  echo "strict matrix firewall rule already exists" >&2
  exit 1
fi
sudo -n /usr/sbin/iptables -I OUTPUT 1 \
  -m owner --uid-owner cuprate -m conntrack --ctstate NEW \
  ! -d 127.0.0.0/8 -m comment --comment "$firewall_comment" \
  -j REJECT
REMOTE

install_frozen_config() {
  local cache_enabled="$1"
  ssh -o BatchMode=yes tex8 bash -s -- "${remote_backup}" "${remote_config}" "${cache_enabled}" <<'REMOTE'
set -euo pipefail
source_config="$1"
target_config="$2"
cache_enabled="$3"
tmp="$(mktemp /srv/monero-fast-wallet/cuprate-strict-matrix-config.XXXXXX)"
awk -v cache_enabled="$cache_enabled" '
  /^\[p2p\.clear_net\]$/ {
    in_p2p=1; in_scanpack=0
    print
    # Keep the internal Cuprate P2P buffer positive. The tagged owner firewall
    # rule blocks actual new non-loopback P2P connections for the matrix.
    print "outbound_connections = 1"
    print "extra_outbound_connections = 0"
    print "max_inbound_connections = 0"
    next
  }
  /^\[rpc\.wallet_scan_cache\]$/ {
    in_p2p=0; in_scanpack=1
    print
    next
  }
  /^\[/ { in_p2p=0; in_scanpack=0 }
  in_p2p && /^enable_inbound[[:space:]]*=/ { print "enable_inbound = false"; next }
  in_p2p && /^(outbound_connections|extra_outbound_connections|max_inbound_connections)[[:space:]]*=/ { next }
  in_scanpack && /^enable[[:space:]]*=/ { print "enable = " cache_enabled; next }
  { print }
' "$source_config" >"$tmp"
sudo -n /usr/bin/tee "$target_config" <"$tmp" >/dev/null
rm -f "$tmp"
sudo -n systemctl restart monero-fast-node.service
REMOTE
  wait_for_rpc
}

run_variant() {
  local variant="$1" run_id="$2" runner="$3" runner_sha="$4" grpc_endpoint="$5"
  R3_NETWORK_RUNNER="${runner}" \
  R3_NETWORK_CREDENTIAL="@ephemeral" \
  R3_NETWORK_RESTORE_HEIGHT="${restore_height}" \
  R3_NETWORK_RPC="${rpc}" \
  R3_NETWORK_GRPC="${grpc_endpoint}" \
  R3_NETWORK_TIMEOUT_SECONDS="${timeout_seconds}" \
  R3_NETWORK_EXPECTED_RUNNER_SHA256="${runner_sha}" \
  R3_NETWORK_EXPECTED_TIP="${frozen_tip}" \
    "${repo_root}/tools/wallet-testbench/run-r3-network-mainnet.sh" \
      "${variant}" "${run_id}"
}

install_frozen_config true
frozen_tip="$(query_tip)"
sleep 5
[[ "$(query_tip)" == "${frozen_tip}" ]] || {
  echo "chain tip moved despite frozen P2P configuration" >&2
  exit 3
}

{
  printf 'matrix_id=%s\nrestore_height=%s\nfrozen_tip=%s\n' \
    "${matrix_id}" "${restore_height}" "${frozen_tip}"
  printf 'started_utc=%s\noriginal_runner=%s\noriginal_runner_sha256=%s\n' \
    "$(date -u +%FT%TZ)" "${original_runner}" "${original_sha}"
  printf 'product_runner=%s\nproduct_runner_sha256=%s\n' \
    "${product_runner}" "${product_sha}"
  printf 'server_original_config_sha256=%s\n' \
    "$(ssh -o BatchMode=yes tex8 "sha256sum '${remote_backup}'" | awk '{print $1}')"
  printf 'comparison_order=scanpack,fast,original\n'
} >"${matrix_dir}/matrix-metadata.txt"

scanpack_id="strict-${matrix_id}-scanpack"
fast_id="strict-${matrix_id}-fast"
original_id="strict-${matrix_id}-original"

run_variant scanpack "${scanpack_id}" "${product_runner}" "${product_sha}" "${grpc}"
[[ "$(query_tip)" == "${frozen_tip}" ]] || { echo "tip changed after ScanPack run" >&2; exit 3; }

install_frozen_config false
[[ "$(query_tip)" == "${frozen_tip}" ]] || { echo "tip changed while disabling ScanPack" >&2; exit 3; }
run_variant fast "${fast_id}" "${product_runner}" "${product_sha}" "${grpc}"
[[ "$(query_tip)" == "${frozen_tip}" ]] || { echo "tip changed after Fast run" >&2; exit 3; }
run_variant original "${original_id}" "${original_runner}" "${original_sha}" -
[[ "$(query_tip)" == "${frozen_tip}" ]] || { echo "tip changed after Original run" >&2; exit 3; }

for run_id in "${scanpack_id}" "${fast_id}" "${original_id}"; do
  printf '%s\t%s\n' "${run_id}" "${base}/${run_id}" >>"${matrix_dir}/runs.tsv"
done
printf 'finished_utc=%s\nfinal_frozen_tip=%s\n' "$(date -u +%FT%TZ)" "$(query_tip)" >>"${matrix_dir}/matrix-metadata.txt"

restore_server
wait_for_rpc
printf 'restored_tip=%s\n' "$(query_tip)" >>"${matrix_dir}/matrix-metadata.txt"
(
  cd "${matrix_dir}"
  shasum -a 256 matrix-metadata.txt runs.tsv >artifact-sha256.txt
)

echo "matrix_dir=${matrix_dir}"
echo "frozen_tip=${frozen_tip}"
