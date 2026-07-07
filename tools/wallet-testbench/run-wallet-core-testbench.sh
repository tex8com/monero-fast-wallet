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
  local rpc="${CUPRATE_RPC:-tex8.com:18089}"
  local grpc="${CUPRATE_GRPC:-tex8.com:18091}"
  local workdir="${work_root}/cuprate-refresh"
  rm -rf "${workdir}"
  mkdir -p "${workdir}"
  "${linked_runner}" self-test-offline mainnet "${workdir}" "${password}" >/dev/null
  "${linked_runner}" refresh mainnet "${workdir}/software-a" "${password}" "${rpc}" "${grpc}" 5 |
    grep -q "daemon_height="
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

gate_real_send() {
  build_linked_runner_if_possible || return 2
  if [[ "${TESTBENCH_ALLOW_REAL_SEND:-0}" != "1" ||
        -z "${TESTBENCH_SEND_SOURCE_WALLET:-}" ||
        -z "${TESTBENCH_SEND_PASSWORD:-}" ||
        -z "${TESTBENCH_SEND_DEST_ADDRESS:-}" ||
        -z "${TESTBENCH_SEND_AMOUNT_ATOMIC:-}" ]]; then
    return 2
  fi

  local rpc="${CUPRATE_RPC:-tex8.com:18089}"
  local grpc="${CUPRATE_GRPC:-tex8.com:18091}"
  "${linked_runner}" send mainnet \
    "${TESTBENCH_SEND_SOURCE_WALLET}" \
    "${TESTBENCH_SEND_PASSWORD}" \
    "${rpc}" \
    "${grpc}" \
    "${TESTBENCH_SEND_DEST_ADDRESS}" \
    "${TESTBENCH_SEND_AMOUNT_ATOMIC}" |
    grep -q "commit_status=ok"
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
handle_gate_result "mobile TypeScript/unit tests" gate_mobile_unit_tests
handle_gate_result "native linked offline create/seed/restore/fast-receive" gate_native_offline_roundtrip
handle_gate_result "Cuprate RPC+gRPC refresh smoke" gate_cuprate_refresh
handle_gate_result "official Monero RPC compatibility refresh smoke" gate_official_node_refresh
handle_gate_result "real send over Cuprate RPC+gRPC" gate_real_send
handle_gate_result "Ledger Nano native probe" gate_ledger_probe
handle_gate_result "Android runtime bridge smoke" gate_android_runtime
handle_gate_result "iOS runtime bridge diagnostics" gate_ios_runtime

log "summary: pass=${passes} fail=${failures} todo=${todos}"

if [[ "${failures}" != "0" ]]; then
  exit 1
fi
