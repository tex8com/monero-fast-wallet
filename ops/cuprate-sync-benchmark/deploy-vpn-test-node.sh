#!/usr/bin/env bash
# Deploy a separate, user-owned Stagenet Cuprate instance through WireGuard.
# It never modifies /opt/cuprate, /etc/cuprate, systemd, production ports, or
# the production data directory.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
remote_host="${CUPRATE_BENCHMARK_HOST:-private-ssh-host}"
remote_user="${CUPRATE_BENCHMARK_USER:-server}"
remote_root="${CUPRATE_BENCHMARK_ROOT:-/home/${remote_user}/cuprate-sync-benchmark}"
remote_source="${remote_root}/source"
remote_binary="${remote_root}/bin/cuprated"
remote_config="${remote_root}/Cuprated.toml"
bind_address="private-node-ip"

command -v ssh >/dev/null || { echo "ssh is required" >&2; exit 127; }
command -v rsync >/dev/null || { echo "rsync is required" >&2; exit 127; }
test -f "${repo_root}/node/cuprate/Cargo.toml" || {
  echo "run from monero-fast-wallet checkout" >&2; exit 2;
}

ssh -o BatchMode=yes "${remote_host}" "set -euo pipefail
  test -x \"\$HOME/.cargo/bin/cargo\"
  mkdir -p '${remote_root}/bin' '${remote_root}/logs'
  benchmark_running=0
  if test -f '${remote_root}/cuprated.pid' && kill -0 \"\$(cat '${remote_root}/cuprated.pid')\" 2>/dev/null; then
    if test \"${CUPRATE_BENCHMARK_REPLACE_RUNNING:-0}\" != 1; then
      echo 'benchmark node is running; set CUPRATE_BENCHMARK_REPLACE_RUNNING=1 to update it' >&2
      exit 1
    fi
    benchmark_running=1
  fi
  ip -o -4 addr show | grep -Fq '${bind_address}/'
  if test \"\$benchmark_running\" = 0; then
    for endpoint in ${bind_address}:48089 ${bind_address}:48091; do
      if ss -ltn | grep -q \"\$endpoint\"; then
        echo \"benchmark port already occupied: \$endpoint\" >&2
        exit 1
      fi
    done
  fi"

rsync -a --delete --exclude target --exclude .git \
  "${repo_root}/node/cuprate/" "${remote_host}:${remote_source}/"
rsync -a "${repo_root}/ops/cuprate-sync-benchmark/Cuprated.toml" \
  "${remote_host}:${remote_config}"

ssh -o BatchMode=yes "${remote_host}" "set -euo pipefail
  cd '${remote_source}'
  # Cuprate's constants build script embeds the current Git commit. The
  # benchmark source is intentionally a copied snapshot rather than a worktree,
  # so give that private copy an auditable local snapshot commit.
  if ! git rev-parse --verify HEAD >/dev/null 2>&1; then
    git init -q
    git add -A
    git -c user.name='Tex8 Benchmark Deployer' \\
      -c user.email='benchmark@localhost' commit -qm 'benchmark source snapshot'
  fi
  \"\$HOME/.cargo/bin/cargo\" build --release --package cuprated
  install -m 0755 target/release/cuprated '${remote_binary}'
  if test -f '${remote_root}/cuprated.pid'; then
    old_pid=\$(cat '${remote_root}/cuprated.pid')
    kill \"\$old_pid\" 2>/dev/null || true
  fi
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    ports_free=1
    for endpoint in ${bind_address}:48089 ${bind_address}:48091; do
      if ss -ltn | grep -q \"\$endpoint\"; then ports_free=0; fi
    done
    test \"\$ports_free\" = 1 && break
    sleep 1
  done
  test \"\$ports_free\" = 1 || { echo 'benchmark ports remain occupied after stopping old node' >&2; exit 1; }
  nohup '${remote_binary}' --config-file '${remote_config}' --skip-config-warning \\
    >'${remote_root}/logs/cuprated.stdout.log' 2>&1 < /dev/null &
  echo \$! >'${remote_root}/cuprated.pid'
  sleep 3
  kill -0 \"\$(cat '${remote_root}/cuprated.pid')\"
  ss -ltn | grep -F '${bind_address}:48089'
  ss -ltn | grep -F '${bind_address}:48091'
  curl -fsS --max-time 10 http://${bind_address}:48089/get_info >/dev/null
  echo 'benchmark node started'
  tail -n 30 '${remote_root}/logs/cuprated.stdout.log'"
