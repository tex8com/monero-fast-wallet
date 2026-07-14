#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
suite="${1:-local}"

case "${suite}" in
  local|full)
    ;;
  *)
    echo "Usage: $0 [local|full]" >&2
    exit 2
    ;;
esac

strict=0
if [[ "${suite}" == "full" || "${TESTBENCH_STRICT:-0}" == "1" ]]; then
  strict=1
fi

work_root="${TESTBENCH_WORK_ROOT:-${repo_root}/build/wallet-testbench}"
shell_build_dir="${TESTBENCH_SHELL_BUILD_DIR:-${work_root}/native-bridge-shell}"
default_funded_wallet_dir="${FUNDED_WALLET_DIR:-$HOME/Documents/Monero/tex8-send-tests}"
default_monero_source_dir="$HOME/Documents/Projects/monero-gui/monero"
default_monero_build_dir="${default_monero_source_dir}/build/tex8-wallet-api"
if [[ -d "/Volumes/4TB/monero-gui-build/tex8-wallet-api" ]]; then
  default_monero_build_dir="/Volumes/4TB/monero-gui-build/tex8-wallet-api"
fi

export MONERO_SOURCE_DIR="${MONERO_SOURCE_DIR:-${default_monero_source_dir}}"
export MONERO_BUILD_DIR="${MONERO_BUILD_DIR:-${default_monero_build_dir}}"

linked_build_dir="${BRIDGE_BUILD_DIR:-${repo_root}/build/native-bridge-monero}"
linked_runner="${linked_build_dir}/monero_wallet_bridge_smoke"
password="${TESTBENCH_WALLET_PASSWORD:-testbench-local-password}"

passes=0
failures=0
todos=0

log() {
  printf '%s\n' "$*"
}

pass_gate() {
  passes=$((passes + 1))
  log "ok - $1"
}

fail_gate() {
  failures=$((failures + 1))
  log "not ok - $1"
}

todo_gate() {
  todos=$((todos + 1))
  if [[ "${strict}" == "1" ]]; then
    fail_gate "$1 (missing required full-testbench gate)"
  else
    log "todo - $1"
  fi
}

run_gate() {
  local name="$1"
  shift

  log "gate: ${name}"
  if "$@"; then
    pass_gate "${name}"
  else
    fail_gate "${name}"
  fi
}

has_linked_runner() {
  [[ -x "${linked_runner}" ]]
}

build_linked_runner_if_possible() {
  if has_linked_runner; then
    return 0
  fi

  if [[ ! -f "${MONERO_BUILD_DIR}/lib/libwallet_api.a" ]]; then
    return 1
  fi

  (cd "${repo_root}" && native/monero-bridge/scripts/configure-local-monero-bridge.sh)
  cmake --build "${linked_build_dir}" --target monero_wallet_bridge_smoke
}

gate_pin_files() {
  grep -q "e7fe4ff6f0a0fef58ca031d2a75c168a42242b42" "${repo_root}/third_party/README.md" &&
    grep -q "ba354fde486d721502aeebf265b6005342b08128" "${repo_root}/third_party/README.md" &&
    grep -q "e7fe4ff6f0a0fef58ca031d2a75c168a42242b42" "${repo_root}/docs/SOURCES.md"
}

gate_shell_bridge_build() {
  cmake -S "${repo_root}/native/monero-bridge" -B "${shell_build_dir}"
  cmake --build "${shell_build_dir}" --target monero_wallet_bridge_smoke
  "${shell_build_dir}/monero_wallet_bridge_smoke" | grep -q "linked_with_monero=false"
}

gate_notify_scanner_tests() {
  cargo test --manifest-path "${repo_root}/services/notify-scanner/Cargo.toml"
}

gate_enthusiast_discovery_tests() {
  cargo test --manifest-path "${repo_root}/services/enthusiast-discovery/Cargo.toml"
}

gate_notify_scanner_worker_tests() {
  cargo test --manifest-path "${repo_root}/services/notify-scanner/Cargo.toml" scanner::tests::scanner_
}

gate_notify_scanner_mempool_tests() {
  cargo test --manifest-path "${repo_root}/services/notify-scanner/Cargo.toml" mempool
}

gate_notify_scanner_cuprate_adapter_tests() {
  cargo test --manifest-path "${repo_root}/services/notify-scanner/Cargo.toml" cuprate
}

gate_notify_scanner_live_cuprate_sources() {
  if [[ "${TESTBENCH_NOTIFY_SCANNER_LIVE_SOURCES:-0}" != "1" ]]; then
    return 2
  fi
  NOTIFY_SCANNER_TEST_GRPC_ENDPOINT="${CUPRATE_GRPC:-xmr.tex8.com:18091}" \
    NOTIFY_SCANNER_TEST_RPC_ENDPOINT="${CUPRATE_RPC:-xmr.tex8.com:18089}" \
    NOTIFY_SCANNER_TEST_FROM_HEIGHT="${TESTBENCH_NOTIFY_SCANNER_FROM_HEIGHT:-3000000}" \
    cargo test --manifest-path "${repo_root}/services/notify-scanner/Cargo.toml" live_cuprate -- --ignored
}

gate_cuprate_backend_compatibility() {
  local rpc="${CUPRATE_RPC:-xmr.tex8.com:18089}"
  local grpc="${CUPRATE_GRPC:-xmr.tex8.com:18091}"

  MONERO_WALLET_DAEMON_URL="${MONERO_WALLET_DAEMON_URL:-http://${rpc}}" \
    MONERO_WALLET_GRPC_ENDPOINT="${MONERO_WALLET_GRPC_ENDPOINT:-${grpc}}" \
    "${repo_root}/scripts/check-cuprate-backend.sh"
}

gate_deployed_scanner_api() {
  local scanner_url="${TESTBENCH_SCANNER_URL:-}"
  if [[ -z "${scanner_url}" ]]; then
    log "deployed_scanner_api_url=missing"
    if [[ "${TESTBENCH_REQUIRE_DEPLOYED_SCANNER:-0}" == "1" ]]; then
      return 1
    fi
    return 2
  fi

  scanner_url="${scanner_url%/}"
  log "deployed_scanner_api_url=${scanner_url}"
  local health
  if ! health="$(curl -fsS --max-time 8 "${scanner_url}/healthz" 2>&1)"; then
    log "deployed_scanner_api_error=${health}"
    return 1
  fi
  if ! printf '%s\n' "${health}" | grep -Eq '"status":"ok"|"ok":true'; then
    log "deployed_scanner_api_health=${health}"
    return 1
  fi
  log "deployed_scanner_api_health=${health}"
}

gate_mobile_unit_tests() {
  if [[ ! -d "${repo_root}/apps/mobile/node_modules" ]]; then
    return 2
  fi
  (cd "${repo_root}/apps/mobile" && npm test -- --runInBand)
}

gate_native_offline_roundtrip() {
  build_linked_runner_if_possible || return 2
  local workdir="${work_root}/offline-roundtrip"
  rm -rf "${workdir}"
  mkdir -p "${workdir}"
  "${linked_runner}" self-test-offline stagenet "${workdir}" "${password}" |
    grep -q "proof_result=pass"
}

gate_cuprate_refresh() {
  build_linked_runner_if_possible || return 2
  local rpc="${CUPRATE_RPC:-xmr.tex8.com:18089}"
  local grpc="${CUPRATE_GRPC:-xmr.tex8.com:18091}"
  local workdir="${work_root}/cuprate-refresh"
  rm -rf "${workdir}"
  mkdir -p "${workdir}"
  "${linked_runner}" self-test-offline mainnet "${workdir}" "${password}" >/dev/null
  "${linked_runner}" refresh mainnet "${workdir}/software-a" "${password}" "${rpc}" "${grpc}" 5 |
    grep -q "daemon_height="
}

gate_fast_wallet_restore_height_refresh() {
  build_linked_runner_if_possible || return 2
  local rpc="${CUPRATE_RPC:-xmr.tex8.com:18089}"
  local grpc="${CUPRATE_GRPC:-xmr.tex8.com:18091}"
  local workdir="${work_root}/fast-wallet-restore-height"
  rm -rf "${workdir}"
  mkdir -p "${workdir}"

  local create_output
  create_output="$(
    "${linked_runner}" self-test-offline mainnet "${workdir}" "${password}"
  )"
  local restore_height
  restore_height="$(
    printf '%s\n' "${create_output}" |
      awk -F= '$1 == "fast_receive_restore_height" { print $2; exit }'
  )"
  if [[ -z "${restore_height}" || ! "${restore_height}" =~ ^[0-9]+$ ||
        "${restore_height}" -le 1 ]]; then
    return 1
  fi

  local daemon_height
  daemon_height="$(
    curl -fsS --max-time 8 "http://${rpc}/get_info" |
      sed -n 's/.*"height"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' |
      head -1
  )"
  if [[ -z "${daemon_height}" || ! "${daemon_height}" =~ ^[0-9]+$ ||
        "${restore_height}" -gt "${daemon_height}" ]]; then
    return 1
  fi

  local test_restore_height="${daemon_height}"
  if [[ "${test_restore_height}" -gt 10 ]]; then
    test_restore_height=$((test_restore_height - 10))
  fi

  local refresh_output
  refresh_output="$(
    "${linked_runner}" refresh mainnet \
      "${workdir}/fast-receive-0" \
      "${password}" \
      "${rpc}" \
      "${grpc}" \
      1 \
      "${test_restore_height}"
  )"
  printf '%s\n' "${refresh_output}" | grep -q "synchronized=true" || return 1
  printf '%s\n' "${refresh_output}" |
    grep -q "requested_restore_height=${test_restore_height}"
}

gate_official_node_refresh() {
  build_linked_runner_if_possible || return 2
  if [[ -z "${OFFICIAL_MONERO_RPC:-}" ]]; then
    return 2
  fi
  local workdir="${work_root}/official-refresh"
  rm -rf "${workdir}"
  mkdir -p "${workdir}"
  "${linked_runner}" self-test-offline mainnet "${workdir}" "${password}" >/dev/null
  "${linked_runner}" refresh mainnet "${workdir}/software-a" "${password}" "${OFFICIAL_MONERO_RPC}" "-" 5 |
    grep -q "daemon_height="
}

password_arg() {
  local password_value="$1"
  local password_file="$2"

  if [[ -n "${password_file}" ]]; then
    printf '@%s' "${password_file}"
  else
    printf '%s' "${password_value}"
  fi
}

extract_field() {
  local field="$1"
  awk -F= -v wanted="${field}" '$1 == wanted { print substr($0, length($1) + 2); exit }'
}

gate_real_send() {
  build_linked_runner_if_possible || return 2
  if [[ "${TESTBENCH_ALLOW_REAL_SEND:-0}" != "1" ||
        -z "${TESTBENCH_SEND_AMOUNT_ATOMIC:-}" ]]; then
    return 2
  fi

  local source_wallet="${TESTBENCH_SEND_SOURCE_WALLET:-}"
  local source_password_file="${TESTBENCH_SEND_PASSWORD_FILE:-}"
  local destination_wallet="${TESTBENCH_SEND_DEST_WALLET:-}"
  local destination_password_file="${TESTBENCH_SEND_DEST_PASSWORD_FILE:-}"

  if [[ -z "${source_wallet}" &&
        -f "${default_funded_wallet_dir}/wallet-a" &&
        -f "${default_funded_wallet_dir}/wallet-a.pass" ]]; then
    source_wallet="${default_funded_wallet_dir}/wallet-a"
    source_password_file="${default_funded_wallet_dir}/wallet-a.pass"
  fi
  if [[ -z "${destination_wallet}" &&
        -f "${default_funded_wallet_dir}/wallet-b" &&
        -f "${default_funded_wallet_dir}/wallet-b.pass" ]]; then
    destination_wallet="${default_funded_wallet_dir}/wallet-b"
    destination_password_file="${default_funded_wallet_dir}/wallet-b.pass"
  fi

  if [[ -z "${source_wallet}" ]]; then
    return 2
  fi

  if [[ -z "${TESTBENCH_SEND_PASSWORD:-}" &&
        -z "${source_password_file}" ]]; then
    return 2
  fi

  local rpc="${CUPRATE_RPC:-xmr.tex8.com:18089}"
  local grpc="${CUPRATE_GRPC:-xmr.tex8.com:18091}"
  local source_password_arg
  source_password_arg="$(
    password_arg \
      "${TESTBENCH_SEND_PASSWORD:-}" \
      "${source_password_file}"
  )"
  local destination_address="${TESTBENCH_SEND_DEST_ADDRESS:-}"
  local destination_password_arg=""

  if [[ -n "${destination_wallet}" ]]; then
    if [[ -z "${TESTBENCH_SEND_DEST_PASSWORD:-}" &&
          -z "${destination_password_file}" ]]; then
      return 2
    fi
    destination_password_arg="$(
      password_arg \
        "${TESTBENCH_SEND_DEST_PASSWORD:-}" \
        "${destination_password_file}"
    )"
    if [[ -z "${destination_address}" ]]; then
      destination_address="$(
        "${linked_runner}" address mainnet \
          "${destination_wallet}" \
          "${destination_password_arg}" |
          extract_field "address"
      )"
    fi
  fi

  if [[ -z "${destination_address}" ]]; then
    if [[ "${TESTBENCH_SEND_CREATE_DESTINATION:-1}" != "1" ]]; then
      return 2
    fi
    destination_wallet="${work_root}/real-send-destination/wallet"
    rm -rf "${work_root}/real-send-destination"
    mkdir -p "${work_root}/real-send-destination"
    destination_password_arg="${password}"
    destination_address="$(
      "${linked_runner}" create mainnet \
        "${destination_wallet}" \
        "${destination_password_arg}" |
        extract_field "address"
    )"
  fi

  if [[ -z "${destination_address}" ]]; then
    return 1
  fi

  local refresh_output
  refresh_output="$(
    "${linked_runner}" refresh mainnet \
      "${source_wallet}" \
      "${source_password_arg}" \
      "${rpc}" \
      "${grpc}" \
      "${TESTBENCH_SEND_PREFLIGHT_REFRESH_SECONDS:-6}"
  )"
  local unlocked_balance
  unlocked_balance="$(printf '%s\n' "${refresh_output}" | extract_field "unlocked_balance_atomic")"
  if [[ -z "${unlocked_balance}" || ! "${unlocked_balance}" =~ ^[0-9]+$ ]]; then
    return 1
  fi
  local required_unlocked=$((TESTBENCH_SEND_AMOUNT_ATOMIC + ${TESTBENCH_SEND_MIN_FEE_ATOMIC:-100000000}))
  if (( unlocked_balance < required_unlocked )); then
    log "real_send_skip_reason=insufficient_unlocked_balance"
    log "real_send_skipped_unlocked_balance_atomic=${unlocked_balance}"
    log "real_send_required_unlocked_atomic=${required_unlocked}"
    return 2
  fi

  local send_output
  send_output="$(
    "${linked_runner}" send mainnet \
    "${source_wallet}" \
      "${source_password_arg}" \
    "${rpc}" \
    "${grpc}" \
      "${destination_address}" \
      "${TESTBENCH_SEND_AMOUNT_ATOMIC}"
  )"
  printf '%s\n' "${send_output}" |
    grep -E '^(prepare_status|prepare_error|fee_atomic|tx_count|commit_status|commit_error|txid)=' >&2 || true

  printf '%s\n' "${send_output}" | grep -q "commit_status=ok" || return 1
  local txid
  txid="$(printf '%s\n' "${send_output}" | extract_field "txid")"
  if [[ -z "${txid}" ]]; then
    return 1
  fi
  log "real_send_txid=${txid}"

  if [[ -z "${destination_wallet}" ]]; then
    return 2
  fi

  local visibility_output
  visibility_output="$(
    "${linked_runner}" wait-tx mainnet \
      "${destination_wallet}" \
      "${destination_password_arg}" \
      "${rpc}" \
      "${grpc}" \
      "${txid}" \
      "${TESTBENCH_SEND_VISIBILITY_ATTEMPTS:-12}" \
      "${TESTBENCH_SEND_VISIBILITY_SECONDS:-5}"
  )"
  printf '%s\n' "${visibility_output}" >&2
  printf '%s\n' "${visibility_output}" | grep -q "tx_seen=true"
  printf '%s\n' "${visibility_output}" | grep -q "tx_match_count=1"
  log "real_send_destination_seen=true"
}

gate_ledger_probe() {
  build_linked_runner_if_possible || return 2
  if [[ "${TESTBENCH_LEDGER:-0}" != "1" ]]; then
    return 2
  fi
  local workdir="${work_root}/ledger"
  rm -rf "${workdir}"
  mkdir -p "${workdir}"
  "${linked_runner}" ledger-probe mainnet "${workdir}/ledger-wallet" "${password}" Ledger |
    grep -q "connected=true"
}

gate_android_runtime() {
  if [[ "${TESTBENCH_ANDROID_DEVICE:-0}" != "1" ]]; then
    return 2
  fi
  (cd "${repo_root}/apps/mobile/android" &&
    ./gradlew :app:connectedDebugAndroidTest \
      -PreactNativeArchitectures=arm64-v8a \
      -PmoneroWalletBridgeWithMonero=true \
      -PmoneroSourceDir="${MONERO_SOURCE_DIR}" \
      -PmoneroWalletLinkRoot="${repo_root}/build/android-monero-link-manifests")
}

gate_ios_runtime() {
  if [[ "${TESTBENCH_IOS_SIMULATOR:-0}" != "1" ]]; then
    return 2
  fi
  (cd "${repo_root}/apps/mobile" && npm run ios:diagnostics)
}

handle_gate_result() {
  local name="$1"
  shift

  set +e
  "$@"
  local code=$?
  set -e

  if [[ "${code}" == "0" ]]; then
    pass_gate "${name}"
  elif [[ "${code}" == "2" ]]; then
    todo_gate "${name}"
  else
    fail_gate "${name}"
  fi
}

mkdir -p "${work_root}"

log "wallet-core-testbench suite=${suite} strict=${strict}"

handle_gate_result "fork pins recorded" gate_pin_files
handle_gate_result "native bridge shell build" gate_shell_bridge_build
handle_gate_result "notify-scanner unit/store tests" gate_notify_scanner_tests
handle_gate_result "enthusiast discovery privacy/API tests" gate_enthusiast_discovery_tests
handle_gate_result "notify-scanner block worker tests" gate_notify_scanner_worker_tests
handle_gate_result "notify-scanner mempool worker tests" gate_notify_scanner_mempool_tests
handle_gate_result "notify-scanner Cuprate adapter tests" gate_notify_scanner_cuprate_adapter_tests
handle_gate_result "notify-scanner live Cuprate source tests" gate_notify_scanner_live_cuprate_sources
handle_gate_result "Cuprate backend RPC compatibility" gate_cuprate_backend_compatibility
handle_gate_result "deployed Fast Receive scanner API" gate_deployed_scanner_api
handle_gate_result "mobile TypeScript/unit tests" gate_mobile_unit_tests
handle_gate_result "native linked offline create/seed/restore/fast-receive" gate_native_offline_roundtrip
handle_gate_result "Cuprate RPC+gRPC refresh smoke" gate_cuprate_refresh
handle_gate_result "Fast Wallet restore-height cache reset" gate_fast_wallet_restore_height_refresh
handle_gate_result "official Monero RPC compatibility refresh smoke" gate_official_node_refresh
handle_gate_result "real send over Cuprate RPC+gRPC" gate_real_send
handle_gate_result "Ledger Nano native probe" gate_ledger_probe
handle_gate_result "Android runtime bridge smoke" gate_android_runtime
handle_gate_result "iOS runtime bridge diagnostics" gate_ios_runtime

log "summary: pass=${passes} fail=${failures} todo=${todos}"

if [[ "${failures}" != "0" ]]; then
  exit 1
fi
