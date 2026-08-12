#!/usr/bin/env bash
# Run one explicit, non-broadcasting physical-Android Mainnet scan benchmark.
# The instrumentation test creates its own temporary zero-balance wallet and
# never opens the installed production wallet.
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/android-common.sh"

run_id="${1:?usage: $0 <unique-run-id>}"
[[ "$run_id" =~ ^[A-Za-z0-9._-]+$ ]] || {
  echo "Unsafe run id: ${run_id}" >&2
  exit 2
}

external_root="${MONERO_WALLET_ANDROID_EXTERNAL_BUILD_ROOT:-/Volumes/4TB/monero-fast-wallet-build}"
MONERO_COMMON_CORE_BUILD_ROOT="${external_root}" \
  source "${REPO_ROOT}/native/monero-bridge/scripts/prepare-common-monero-core.sh"
result_root="${MONERO_ANDROID_BENCHMARK_RESULT_ROOT:-${external_root}/mobile-mainnet-benchmarks}"
result_dir="${result_root}/${run_id}"
remote_dir="/srv/monero-fast-wallet/benchmark-logs/${run_id}"
app_build_dir="${MONERO_WALLET_ANDROID_BUILD_DIR:-${external_root}/mobile-android-benchmark-build}"
monero_source="${MONERO_SOURCE_DIR}"
link_root="${MONERO_WALLET_LINK_ROOT:-${external_root}/android-monero-link-manifests-${MONERO_COMMON_CORE_TREE}}"
fast_wallet_protocol_root="${MONERO_FAST_WALLET_PROTOCOL_ROOT:-${external_root}/mobile-fast-wallet-protocol}"
community_harrier_root="${MONERO_COMMUNITY_HARRIER_ROOT:-${external_root}/mobile-community-harrier}"
community_matrix_root="${MONERO_COMMUNITY_MATRIX_ROOT:-${external_root}/mobile-community-matrix}"
community_asset_root="${MONERO_COMMUNITY_ASSET_ROOT:-${external_root}/community-v1-release-assets}"
community_harrier_library="${community_harrier_root}/android-arm64/libtex8_community_harrier_runtime.so"
community_harrier_jni="${community_harrier_root}/jni"
community_matrix_library="${community_matrix_root}/android-arm64/libcommunity_matrix_core.a"
app_id="${MONERO_WALLET_ANDROID_BENCHMARK_APP_ID:-com.tex8.monerowallet.benchmark}"
rpc="${MONERO_WALLET_ANDROID_BENCHMARK_RPC:-152.53.133.188:18089}"
grpc="${MONERO_WALLET_ANDROID_BENCHMARK_GRPC:-152.53.133.188:18091}"
restore_height="${MONERO_WALLET_ANDROID_BENCHMARK_RESTORE_HEIGHT:-3577876}"
timeout_seconds="${MONERO_WALLET_ANDROID_BENCHMARK_TIMEOUT_SECONDS:-1800}"
ssh_target="${MONERO_WALLET_ANDROID_BENCHMARK_SSH_TARGET:-tex8}"
adb_bin="$(resolve_adb)"
device="$(select_android_device "$adb_bin")"
gradle_user_home="${MONERO_WALLET_GRADLE_USER_HOME:-${external_root}/mobile-gradle-user-home}"
project_cache="${MONERO_WALLET_ANDROID_PROJECT_CACHE_DIR:-${external_root}/mobile-android-project-cache}"
android_tmp="${MONERO_WALLET_ANDROID_TMPDIR:-${external_root}/mobile-android-tmp}"

[[ ! -e "$result_dir" ]] || {
  echo "Result directory already exists: ${result_dir}" >&2
  exit 2
}
[[ "$restore_height" =~ ^[1-9][0-9]*$ ]] || {
  echo "Invalid restore height: ${restore_height}" >&2
  exit 2
}
[[ "$timeout_seconds" =~ ^[1-9][0-9]*$ ]] || {
  echo "Invalid timeout: ${timeout_seconds}" >&2
  exit 2
}
[[ -d "$monero_source" ]] || {
  echo "Authenticated Monero source is missing: ${monero_source}" >&2
  exit 2
}
[[ -f "${link_root}/android-arm64/link.cmake" ]] || {
  echo "Authenticated Android link manifest is missing: ${link_root}/android-arm64/link.cmake" >&2
  exit 2
}
[[ -f "${fast_wallet_protocol_root}/android-arm64/libfast_wallet_protocol.a" ]] || {
  echo "Android Fast Wallet protocol archive is missing: ${fast_wallet_protocol_root}" >&2
  exit 2
}
for packaged_community_asset in \
  "$community_harrier_library" \
  "$community_matrix_library"; do
  [[ -f "$packaged_community_asset" ]] || {
    echo "Android Community benchmark asset is missing: ${packaged_community_asset}" >&2
    exit 2
  }
done
[[ -d "$community_harrier_jni" && -d "$community_asset_root" ]] || {
  echo "Android Community benchmark asset directories are missing" >&2
  exit 2
}

mkdir -p "$result_dir" "$gradle_user_home" "$project_cache" "$android_tmp"
umask 077

rpc_host="${rpc%:*}"
rpc_port="${rpc##*:}"
grpc_host="${grpc%:*}"
grpc_port="${grpc##*:}"

# This is deliberately checked on the phone itself. A successful host-side
# tunnel or proxy must not make a direct product endpoint appear reachable.
if ! "$adb_bin" -s "$device" shell \
  "toybox nc -z -w 5 '$rpc_host' '$rpc_port'" >/dev/null 2>&1; then
  echo "Pixel cannot reach Bin-RPC directly: ${rpc}. No benchmark was started." >&2
  exit 3
fi
if ! "$adb_bin" -s "$device" shell \
  "toybox nc -z -w 5 '$grpc_host' '$grpc_port'" >/dev/null 2>&1; then
  echo "Pixel cannot reach gRPC directly: ${grpc}. No benchmark was started." >&2
  exit 3
fi

started_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
{
  printf 'run_id=%s\n' "$run_id"
  printf 'purpose=physical Android packaged Fast Wallet plus ScanPack Mainnet benchmark\n'
  printf 'started_utc=%s\n' "$started_utc"
  printf 'device_serial=%s\n' "$device"
  printf 'device_model='
  "$adb_bin" -s "$device" shell getprop ro.product.model
  printf 'device_name='
  "$adb_bin" -s "$device" shell getprop ro.product.device
  printf 'android_release='
  "$adb_bin" -s "$device" shell getprop ro.build.version.release
  printf 'android_sdk='
  "$adb_bin" -s "$device" shell getprop ro.build.version.sdk
  printf 'abi='
  "$adb_bin" -s "$device" shell getprop ro.product.cpu.abi
  printf 'online_processors='
  "$adb_bin" -s "$device" shell getconf _NPROCESSORS_ONLN
  printf 'cpu_online='
  "$adb_bin" -s "$device" shell cat /sys/devices/system/cpu/online
  printf 'rpc_endpoint=%s\n' "$rpc"
  printf 'grpc_endpoint=%s\n' "$grpc"
  printf 'proxy=none; endpoints preflighted directly on device\n'
  printf 'restore_height=%s\n' "$restore_height"
  printf 'timeout_seconds=%s\n' "$timeout_seconds"
  printf 'application_id=%s\n' "$app_id"
  printf 'production_wallet_accessed=false\n'
  printf 'temporary_wallet=generated locally, zero-balance, deleted by test finally block\n'
  printf 'monero_source=%s\n' "$monero_source"
  printf 'monero_source_tree=%s\n' "$(git -C "$monero_source" write-tree)"
  printf 'link_manifest=%s\n' "${link_root}/android-arm64/link.cmake"
  shasum -a 256 "${link_root}/android-arm64/link.cmake"
  printf 'product_repo_commit=%s\n' "$(git -C "$REPO_ROOT" rev-parse HEAD)"
  printf 'cuprate_preflight:\n'
  ssh -n "$ssh_target" \
    'date -u +%Y-%m-%dT%H:%M:%SZ; systemctl is-active cuprate.service; systemctl show cuprate.service -p MainPID -p MemoryCurrent -p CPUUsageNSec --no-pager; sha256sum /opt/cuprate/cuprated; find /var/lib/cuprate/wallet-scan-cache-100k -maxdepth 1 -type f -name "*.mwsp" | wc -l; du -sb /var/lib/cuprate/wallet-scan-cache-100k'
} >"${result_dir}/preflight.txt"

server_monitor_started=0
device_log_pid=""

cleanup() {
  if [[ -n "$device_log_pid" ]]; then
    kill "$device_log_pid" >/dev/null 2>&1 || true
    wait "$device_log_pid" >/dev/null 2>&1 || true
  fi
  if [[ "$server_monitor_started" == "1" ]]; then
    ssh -n "$ssh_target" "touch '${remote_dir}/STOP'" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

"$adb_bin" -s "$device" logcat -c || true
"$adb_bin" -s "$device" logcat -v threadtime >"${result_dir}/device-logcat.txt" 2>&1 &
device_log_pid="$!"

ssh "$ssh_target" bash -s -- "$remote_dir" <<'REMOTE' >"${result_dir}/remote-monitor-start.txt"
set -u
r="$1"
mkdir -p "$r/system"
: >"$r/collector.log"
(
  i=0
  while [[ ! -e "$r/STOP" ]]; do
    stamp="$(date +%s%N)"
    pid="$(systemctl show -p MainPID --value cuprate.service 2>/dev/null || true)"
    {
      date -u +%Y-%m-%dT%H:%M:%S.%NZ
      cat "/proc/$pid/stat" 2>/dev/null || true
      cat "/proc/$pid/status" 2>/dev/null || true
      cat "/proc/$pid/io" 2>/dev/null || true
      cat /proc/loadavg
      cat /proc/meminfo
      cat /proc/vmstat
    } >"$r/system/${i}-${stamp}.process-and-memory" 2>&1
    cat /proc/diskstats >"$r/system/${i}-${stamp}.diskstats" 2>&1 || true
    cat /proc/net/dev >"$r/system/${i}-${stamp}.netdev" 2>&1 || true
    cat /proc/net/netstat >"$r/system/${i}-${stamp}.netstat" 2>&1 || true
    cat /proc/net/snmp >"$r/system/${i}-${stamp}.snmp" 2>&1 || true
    ss -tinm '( sport = :48091 or sport = :18089 )' \
      >"$r/system/${i}-${stamp}.wallet-tcp" 2>&1 || true
    nstat -az >"$r/system/${i}-${stamp}.nstat" 2>&1 || true
    i=$((i + 1))
    sleep 1
  done
) >>"$r/collector.log" 2>&1 &
printf '%s\n' "$!" >"$r/monitor.pid"
printf 'monitor_pid=%s\nstarted_utc=%s\n' "$(cat "$r/monitor.pid")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
REMOTE
server_monitor_started=1

export GRADLE_USER_HOME="$gradle_user_home"
export TMPDIR="$android_tmp"

set +e
(
  cd "$ANDROID_DIR"
  ./gradlew \
    :app:connectedDebugAndroidTest \
    --project-cache-dir="$project_cache" \
    -PreactNativeArchitectures=arm64-v8a \
    -PmoneroWalletExternalBuildDir="$app_build_dir" \
    -PmoneroWalletApplicationId="$app_id" \
    -PmoneroSkipGoogleServices=true \
    -PmoneroFastWalletProtocolRoot="$fast_wallet_protocol_root" \
    -PmoneroCommunityMatrixLibrary="$community_matrix_library" \
    -PmoneroCommunityHarrierLibrary="$community_harrier_library" \
    -PmoneroCommunityHarrierJniLibs="$community_harrier_jni" \
    -PmoneroCommunityAssetRoot="$community_asset_root" \
    -PmoneroWalletBridgeWithMonero=true \
    -PmoneroSourceDir="$monero_source" \
    -PmoneroWalletLinkRoot="$link_root" \
    -Pandroid.testInstrumentationRunnerArguments.class=com.monerowallet.NativeMoneroWalletMainnetBenchmarkTest \
    -Pandroid.testInstrumentationRunnerArguments.runMainnetBenchmark=true \
    -Pandroid.testInstrumentationRunnerArguments.restoreHeight="$restore_height" \
    -Pandroid.testInstrumentationRunnerArguments.timeoutSeconds="$timeout_seconds" \
    -Pandroid.testInstrumentationRunnerArguments.daemon="$rpc" \
    -Pandroid.testInstrumentationRunnerArguments.grpc="$grpc"
) >"${result_dir}/gradle.log" 2>&1
test_status=$?
set -e

finished_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
kill "$device_log_pid" >/dev/null 2>&1 || true
wait "$device_log_pid" >/dev/null 2>&1 || true
device_log_pid=""

ssh -n "$ssh_target" "touch '${remote_dir}/STOP'"
sleep 2
server_monitor_started=0
ssh "$ssh_target" bash -s -- "$remote_dir" "$started_utc" <<'REMOTE' >"${result_dir}/server-artifacts.txt"
set -u
r="$1"
started="$2"
sudo -n /usr/bin/journalctl -u cuprate.service --since "$started" --no-pager \
  >"$r/service-journal.log" 2>&1 || true
tar -C "$r" -czf "$r/system.tar.gz" system
sha256sum "$r/collector.log" "$r/service-journal.log" "$r/system.tar.gz" \
  >"$r/artifact-sha256.txt"
find "$r" -maxdepth 1 -type f -printf '%p\n' | sort
REMOTE

scp -q "${ssh_target}:${remote_dir}/collector.log" "${result_dir}/server-collector.log"
scp -q "${ssh_target}:${remote_dir}/service-journal.log" "${result_dir}/server-service-journal.log"
scp -q "${ssh_target}:${remote_dir}/system.tar.gz" "${result_dir}/server-system.tar.gz"
scp -q "${ssh_target}:${remote_dir}/artifact-sha256.txt" "${result_dir}/server-artifact-sha256.txt"

find "$app_build_dir/outputs/androidTest-results/connected/debug" \
  -type f \( -name 'TEST-*.xml' -o -name 'logcat-*.txt' -o -name 'test-results.log' \) \
  -exec cp {} "$result_dir/" \; 2>/dev/null || true

{
  printf 'finished_utc=%s\n' "$finished_utc"
  printf 'test_exit_status=%s\n' "$test_status"
  printf 'benchmark_lines:\n'
  grep 'MONERO_WALLET_MAINNET_BENCHMARK' "${result_dir}/device-logcat.txt" || true
} >"${result_dir}/result-summary.txt"

(
  cd "$result_dir"
  shasum -a 256 ./* >artifact-sha256.txt
)

printf 'result_dir=%s\ntest_status=%s\n' "$result_dir" "$test_status"
exit "$test_status"
