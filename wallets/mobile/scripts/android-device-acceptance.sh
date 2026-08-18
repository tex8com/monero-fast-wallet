#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
driver="$script_dir/android-ui-driver.py"
serial="${ANDROID_SERIAL:-}"
timestamp="$(date -u '+%Y%m%dT%H%M%SZ')"
output="${1:-/tmp/mfw-android-acceptance/$timestamp}"

driver_args=()
adb_args=()
if [[ -n "$serial" ]]; then
  driver_args+=(--serial "$serial")
  adb_args+=(-s "$serial")
fi

run_driver() {
  python3 "$driver" "${driver_args[@]}" "$@"
}

mkdir -p "$output"
adb "${adb_args[@]}" logcat -c

run_driver status | tee "$output/00-status.json"
run_driver launch | tee "$output/01-launch.txt"
run_driver snapshot --name 01-launch --output "$output"

cat <<EOF
Physical-device acceptance capture initialized:
  $output

Authenticate with the device biometric prompt if Android requests it.
After authentication, individual screen actions can be driven with:
  python3 $driver ${serial:+--serial "$serial"} tap --text "Menu"
  python3 $driver ${serial:+--serial "$serial"} snapshot --name menu --output "$output"
EOF
