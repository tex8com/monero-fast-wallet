#!/usr/bin/env bash
# Build-only release preparation. Never contacts or changes a running service.
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../../.." && pwd)"
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || {
  echo 'Settings self-test production release requires Linux x86-64.' >&2
  exit 69
}
build_root="${MFW_SELF_TEST_BUILD_ROOT:-$repo_root/build/settings-self-test-release}"
worker_build="$build_root/worker"
release_dir="$build_root/release"
install -d "$release_dir"
FAST_WALLET_WORKER_BUILD_ROOT="$worker_build" \
  "$repo_root/backend/fast-wallet-stack/deploy/build-fast-wallet-worker-epyc.sh"
# The Gateway has no EPYC matcher dependency and uses its own existing lock.
gateway_source="$worker_build/source-tree/backend/notification-gateway"
cp "$repo_root/backend/notification-gateway/Cargo.lock" "$gateway_source/Cargo.lock"
CARGO_TARGET_DIR="$build_root/gateway-target" cargo build \
  --manifest-path "$gateway_source/Cargo.toml" --bin notification-gateway --release --locked
relay_source="$worker_build/source-tree/backend/fast-wallet-relay"
cp "$repo_root/backend/fast-wallet-relay/Cargo.lock" "$relay_source/Cargo.lock"
CARGO_TARGET_DIR="$build_root/gateway-target" cargo build \
  --manifest-path "$relay_source/Cargo.toml" --bin fast-wallet-relay --release --locked
install -m 0755 "$worker_build/cargo-target/release/fast-wallet-worker" "$release_dir/fast-wallet-worker"
install -m 0755 "$build_root/gateway-target/release/notification-gateway" "$release_dir/notification-gateway"
install -m 0755 "$build_root/gateway-target/release/fast-wallet-relay" "$release_dir/fast-wallet-relay"
install -m 0644 "$repo_root/backend/fast-wallet-stack/deploy/nginx-fast-wallet-stack.conf" \
  "$release_dir/nginx-fast-wallet-stack.conf"
install -m 0644 "$repo_root/backend/notification-gateway/deploy/HOSTING-RELEASE.md" "$release_dir/RELEASE-INSTRUCTIONS.md"
install -m 0644 "$repo_root/backend/notification-gateway/deploy/HOSTING-ROLLBACK.md" "$release_dir/ROLLBACK-PLAN.md"
(
  cd "$repo_root"
  find backend/notification-gateway/src backend/fast-wallet-relay/src \
    backend/fast-wallet-worker/src backend/fast-wallet-worker/scanner-core/src \
    native/fast-wallet-protocol/src native/mfw-recipient-protocol/src native/scanpack-format/src \
    -type f -name '*.rs' -print0 | sort -z | xargs -0 sha256sum
  sha256sum backend/notification-gateway/{Cargo.toml,Cargo.lock} \
    backend/fast-wallet-relay/{Cargo.toml,Cargo.lock} \
    backend/fast-wallet-worker/Cargo.toml backend/fast-wallet-worker/scanner-core/{Cargo.toml,build.rs} \
    native/fast-wallet-protocol/{Cargo.toml,Cargo.lock,include/fast_wallet_protocol.h} \
    native/mfw-recipient-protocol/Cargo.toml native/scanpack-format/Cargo.toml \
    backend/fast-wallet-stack/deploy/{nginx-fast-wallet-stack.conf,build-fast-wallet-worker-epyc.sh} \
    backend/notification-gateway/deploy/{build-settings-self-test-release.sh,HOSTING-RELEASE.md,HOSTING-ROLLBACK.md} \
    backend/fast-wallet-stack/fast-wallet-worker.epyc.lock config/v1-release-features.json \
    third_party/curve25519-dalek-wallet-cpu/{upstream.lock,series}

) > "$release_dir/SOURCE-SHA256SUMS"
(
  cd "$release_dir"
  sha256sum fast-wallet-worker fast-wallet-relay notification-gateway nginx-fast-wallet-stack.conf \
    RELEASE-INSTRUCTIONS.md ROLLBACK-PLAN.md SOURCE-SHA256SUMS > SHA256SUMS
)
tar -C "$release_dir" -czf "$build_root/settings-self-test-linux-x86_64.tar.gz" \
  fast-wallet-worker fast-wallet-relay notification-gateway nginx-fast-wallet-stack.conf \
  RELEASE-INSTRUCTIONS.md ROLLBACK-PLAN.md SOURCE-SHA256SUMS SHA256SUMS
package_sha="$(sha256sum "$build_root/settings-self-test-linux-x86_64.tar.gz" | cut -d' ' -f1)"
immutable_package="$build_root/hosting-settings-linux-x86_64-${package_sha:0:20}.tar.gz"
if [[ -e "$immutable_package" ]]; then
  [[ "$(sha256sum "$immutable_package" | cut -d' ' -f1)" == "$package_sha" ]] || {
    echo 'An immutable package checksum collision was detected.' >&2
    exit 65
  }
else
  cp "$build_root/settings-self-test-linux-x86_64.tar.gz" "$immutable_package"
  chmod 0444 "$immutable_package"
fi
printf 'self_test_release=%s\n' "$immutable_package"
printf 'package_sha256=%s\n' "$package_sha"
printf 'Prepared only: no descriptor, credential, running service, or Node was changed.\n'
