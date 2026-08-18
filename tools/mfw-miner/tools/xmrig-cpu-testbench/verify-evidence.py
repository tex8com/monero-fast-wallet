#!/usr/bin/env python3
"""Verify the integrity and RandomX correctness of captured benchmark runs."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections import Counter
from pathlib import Path


EXPECTED_HASHES = {
    "100K": "BC4EF98B60B98579",
    "250K": "7D6054757BB08A63",
}

REQUIRED_FILES = (
    "metadata.env",
    "xmrig.log",
    "telemetry.csv",
    "perf-process.csv",
    "perf-amd-df.csv",
    "hugepages-before.txt",
    "hugepages-after.txt",
    "meminfo-before.txt",
    "meminfo-after.txt",
    "netdev-before.txt",
    "netdev-after.txt",
)

BENCH_RE = re.compile(r"(?:--bench|--benchmark)=(\d+[KMG]?)\b", re.IGNORECASE)
HASH_RE = re.compile(r"hash sum\s*=\s*([0-9A-F]+)", re.IGNORECASE)
LABEL_SIZE_RE = re.compile(r"(100K|250K)", re.IGNORECASE)


def parse_metadata(path: Path) -> dict[str, str]:
    metadata: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        metadata[key] = value
    return metadata


def normalize_size(value: str) -> str:
    return value.upper()


def discover_runs(roots: list[Path]) -> list[Path]:
    runs: set[Path] = set()
    for root in roots:
        if root.is_file() and root.name == "metadata.env":
            runs.add(root.parent)
        elif (root / "metadata.env").is_file():
            runs.add(root)
        elif root.is_dir():
            runs.update(path.parent for path in root.rglob("metadata.env"))
    return sorted(
        run
        for run in runs
        if parse_metadata(run / "metadata.env").get("schema")
        != "xmrig_cpu_dual_ccd_v1"
    )


def benchmark_size(run_dir: Path, metadata: dict[str, str]) -> str | None:
    match = BENCH_RE.search(metadata.get("command", ""))
    if match:
        return normalize_size(match.group(1))

    config_path = run_dir / "input-config.json"
    if not config_path.is_file():
        return None
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    value = config.get("benchmark", {}).get("size")
    return normalize_size(str(value)) if value is not None else None


def verify_run(run_dir: Path) -> tuple[str | None, list[str]]:
    errors: list[str] = []
    missing = [name for name in REQUIRED_FILES if not (run_dir / name).is_file()]
    if missing:
        errors.append(f"missing files: {', '.join(missing)}")

    metadata_path = run_dir / "metadata.env"
    if not metadata_path.is_file():
        return None, errors

    metadata = parse_metadata(metadata_path)
    if metadata.get("schema") != "xmrig_cpu_benchmark_v2":
        errors.append(f"unexpected schema: {metadata.get('schema', '<missing>')}")
    if metadata.get("miner_exit_status") != "0":
        errors.append(
            f"miner_exit_status={metadata.get('miner_exit_status', '<missing>')}"
        )
    if metadata.get("timed_out") != "0":
        errors.append(f"timed_out={metadata.get('timed_out', '<missing>')}")

    log_path = run_dir / "xmrig.log"
    log = (
        log_path.read_text(encoding="utf-8", errors="replace")
        if log_path.is_file()
        else ""
    )
    hashes = HASH_RE.findall(log)

    size = benchmark_size(run_dir, metadata)
    if size is None and len(hashes) == 1:
        # Early config-only V32 runs predate config snapshot capture. Their
        # label records the requested size, while the unique known hash
        # independently identifies the same official benchmark size.
        label_match = LABEL_SIZE_RE.search(metadata.get("label", ""))
        inferred = next(
            (
                benchmark
                for benchmark, expected in EXPECTED_HASHES.items()
                if expected == hashes[0].upper()
            ),
            None,
        )
        if label_match and inferred == normalize_size(label_match.group(1)):
            size = inferred
    if size is None:
        errors.append("benchmark size missing from command and captured config")
    elif size not in EXPECTED_HASHES:
        errors.append(f"unsupported benchmark size: {size}")

    config_sha256 = metadata.get("config_sha256")
    if config_sha256:
        config_path = run_dir / "input-config.json"
        if not config_path.is_file():
            errors.append("metadata records a config hash but input-config.json is missing")
        else:
            actual_config_sha256 = hashlib.sha256(config_path.read_bytes()).hexdigest()
            if actual_config_sha256 != config_sha256:
                errors.append(
                    "captured config SHA-256 differs from metadata: "
                    f"{actual_config_sha256}, expected {config_sha256}"
                )

    if log_path.is_file():
        if len(hashes) != 1:
            errors.append(f"expected one final hash sum, found {len(hashes)}")
        elif size in EXPECTED_HASHES:
            actual = hashes[0].upper()
            expected = EXPECTED_HASHES[size]
            if actual != expected:
                errors.append(f"wrong hash sum: {actual}, expected {expected}")

            metadata_line = metadata.get("benchmark_line", "")
            metadata_hashes = HASH_RE.findall(metadata_line)
            if len(metadata_hashes) != 1:
                errors.append("metadata benchmark_line has no unique hash sum")
            elif metadata_hashes[0].upper() != actual:
                errors.append("metadata and xmrig.log hash sums differ")

    return size, errors


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Recursively verify XMRig CPU benchmark evidence. Known official "
            "hash sums are checked for 100K and 250K runs."
        )
    )
    parser.add_argument("paths", nargs="+", type=Path, help="Run or parent directories")
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON")
    args = parser.parse_args()

    missing_roots = [str(path) for path in args.paths if not path.exists()]
    runs = discover_runs(args.paths)
    errors_by_run: dict[str, list[str]] = {}
    sizes: Counter[str] = Counter()
    correct_sizes: Counter[str] = Counter()

    for run_dir in runs:
        size, errors = verify_run(run_dir)
        if size:
            sizes[size] += 1
        if errors:
            errors_by_run[str(run_dir)] = errors
        elif size:
            correct_sizes[size] += 1

    summary = {
        "roots": [str(path) for path in args.paths],
        "run_count": len(runs),
        "runs_by_size": dict(sorted(sizes.items())),
        "correct_by_size": dict(sorted(correct_sizes.items())),
        "invalid_run_count": len(errors_by_run),
        "missing_roots": missing_roots,
        "invalid_runs": errors_by_run,
    }

    if args.json:
        print(json.dumps(summary, indent=2, sort_keys=True))
    else:
        print(f"Runs: {summary['run_count']}")
        for size, count in sorted(correct_sizes.items()):
            print(f"Correct {size}: {count}/{sizes[size]}")
        print(f"Invalid runs: {summary['invalid_run_count']}")
        if missing_roots:
            print(f"Missing roots: {', '.join(missing_roots)}")
        for run, errors in errors_by_run.items():
            print(f"{run}:")
            for error in errors:
                print(f"  - {error}")

    return 1 if missing_roots or not runs or errors_by_run else 0


if __name__ == "__main__":
    sys.exit(main())
