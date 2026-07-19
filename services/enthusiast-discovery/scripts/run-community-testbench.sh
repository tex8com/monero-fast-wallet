#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
service_dir="${repo_root}/services/enthusiast-discovery"
suite="${1:-local}"
node_test="${service_dir}/scripts/community-api-test.mjs"

case "$suite" in
  local|live|full)
    ;;
  *)
    echo "Usage: $0 [local|live|full]" >&2
    exit 2
    ;;
esac

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

for command in cargo curl node openssl lsof; do
  require_command "$command"
done

run_local_http_contract() (
  local port="${TESTBENCH_COMMUNITY_PORT:-18189}"
  local workdir
  workdir="$(mktemp -d "${TMPDIR:-/tmp}/monero-community-testbench.XXXXXX")"
  local database="${workdir}/community.json.enc"
  local logfile="${workdir}/service.log"
  local run_id="local$(date +%s)"
  local binary="${service_dir}/target/release/enthusiast-discovery"
  local pid=""

  cleanup_local() {
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
    rm -rf "$workdir"
  }
  trap cleanup_local EXIT

  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Community test port $port is already in use. Set TESTBENCH_COMMUNITY_PORT." >&2
    return 1
  fi

  cargo build --quiet --release --manifest-path "${service_dir}/Cargo.toml"
  ENTHUSIAST_DISCOVERY_BIND="127.0.0.1:${port}" \
    ENTHUSIAST_DISCOVERY_DB="$database" \
    ENTHUSIAST_DISCOVERY_STORAGE_KEY="$(openssl rand -hex 32)" \
    "$binary" >"$logfile" 2>&1 &
  pid="$!"

  for _ in $(seq 1 40); do
    if curl -fsS --max-time 1 "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1; then
      break
    fi
    sleep 0.25
  done
  if ! curl -fsS --max-time 1 "http://127.0.0.1:${port}/healthz" >/dev/null; then
    cat "$logfile" >&2
    return 1
  fi

  node "$node_test" --base-url "http://127.0.0.1:${port}" --mode local --run-id "$run_id"
  test -s "$database"
  if grep -aq "Automated Community acceptance test\|Automated message\|Automated test report" "$database"; then
    echo "Community database contains readable acceptance-test content." >&2
    return 1
  fi
  echo "ok - encrypted local Community database and binary HTTP contract"
)

run_live_http_contract() {
  local url="${TESTBENCH_COMMUNITY_URL:-https://xmr.tex8.com/community}"
  if [[ "${TESTBENCH_ALLOW_COMMUNITY_LIVE:-0}" != "1" ]]; then
    echo "Live Community test requires TESTBENCH_ALLOW_COMMUNITY_LIVE=1." >&2
    return 2
  fi
  node "$node_test" --base-url "$url" --mode live --run-id "live$(date +%s)"
}

case "$suite" in
  local)
    run_local_http_contract
    ;;
  live)
    run_live_http_contract
    ;;
  full)
    cargo test --release --manifest-path "${service_dir}/Cargo.toml"
    run_local_http_contract
    if [[ "${TESTBENCH_COMMUNITY_URL:-}" ]]; then
      run_live_http_contract
    else
      echo "todo - set TESTBENCH_COMMUNITY_URL and TESTBENCH_ALLOW_COMMUNITY_LIVE=1 for the live Community contract"
    fi
    ;;
esac
