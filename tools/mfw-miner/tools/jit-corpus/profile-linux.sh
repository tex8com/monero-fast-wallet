#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 4 || $# -gt 5 ]]; then
  echo "usage: $0 BINARY OUTPUT_PREFIX RANDOMX_VERSION REPLAY_ITERATIONS [PROGRAMS]" >&2
  exit 2
fi
if [[ "$(uname -s)" != Linux ]]; then
  echo "profile-linux.sh requires Linux" >&2
  exit 2
fi
case "$(uname -m)" in
  x86_64|aarch64) ;;
  *) echo "profile-linux.sh requires x86_64 or aarch64" >&2; exit 2 ;;
esac
if ! command -v perf >/dev/null 2>&1; then
  echo "perf is required; this script never installs packages or uses sudo" >&2
  exit 2
fi

binary="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
prefix="$2"
version="$3"
iterations="$4"
programs="${5:-1}"
period="${MFW_PERF_SAMPLE_PERIOD:-100000}"

if [[ ! -x "$binary" ]]; then
  echo "binary is not executable: $binary" >&2
  exit 2
fi
if [[ "$version" != 1 && "$version" != 2 ]]; then
  echo "RANDOMX_VERSION must be 1 or 2" >&2
  exit 2
fi
for value_name in iterations programs; do
  value="${!value_name}"
  if [[ ! "$value" =~ ^[1-9][0-9]*$ || "$value" -gt 1000000 ]]; then
    echo "$value_name must be in range 1..1000000" >&2
    exit 2
  fi
done
if [[ ! "$period" =~ ^[1-9][0-9]*$ || "$period" -gt 1000000000 ]]; then
  echo "MFW_PERF_SAMPLE_PERIOD must be in range 1..1000000000" >&2
  exit 2
fi

map_path="${prefix}.ndjson"
data_path="${prefix}.perf.data"
script_path="${prefix}.perf-script.txt"
stdout_path="${prefix}.stdout.txt"
profile_json_path="${prefix}.profile.json"
profile_md_path="${prefix}.profile.md"
for path in "$map_path" "$data_path" "$script_path" "$stdout_path" "$profile_json_path" "$profile_md_path"; do
  if [[ -e "$path" ]]; then
    echo "refusing to overwrite existing output: $path" >&2
    exit 3
  fi
done

mkdir -p "$(dirname "$prefix")"
echo "MFW JIT replay profile: perf cycles:u RandomX=v$version programs=$programs iterations=$iterations/program"
echo "The profiler entrypoint is offline and exits before normal miner/network initialization."

# `perf script -F time,ip` timestamps use CLOCK_MONOTONIC on Linux, matching the
# steady_clock timestamps written into the NDJSON replay events. No privilege,
# service, MSR, huge-page, or kernel-setting change is attempted here.
perf record \
  --event cycles:u \
  --count "$period" \
  --output "$data_path" \
  -- "$binary" \
  --jit-corpus-profile "$map_path" \
  --jit-corpus-version "$version" \
  --jit-corpus-programs "$programs" \
  --jit-corpus-replay "$iterations" \
  >"$stdout_path"

perf script --input "$data_path" --fields time,ip >"$script_path"
python3 "$(dirname "$0")/analyze.py" "$map_path" >/dev/null
python3 "$(dirname "$0")/analyze-perf.py" \
  "$map_path" "$script_path" \
  --json "$profile_json_path" \
  --markdown "$profile_md_path"

sha256sum "$binary" "$map_path" "$data_path" "$script_path"
