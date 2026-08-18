#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 4 || $# -gt 5 ]]; then
  echo "usage: $0 BINARY OUTPUT_PREFIX RANDOMX_VERSION REPLAY_ITERATIONS [PROGRAMS]" >&2
  exit 2
fi
if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo "profile-macos.sh requires an Apple Silicon Mac" >&2
  exit 2
fi

binary="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
prefix="$2"
version="$3"
iterations="$4"
programs="${5:-1}"
template="${MFW_XCTRACE_TEMPLATE:-CPU Counters}"

if [[ ! -x "$binary" ]]; then
  echo "binary is not executable: $binary" >&2
  exit 2
fi
if [[ "$version" != 1 && "$version" != 2 ]]; then
  echo "RANDOMX_VERSION must be 1 or 2" >&2
  exit 2
fi
if [[ ! "$iterations" =~ ^[1-9][0-9]*$ || "$iterations" -gt 1000000 ]]; then
  echo "REPLAY_ITERATIONS must be in range 1..1000000" >&2
  exit 2
fi
if [[ ! "$programs" =~ ^[1-9][0-9]*$ || "$programs" -gt 1000000 ]]; then
  echo "PROGRAMS must be in range 1..1000000" >&2
  exit 2
fi

map_path="${prefix}.ndjson"
trace_path="${prefix}.trace"
stdout_path="${prefix}.stdout.txt"
toc_path="${prefix}.toc.xml"
samples_path="${prefix}.samples.xml"
profile_json_path="${prefix}.profile.json"
profile_md_path="${prefix}.profile.md"
for path in "$map_path" "$trace_path" "$stdout_path" "$toc_path" "$samples_path" "$profile_json_path" "$profile_md_path"; do
  if [[ -e "$path" ]]; then
    echo "refusing to overwrite existing output: $path" >&2
    exit 3
  fi
done

mkdir -p "$(dirname "$prefix")"
echo "MFW JIT replay profile: template=$template RandomX=v$version programs=$programs iterations=$iterations/program"
echo "The profiler entrypoint is offline and exits before normal miner/network initialization."

xcrun xctrace record \
  --template "$template" \
  --no-prompt \
  --output "$trace_path" \
  --target-stdout "$stdout_path" \
  --launch -- "$binary" \
  --jit-corpus-profile "$map_path" \
  --jit-corpus-version "$version" \
  --jit-corpus-programs "$programs" \
  --jit-corpus-replay "$iterations"

xcrun xctrace export --input "$trace_path" --toc --output "$toc_path"
python3 "$(dirname "$0")/analyze.py" "$map_path"

if [[ "$template" == "Time Profiler" ]]; then
  xcrun xctrace export \
    --input "$trace_path" \
    --xpath '/trace-toc/run[@number="1"]/data/table[@schema="time-profile"]' \
    --output "$samples_path"
  python3 "$(dirname "$0")/analyze-xctrace.py" \
    "$map_path" "$samples_path" --toc "$toc_path" \
    --json "$profile_json_path" \
    --markdown "$profile_md_path"
fi

shasum -a 256 "$binary" "$map_path" "$toc_path"
