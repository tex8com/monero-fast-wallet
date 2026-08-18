#!/usr/bin/env python3
"""Fail-closed launch gate for the 12-vCPU TEX8 EPYC benchmark guest."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path


EXPECTED_CPUS = tuple(range(12))
MIN_AVAILABLE_KIB = 5 * 1024 * 1024


def read_text(root: Path, relative: str) -> str:
    return (root / relative.lstrip("/")).read_text(encoding="utf-8")


def parse_cpu_set(value: str) -> tuple[int, ...]:
    cpus: set[int] = set()
    for part in value.strip().split(","):
        if not part:
            continue
        if "-" in part:
            first_text, last_text = part.split("-", 1)
            first, last = int(first_text), int(last_text)
            if first > last:
                raise ValueError(f"invalid CPU range: {part}")
            cpus.update(range(first, last + 1))
        else:
            cpus.add(int(part))
    return tuple(sorted(cpus))


def parse_cpuinfo(text: str) -> tuple[int, int, str]:
    first = text.split("\n\n", 1)[0]

    def field(name: str) -> str:
        match = re.search(rf"^{re.escape(name)}\s*:\s*(.+)$", first, re.MULTILINE)
        if not match:
            raise ValueError(f"missing {name!r} in /proc/cpuinfo")
        return match.group(1).strip()

    return int(field("cpu family")), int(field("model")), field("model name")


def parse_meminfo(text: str) -> dict[str, int]:
    values: dict[str, int] = {}
    for line in text.splitlines():
        match = re.match(r"^([^:]+):\s+(\d+)", line)
        if match:
            values[match.group(1)] = int(match.group(2))
    return values


def parse_vmstat(text: str) -> list[dict[str, int]]:
    rows: list[dict[str, int]] = []
    for line in text.splitlines():
        fields = line.split()
        if len(fields) < 17 or not all(re.fullmatch(r"-?\d+", item) for item in fields):
            continue
        rows.append(
            {
                "runnable": int(fields[0]),
                "swap_in": int(fields[6]),
                "swap_out": int(fields[7]),
                "idle": int(fields[-3]),
                "wait": int(fields[-2]),
                "steal": int(fields[-1]),
            }
        )
    # vmstat's first row is the since-boot average, not a live sample.
    if len(rows) >= 4:
        rows = rows[-3:]
    return rows


def read_int(root: Path, relative: str) -> int:
    return int(read_text(root, relative).strip())


def active_miner_processes(root: Path) -> list[dict[str, object]]:
    processes: list[dict[str, object]] = []
    proc = root / "proc"
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            command = (entry / "comm").read_text(encoding="utf-8").strip()
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
        if command.startswith("xmrig") or command.startswith("mfw-miner"):
            processes.append({"pid": int(entry.name), "comm": command})
    return sorted(processes, key=lambda item: int(item["pid"]))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot-json", required=True, type=Path)
    parser.add_argument("--page-mode", required=True, choices=("none", "2m", "1g"))
    parser.add_argument("--worker-count", required=True, type=int)
    parser.add_argument("--process-cpus", required=True)
    parser.add_argument("--msr-mode", required=True, choices=("off", "auto"))
    parser.add_argument("--allow-msr-writes", action="store_true")
    parser.add_argument(
        "--fixture-root",
        type=Path,
        help="test only: read proc/sys/dev from this fixture and fixture vmstat.txt",
    )
    args = parser.parse_args()

    root = args.fixture_root.resolve() if args.fixture_root else Path("/")
    errors: list[str] = []

    try:
        process_cpus = parse_cpu_set(args.process_cpus)
    except ValueError as error:
        parser.error(str(error))
    if process_cpus != EXPECTED_CPUS:
        errors.append(f"process CPU set must be exactly 0-11, got {process_cpus}")
    if not 1 <= args.worker_count <= len(EXPECTED_CPUS):
        errors.append(f"worker count must be in 1..{len(EXPECTED_CPUS)}")

    try:
        family, model, model_name = parse_cpuinfo(read_text(root, "/proc/cpuinfo"))
        online_cpus = parse_cpu_set(read_text(root, "/sys/devices/system/cpu/online"))
        meminfo = parse_meminfo(read_text(root, "/proc/meminfo"))
        load_average = read_text(root, "/proc/loadavg").strip()
    except (FileNotFoundError, PermissionError, ValueError) as error:
        print(f"host gate input error: {error}", file=sys.stderr)
        raise SystemExit(3) from error

    if family != 25 or model != 17 or "EPYC 9634" not in model_name:
        errors.append(
            f"expected AMD EPYC 9634 family/model 25/17, got {model_name} {family}/{model}"
        )
    if online_cpus != EXPECTED_CPUS:
        errors.append(f"expected online CPUs 0-11, got {online_cpus}")

    effective_cpuset: tuple[int, ...] | None = None
    for relative in (
        "/sys/fs/cgroup/cpuset.cpus.effective",
        "/sys/fs/cgroup/cpuset/cpuset.cpus",
    ):
        candidate = root / relative.lstrip("/")
        if candidate.is_file():
            effective_cpuset = parse_cpu_set(candidate.read_text(encoding="utf-8"))
            break
    if effective_cpuset is None:
        errors.append("effective cgroup CPU set is not readable")
    elif effective_cpuset != EXPECTED_CPUS:
        errors.append(f"effective cgroup CPU set must be 0-11, got {effective_cpuset}")

    nodes = sorted(path.name for path in (root / "sys/devices/system/node").glob("node[0-9]*"))
    if nodes != ["node0"]:
        errors.append(f"expected exactly one guest NUMA node0, got {nodes}")
    if meminfo.get("MemAvailable", 0) < MIN_AVAILABLE_KIB:
        errors.append(
            f"MemAvailable below {MIN_AVAILABLE_KIB} KiB: {meminfo.get('MemAvailable', 0)}"
        )

    if args.fixture_root:
        vmstat_text = read_text(root, "/vmstat.txt")
    else:
        completed = subprocess.run(
            ["vmstat", "1", "4"],
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        vmstat_text = completed.stdout
    live_rows = parse_vmstat(vmstat_text)
    if len(live_rows) != 3:
        errors.append(f"expected three live vmstat samples, got {len(live_rows)}")
    elif any(
        row["runnable"] > 2
        or row["idle"] < 90
        or row["steal"] != 0
        or row["swap_in"] != 0
        or row["swap_out"] != 0
        for row in live_rows
    ):
        errors.append(
            "live host gate requires r<=2, idle>=90%, steal=0 and swap-in/out=0 in every sample"
        )

    residue = active_miner_processes(root)
    if residue:
        errors.append(f"existing miner processes detected: {residue}")

    huge_2m = read_int(
        root, "/sys/kernel/mm/hugepages/hugepages-2048kB/free_hugepages"
    )
    huge_1g = read_int(
        root, "/sys/kernel/mm/hugepages/hugepages-1048576kB/free_hugepages"
    )
    if args.page_mode == "2m" and huge_2m < 1168 + args.worker_count:
        errors.append(
            f"2 MiB HugeTLB mode needs at least {1168 + args.worker_count} free pages, got {huge_2m}"
        )
    if args.page_mode == "1g":
        if huge_1g < 3:
            errors.append(f"1 GiB mode needs at least 3 free 1 GiB pages, got {huge_1g}")
        if huge_2m < args.worker_count:
            errors.append(
                f"1 GiB dataset mode also needs at least {args.worker_count} free 2 MiB worker pages, got {huge_2m}"
            )

    msr_devices: list[dict[str, object]] = []
    if args.msr_mode == "auto":
        if not args.allow_msr_writes:
            errors.append("MSR mode requires the explicit allow-msr-writes acknowledgement")
        for cpu in process_cpus:
            device = root / f"dev/cpu/{cpu}/msr"
            usable = device.exists() and os.access(device, os.R_OK | os.W_OK)
            msr_devices.append({"cpu": cpu, "path": str(device), "read_write": usable})
            if not usable:
                errors.append(f"MSR device is not read/write accessible for CPU {cpu}")

    snapshot = {
        "schema": "mfw_epyc_host_gate_v1",
        "fixture": bool(args.fixture_root),
        "eligible": not errors,
        "errors": errors,
        "cpu": {
            "family": family,
            "model": model,
            "model_name": model_name,
            "online": list(online_cpus),
            "effective_cpuset": list(effective_cpuset or ()),
            "nodes": nodes,
        },
        "load_average": load_average,
        "live_vmstat": live_rows,
        "mem_available_kib": meminfo.get("MemAvailable", 0),
        "swap_free_kib": meminfo.get("SwapFree", 0),
        "hugetlb_free": {"2m": huge_2m, "1g": huge_1g},
        "page_mode": args.page_mode,
        "msr_mode": args.msr_mode,
        "msr_devices": msr_devices,
        "miner_residue": residue,
    }
    args.snapshot_json.parent.mkdir(parents=True, exist_ok=True)
    args.snapshot_json.write_text(json.dumps(snapshot, indent=2) + "\n", encoding="utf-8")

    if errors:
        for error in errors:
            print(f"REJECT: {error}", file=sys.stderr)
        raise SystemExit(4)
    print("PASS: quiet EPYC host gate")


if __name__ == "__main__":
    main()
