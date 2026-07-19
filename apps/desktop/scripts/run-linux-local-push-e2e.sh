#!/bin/sh
# Local-only E2E harness: gateway -> Linux background agent -> DBus notification.
# This does not access the public server, Nginx, or a wallet.
set -eu

ROOT="${1:-/media/psf/4TB/monero-fast-wallet-ubuntu-test/apps/desktop}"
export PATH="$HOME/.cargo/bin:$PATH"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/$(id -u)/bus}"
export MONERO_FAST_WALLETD="$ROOT/src-tauri/target/release/monero-fast-walletd"
export MONERO_LINUX_PUSH_SERVICE_URL="http://127.0.0.1:8097/api/v1/notifications"
export MONERO_LINUX_PUSH_INSTALLATION_ID="mwp_linux_e2e_20260719_a1b2c3d4"

exec node "$ROOT/scripts/test-linux-notification-agent-e2e.mjs"
