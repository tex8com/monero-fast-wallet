#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
protocol_dir="$repo_root/native/mfw-recipient-protocol"
cuprate_dir="$repo_root/node/mfn-monero-fast-node"
mobile_dir="$repo_root/wallets/mobile"
result_dir="${MFW_SECURITY_RESULT_DIR:-$repo_root/test-results/mfw-recipient-security}"
run_id="$(date -u +%Y%m%dT%H%M%SZ)"
run_dir="$result_dir/$run_id"

mkdir -p "$run_dir"

{
  echo "run_id=$run_id"
  echo "started_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "host=$(hostname)"
  echo "os=$(uname -a)"
  echo "rustc=$(rustc --version)"
  echo "cargo=$(cargo --version)"
  echo "git_commit=$(git -C "$repo_root" rev-parse HEAD)"
  echo "git_branch=$(git -C "$repo_root" branch --show-current)"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    echo "hardware_model=$(sysctl -n hw.model)"
    echo "cpu_brand=$(sysctl -n machdep.cpu.brand_string)"
    echo "logical_cpu=$(sysctl -n hw.logicalcpu)"
    echo "physical_cpu=$(sysctl -n hw.physicalcpu)"
    echo "memory_bytes=$(sysctl -n hw.memsize)"
  fi
} >"$run_dir/environment.txt"

{
  find \
    "$protocol_dir" \
    "$repo_root/native/fast-wallet-protocol" \
    "$repo_root/backend/mfw-private-directory" \
    "$repo_root/node/mfn-monero-fast-node/binaries/cuprated/src/mfw_name_index.rs" \
    "$repo_root/node/mfn-monero-fast-node/binaries/cuprated/proto/cuprate_stream.proto" \
    "$mobile_dir/src/services/PrivateRecipientResolution.ts" \
    "$mobile_dir/src/services/MfwNameResolverClient.ts" \
    "$mobile_dir/src/services/MfwNameResolutionService.ts" \
    "$mobile_dir/src/services/PrivatePhoneDirectoryClient.ts" \
    "$mobile_dir/src/services/PrivatePhoneConsentRegistry.ts" \
    "$mobile_dir/src/services/PrivatePhoneDeviceContacts.ts" \
    "$repo_root/config/v1-release-features.json" \
    "$repo_root/scripts/test-v1-release-contract.mjs" \
    "$repo_root/packages/wallet-shared/src/v1ReleaseFeatures.ts" \
    "$mobile_dir/specs/NativeMoneroWallet.ts" \
    "$mobile_dir/android/app/build.gradle" \
    "$mobile_dir/android/app/src/main/AndroidManifest.xml" \
    "$mobile_dir/android/app/src/main/cpp/NativeMoneroWalletJni.cpp" \
    "$mobile_dir/android/app/src/main/java/com/monerowallet/NativeMoneroWalletModule.kt" \
    "$mobile_dir/ios/MoneroWallet.xcodeproj/project.pbxproj" \
    "$mobile_dir/ios/MoneroWallet/Info.plist" \
    "$mobile_dir/ios/MoneroWallet/NativeMoneroWallet/RCTNativeMoneroWallet.mm" \
    "$mobile_dir/ios/Podfile" \
    "$mobile_dir/ios/Podfile.lock" \
    "$repo_root/native/fast-wallet-protocol/include/fast_wallet_protocol.h" \
    "$repo_root/native/fast-wallet-protocol/src/lib.rs" \
    "$repo_root/native/monero-bridge/cpp/FastWalletProtocolBridge.h" \
    "$mobile_dir/src/services/__tests__/PrivateRecipientResolution.test.ts" \
    "$mobile_dir/src/services/__tests__/MfwNameResolverClient.test.ts" \
    "$mobile_dir/src/services/__tests__/MfwNameResolutionService.test.ts" \
    "$mobile_dir/src/services/__tests__/PrivatePhoneDirectoryClient.test.ts" \
    "$mobile_dir/src/services/__tests__/PrivatePhoneConsentRegistry.test.ts" \
    "$mobile_dir/src/services/__tests__/PrivatePhoneDeviceContacts.test.ts" \
    -type f ! -path '*/target/*' -print0 |
    sort -z |
    xargs -0 shasum -a 256
} >"$run_dir/source-sha256.txt"

run_timed() {
  local name="$1"
  shift
  local start end status
  start="$(date +%s)"
  set +e
  if [[ "$(uname -s)" == "Darwin" ]]; then
    /usr/bin/time -l "$@" >"$run_dir/$name.stdout.log" 2>"$run_dir/$name.stderr.log"
  else
    /usr/bin/time -v "$@" >"$run_dir/$name.stdout.log" 2>"$run_dir/$name.stderr.log"
  fi
  status=$?
  set -e
  end="$(date +%s)"
  {
    echo "command=$*"
    echo "started_epoch=$start"
    echo "ended_epoch=$end"
    echo "wall_seconds=$((end - start))"
    echo "exit_code=$status"
  } >"$run_dir/$name.measurement.txt"
  if [[ "$status" -ne 0 ]]; then
    echo "FAILED: $name (see $run_dir)" >&2
    exit "$status"
  fi
}

run_timed protocol_tests cargo test --locked --offline --manifest-path "$protocol_dir/Cargo.toml" --all-targets
run_timed protocol_clippy cargo clippy --locked --offline --manifest-path "$protocol_dir/Cargo.toml" --all-targets -- -D warnings
run_timed protocol_release_bench cargo run --locked --offline --manifest-path "$protocol_dir/Cargo.toml" --release --bin security_bench
if [[ "${MFW_SECURITY_CLEAN_TARGETS:-1}" == "1" ]]; then
  cargo clean --manifest-path "$protocol_dir/Cargo.toml" >>"$run_dir/cleanup.log" 2>&1
fi
run_timed native_ffi_tests cargo test --locked --offline --manifest-path "$repo_root/native/fast-wallet-protocol/Cargo.toml" --all-targets
run_timed native_ffi_clippy cargo clippy --locked --offline --manifest-path "$repo_root/native/fast-wallet-protocol/Cargo.toml" --all-targets -- -D warnings
if [[ "${MFW_SECURITY_CLEAN_TARGETS:-1}" == "1" ]]; then
  cargo clean --manifest-path "$repo_root/native/fast-wallet-protocol/Cargo.toml" >>"$run_dir/cleanup.log" 2>&1
fi
run_timed private_service_tests cargo test --locked --offline --manifest-path "$repo_root/backend/mfw-private-directory/Cargo.toml" --all-targets
run_timed private_service_clippy cargo clippy --locked --offline --manifest-path "$repo_root/backend/mfw-private-directory/Cargo.toml" --all-targets -- -D warnings
if [[ "${MFW_SECURITY_CLEAN_TARGETS:-1}" == "1" ]]; then
  cargo clean --manifest-path "$repo_root/backend/mfw-private-directory/Cargo.toml" >>"$run_dir/cleanup.log" 2>&1
fi
run_timed release_contract node --test "$repo_root/scripts/test-v1-release-contract.mjs"
run_timed mobile_recipient_tests npm --prefix "$mobile_dir" test -- --runInBand src/services/__tests__/PrivateRecipientResolution.test.ts src/services/__tests__/MfwNameResolverClient.test.ts src/services/__tests__/MfwNameResolutionService.test.ts src/services/__tests__/PrivatePhoneDirectoryClient.test.ts src/services/__tests__/PrivatePhoneConsentRegistry.test.ts src/services/__tests__/PrivatePhoneDeviceContacts.test.ts
run_timed mobile_recipient_lint npm --prefix "$mobile_dir" exec -- eslint "$mobile_dir/src/services/PrivateRecipientResolution.ts" "$mobile_dir/src/services/MfwNameResolverClient.ts" "$mobile_dir/src/services/MfwNameResolutionService.ts" "$mobile_dir/src/services/PrivatePhoneDirectoryClient.ts" "$mobile_dir/src/services/PrivatePhoneConsentRegistry.ts" "$mobile_dir/src/services/PrivatePhoneDeviceContacts.ts" "$mobile_dir/src/services/__tests__/PrivateRecipientResolution.test.ts" "$mobile_dir/src/services/__tests__/MfwNameResolverClient.test.ts" "$mobile_dir/src/services/__tests__/MfwNameResolutionService.test.ts" "$mobile_dir/src/services/__tests__/PrivatePhoneDirectoryClient.test.ts" "$mobile_dir/src/services/__tests__/PrivatePhoneConsentRegistry.test.ts" "$mobile_dir/src/services/__tests__/PrivatePhoneDeviceContacts.test.ts"
run_timed cuprate_compile cargo check --locked --offline --manifest-path "$cuprate_dir/Cargo.toml" -p cuprated
if [[ "${MFW_SECURITY_CLEAN_TARGETS:-1}" == "1" ]]; then
  cargo clean --manifest-path "$cuprate_dir/Cargo.toml" >>"$run_dir/cleanup.log" 2>&1
fi

cp "$run_dir/protocol_release_bench.stdout.log" "$run_dir/benchmark.json"
date -u +%Y-%m-%dT%H:%M:%SZ >"$run_dir/completed_utc.txt"
echo "$run_dir"
