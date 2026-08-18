#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: with-epyc-hugepages.sh EVIDENCE_DIR REQUIRED_2M_PAGES -- COMMAND [ARG ...]" >&2
}

if [[ $# -lt 4 || "$3" != -- ]]; then
  usage
  exit 2
fi
evidence_dir="$1"
required_pages="$2"
shift 3

if [[ "${MFW_EPYC_HUGEPAGES:-}" != YES ]]; then
  echo "execution requires MFW_EPYC_HUGEPAGES=YES" >&2
  exit 3
fi
if [[ ! "${required_pages}" =~ ^[1-9][0-9]*$ ]] || ((required_pages > 4096)); then
  echo "REQUIRED_2M_PAGES must be in 1..4096" >&2
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
if ps -eo comm= | grep -Eq '^(xmrig|mfw-miner)'; then
  echo "pre-existing miner process detected" >&2
  exit 3
fi

mkdir -p "${evidence_dir}"
events_file="${evidence_dir}/hugepage-events.log"
original_pages="$(cat /proc/sys/vm/nr_hugepages)"
grep -E 'HugePages|Hugepagesize|Hugetlb' /proc/meminfo >"${evidence_dir}/meminfo-before.txt"
printf '%s original_pages=%s requested_pages=%s\n' \
  "$(date -u +%FT%TZ)" "${original_pages}" "${required_pages}" | tee -a "${events_file}"

restore() {
  local incoming_status="${1:-0}" restore_status=0 deadline current
  trap - EXIT INT TERM HUP
  set +e
  printf '%s restore-start incoming_status=%s target_pages=%s\n' \
    "$(date -u +%FT%TZ)" "${incoming_status}" "${original_pages}" | tee -a "${events_file}"
  sudo -n sysctl -q -w "vm.nr_hugepages=${original_pages}"
  deadline=$((SECONDS + 30))
  while true; do
    current="$(cat /proc/sys/vm/nr_hugepages)"
    if [[ "${current}" == "${original_pages}" ]]; then
      break
    fi
    if (( SECONDS >= deadline )); then
      echo "HugeTLB restore failed: current=${current}, expected=${original_pages}" | tee -a "${events_file}" >&2
      restore_status=1
      break
    fi
    sudo -n sysctl -q -w "vm.nr_hugepages=${original_pages}"
    sleep 1
  done
  grep -E 'HugePages|Hugepagesize|Hugetlb' /proc/meminfo >"${evidence_dir}/meminfo-after.txt"
  if ps -eo comm= | grep -Eq '^(xmrig|mfw-miner)'; then
    echo "miner residue detected during HugeTLB restore" | tee -a "${events_file}" >&2
    restore_status=1
  fi
  printf '%s restore-finished status=%s current_pages=%s\n' \
    "$(date -u +%FT%TZ)" "${restore_status}" "$(cat /proc/sys/vm/nr_hugepages)" | tee -a "${events_file}"
  if [[ "${restore_status}" != 0 ]]; then
    exit 20
  fi
  exit "${incoming_status}"
}
trap 'restore $?' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

sudo -n sysctl -q -w "vm.nr_hugepages=${required_pages}"
grep -E 'HugePages|Hugepagesize|Hugetlb' /proc/meminfo >"${evidence_dir}/meminfo-allocated.txt"
total_pages="$(awk '/HugePages_Total:/ {print $2}' /proc/meminfo)"
free_pages="$(awk '/HugePages_Free:/ {print $2}' /proc/meminfo)"
if ((total_pages < required_pages || free_pages < required_pages)); then
  echo "HugeTLB allocation incomplete: total=${total_pages}, free=${free_pages}, required=${required_pages}" >&2
  exit 4
fi
printf '%s allocation-ready total=%s free=%s\n' \
  "$(date -u +%FT%TZ)" "${total_pages}" "${free_pages}" | tee -a "${events_file}"

"$@"
status=$?
printf '%s workload-finished status=%s\n' "$(date -u +%FT%TZ)" "${status}" | tee -a "${events_file}"
restore "${status}"
