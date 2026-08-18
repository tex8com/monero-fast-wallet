#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: run-tex8-maintenance-window.sh EVIDENCE_DIR -- COMMAND [ARG ...]

Runs one explicitly approved command while the TEX8 application stack is
stopped, then restores and verifies the exact pre-window container and unit
sets. It never stops SSH, networking, or the system journal. Execution also
requires MFW_TEX8_MAINTENANCE=YES and passwordless sudo.
EOF
}

if [[ $# -lt 3 || "$2" != -- ]]; then
  usage
  exit 2
fi
evidence_dir="$1"
shift 2

if [[ "${MFW_TEX8_MAINTENANCE:-}" != YES ]]; then
  echo "execution requires MFW_TEX8_MAINTENANCE=YES" >&2
  exit 3
fi
if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  echo "TEX8 maintenance wrapper requires x86-64 Linux" >&2
  exit 3
fi
if [[ -e "${evidence_dir}" ]]; then
  echo "EVIDENCE_DIR must be a new path: ${evidence_dir}" >&2
  exit 3
fi
if ! sudo -n true; then
  echo "passwordless sudo is required" >&2
  exit 3
fi
miner_process_present() {
  ps -eo comm= | grep -Eq '^(xmrig|mfw-miner)'
}

if miner_process_present; then
  echo "pre-existing miner process detected" >&2
  exit 3
fi

app_units=(
  cron.service
  unattended-upgrades.service
  enthusiast-discovery.service
  enthusiast-v1.service
  fast-wallet-directory.service
  fast-wallet-relay.service
  fast-wallet-worker.service
  mariadb.service
  mfw-download-gateway.service
  monero-enthusiast-synapse.service
  monero-fast-node.service
  monero-news.service
  mongod.service
  nginx.service
  notification-gateway.service
  notification-registration-adapter.service
  ome-fridge.service
  payment-link-resolver.service
  php8.1-fpm.service
)

mkdir -p "${evidence_dir}"
containers_file="${evidence_dir}/containers-before.tsv"
units_file="${evidence_dir}/active-units-before.txt"
events_file="${evidence_dir}/maintenance-events.log"
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}' | sort >"${containers_file}"
for unit in "${app_units[@]}"; do
  if systemctl is-active --quiet "${unit}"; then
    echo "${unit}"
  fi
done >"${units_file}"

container_count="$(wc -l <"${containers_file}" | tr -d ' ')"
unit_count="$(wc -l <"${units_file}" | tr -d ' ')"
printf '%s preflight containers=%s active_units=%s\n' \
  "$(date -u +%FT%TZ)" "${container_count}" "${unit_count}" | tee -a "${events_file}"
if [[ "${container_count}" -lt 1 ]]; then
  echo "refusing a window without a recorded container set" >&2
  exit 3
fi

restored=0
restore() {
  local incoming_status="${1:-0}" restore_status=0 deadline bad running
  trap - EXIT INT TERM HUP
  set +e
  printf '%s restore-start incoming_status=%s\n' \
    "$(date -u +%FT%TZ)" "${incoming_status}" | tee -a "${events_file}"

  sudo -n systemctl start containerd.service docker.socket docker.service || restore_status=1
  deadline=$((SECONDS + 90))
  until docker info >/dev/null 2>&1; do
    if (( SECONDS >= deadline )); then
      echo "docker daemon did not become ready" | tee -a "${events_file}" >&2
      restore_status=1
      break
    fi
    sleep 1
  done

  if docker info >/dev/null 2>&1; then
    while IFS=$'\t' read -r name _; do
      [[ -n "${name}" ]] || continue
      if docker inspect "${name}" >/dev/null 2>&1; then
        docker start "${name}" >/dev/null || restore_status=1
      else
        echo "container will be recreated by its unit: ${name}" | tee -a "${events_file}"
      fi
    done <"${containers_file}"
  fi
  if [[ -s "${units_file}" ]]; then
    mapfile -t active_units <"${units_file}"
    sudo -n systemctl start "${active_units[@]}" || restore_status=1
  fi

  deadline=$((SECONDS + 180))
  while true; do
    running="$(docker ps --format '{{.Names}}' 2>/dev/null | wc -l | tr -d ' ')"
    bad="$(docker ps --format '{{.Status}}' 2>/dev/null | grep -Eci 'unhealthy|restarting|health: starting' || true)"
    docker ps --format '{{.Names}}' 2>/dev/null | sort >"${evidence_dir}/container-names-current.txt"
    cut -f1 "${containers_file}" >"${evidence_dir}/container-names-before.txt"
    if [[ "${running}" == "${container_count}" && "${bad}" == 0 ]] \
      && cmp -s "${evidence_dir}/container-names-before.txt" "${evidence_dir}/container-names-current.txt"; then
      break
    fi
    if (( SECONDS >= deadline )); then
      printf 'container restore verification failed: running=%s/%s bad=%s\n' \
        "${running}" "${container_count}" "${bad}" | tee -a "${events_file}" >&2
      restore_status=1
      break
    fi
    sleep 2
  done

  while IFS= read -r unit; do
    [[ -n "${unit}" ]] || continue
    if ! systemctl is-active --quiet "${unit}"; then
      echo "unit restore verification failed: ${unit}" | tee -a "${events_file}" >&2
      restore_status=1
    fi
  done <"${units_file}"
  if miner_process_present; then
    echo "miner residue detected after window" | tee -a "${events_file}" >&2
    restore_status=1
  fi
  docker ps --format '{{.Names}}\t{{.Status}}' | sort >"${evidence_dir}/containers-after.tsv" || true
  systemctl is-active containerd.service docker.service >"${evidence_dir}/runtime-after.txt" || restore_status=1
  printf '%s restore-finished status=%s\n' \
    "$(date -u +%FT%TZ)" "${restore_status}" | tee -a "${events_file}"
  restored=1
  if [[ "${restore_status}" != 0 ]]; then
    exit 20
  fi
  exit "${incoming_status}"
}
trap 'restore $?' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

mapfile -t container_names < <(cut -f1 "${containers_file}")
mapfile -t active_units <"${units_file}"
printf '%s stop-start\n' "$(date -u +%FT%TZ)" | tee -a "${events_file}"
docker stop --time 30 "${container_names[@]}" >/dev/null
if ((${#active_units[@]})); then
  sudo -n systemctl stop "${active_units[@]}"
fi
sudo -n systemctl stop docker.service docker.socket containerd.service
printf '%s workload-start command=%q\n' "$(date -u +%FT%TZ)" "$1" | tee -a "${events_file}"

"$@"
workload_status=$?
printf '%s workload-finished status=%s\n' \
  "$(date -u +%FT%TZ)" "${workload_status}" | tee -a "${events_file}"
restore "${workload_status}"
