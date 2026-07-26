#!/usr/bin/env bash
# Runs selected synthetic reliable-transport profiles serially over TEX8's
# public IP. All logical streams share one physical connection per protocol,
# matching the wallet's intended streaming design.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
host="${TRANSPORT_BENCH_SSH_HOST:-private-ssh-host}"
public_ip="${TRANSPORT_BENCH_PUBLIC_IP:-152.53.133.188}"
duration="${TRANSPORT_BENCH_DURATION:-20s}"
connection_levels="${TRANSPORT_BENCH_CONNECTIONS:-1 2 4 8 16}"
stream_levels="${TRANSPORT_BENCH_STREAMS_PER_CONNECTION:-1 4 16}"
# gRPC/HTTP2 is the product transport. HTTP/3 remains available only when
# explicitly requested for a separate experiment.
protocols="${TRANSPORT_BENCH_PROTOCOLS:-grpc}"
repetitions="${TRANSPORT_BENCH_REPETITIONS:-3}"
result_dir="${TRANSPORT_BENCH_RESULTS_DIR:-${root}/../../build/wallet-testbench/transport-results/$(date -u +%Y%m%dT%H%M%SZ)}"
remote_bin="${TRANSPORT_BENCH_REMOTE_BIN:-/srv/monero-fast-wallet/transport-protocol-bench}"
local_bin="${TRANSPORT_BENCH_LOCAL_BIN:-${root}/transport-protocol-bench}"

mkdir -p "${result_dir}"
printf 'protocol\tdirection\tconnections\tstreams_per_connection\ttotal_streams\tsample\tresult\n' >"${result_dir}/summary.tsv"

for protocol in ${protocols}; do
  if [[ "${protocol}" == "grpc" || "${protocol}" == "http3" || "${protocol}" == "utp" ]]; then
    port=48091
  else
    port=48089
  fi

  remote_pid="$(ssh -o BatchMode=yes "${host}" "nohup '${remote_bin}' -mode server -protocol '${protocol}' -addr '${public_ip}:${port}' >'/srv/monero-fast-wallet/transport-${protocol}.log' 2>&1 < /dev/null & echo \$!")"
  trap 'ssh -o BatchMode=yes "${host}" "kill '"${remote_pid}"' 2>/dev/null || true"' RETURN
  sleep 2

  for direction in download upload; do
    for connections in ${connection_levels}; do
      for streams in ${stream_levels}; do
        for sample in $(seq 1 "${repetitions}"); do
          total_streams=$((connections * streams))
          line="$("${local_bin}" -mode client -protocol "${protocol}" -addr "${public_ip}:${port}" -direction "${direction}" -connections "${connections}" -streams "${streams}" -duration "${duration}" 2>&1 || true)"
          printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "${protocol}" "${direction}" "${connections}" "${streams}" "${total_streams}" "${sample}" "${line}" >>"${result_dir}/summary.tsv"
          printf '%s\n' "${line}"
        done
      done
    done
  done

  ssh -o BatchMode=yes "${host}" "kill '${remote_pid}' 2>/dev/null || true"
  trap - RETURN
done

echo "results_dir=${result_dir}"
