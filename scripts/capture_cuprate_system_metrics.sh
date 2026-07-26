#!/usr/bin/env bash
# Capture raw, once-per-second Linux telemetry during one wallet-sync run.
# The script deliberately retains full /proc and ss snapshots so a later
# investigation is not limited to metrics we happened to anticipate today.
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "usage: $0 <cuprated-pid> <output-directory> [seconds]" >&2
  exit 64
fi

metric_pid="$1"
metric_dir="$2"
metric_seconds="${3:-3600}"
mkdir -p "$metric_dir"

metric_end=$(( $(date +%s) + metric_seconds ))
metric_sample=0
# `server` intentionally has no signal permission for the `cuprate` service
# account; checking /proc preserves that isolation while still detecting exit.
while [[ -d "/proc/$metric_pid" ]] && (( $(date +%s) < metric_end )); do
  metric_stamp="$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)"
  metric_prefix="$metric_dir/${metric_sample}-$(date +%s%N)"

  {
    printf 'timestamp_utc=%s\n' "$metric_stamp"
    printf 'pid=%s\n' "$metric_pid"
    cat "/proc/$metric_pid/stat" 2>/dev/null || true
    cat "/proc/$metric_pid/status" 2>/dev/null || true
    cat "/proc/$metric_pid/io" 2>/dev/null || true
    cat /proc/loadavg
    cat /proc/meminfo
    cat /proc/vmstat
  } > "${metric_prefix}.process-and-memory"

  cat /proc/diskstats > "${metric_prefix}.diskstats"
  cat /proc/net/dev > "${metric_prefix}.netdev"
  cat /proc/net/netstat > "${metric_prefix}.netstat"
  cat /proc/net/snmp > "${metric_prefix}.snmp"
  # Capture both wallet-facing transports. 48091 is the fast-wallet gRPC
  # stream; 18089 is the upstream-compatible Bin RPC path. Keeping them in
  # one raw snapshot lets the same collector serve every comparison column.
  ss -tin '( sport = :48091 or sport = :18089 )' > "${metric_prefix}.wallet-tcp" 2>&1 || true
  nstat -n > "${metric_prefix}.nstat" 2>&1 || true

  printf '%s %s\n' "$metric_stamp" "$metric_prefix" >> "$metric_dir/manifest.log"
  metric_sample=$((metric_sample + 1))
  sleep 1
done
