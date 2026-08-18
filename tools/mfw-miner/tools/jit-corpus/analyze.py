#!/usr/bin/env python3
"""Validate and summarize MFW RandomX JIT corpus NDJSON files."""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import statistics
import sys
from collections import Counter, defaultdict


def fail(message: str) -> None:
    raise ValueError(message)


def read_corpus(path: pathlib.Path) -> tuple[dict, list[dict], dict]:
    digest = hashlib.sha256()
    records: list[dict] = []
    with path.open("rb") as source:
        for number, raw in enumerate(source, 1):
            digest.update(raw)
            try:
                record = json.loads(raw)
            except json.JSONDecodeError as error:
                fail(f"{path}:{number}: invalid JSON: {error}")
            records.append(record)

    if len(records) < 2 or records[0].get("record") != "manifest":
        fail(f"{path}: missing first-line manifest")
    if records[-1].get("record") != "summary":
        fail(f"{path}: missing final summary")

    programs = [record for record in records if record.get("record") == "program"]
    summary = records[-1]
    if summary.get("healthy") is not True:
        fail(f"{path}: producer marked corpus unhealthy")
    if summary.get("programs") != len(programs):
        fail(f"{path}: summary count does not match program records")

    for expected_seq, program in enumerate(programs):
        validate_program(path, expected_seq, program)

    manifest = dict(records[0])
    manifest["sha256"] = digest.hexdigest()
    return manifest, programs, summary


def validate_program(path: pathlib.Path, expected_seq: int, program: dict) -> None:
    seq = program.get("seq")
    if seq != expected_seq:
        fail(f"{path}: expected seq {expected_seq}, got {seq}")

    version = program.get("randomx")
    expected_size = {1: 256, 2: 384}.get(version)
    if expected_size is None:
        fail(f"{path}: seq {seq}: unsupported RandomX version {version}")
    if program.get("program_size") != expected_size:
        fail(f"{path}: seq {seq}: version {version} must have {expected_size} instructions")

    start = program.get("code_start")
    end = program.get("code_end")
    if not isinstance(start, int) or not isinstance(end, int) or end < start:
        fail(f"{path}: seq {seq}: invalid native code bounds")
    code_hex = program.get("code_hex", "")
    if len(code_hex) != 2 * (end - start):
        fail(f"{path}: seq {seq}: code_hex length does not match bounds")

    instructions = program.get("instructions")
    if not isinstance(instructions, list) or len(instructions) != expected_size:
        fail(f"{path}: seq {seq}: instruction array has wrong size")

    cursor = start
    for pc, instruction in enumerate(instructions):
        if instruction.get("pc") != pc:
            fail(f"{path}: seq {seq}: expected pc {pc}")
        offset = instruction.get("native_offset")
        native_size = instruction.get("native_size")
        native_hex = instruction.get("native_hex", "")
        if offset != cursor or not isinstance(native_size, int) or native_size < 0:
            fail(f"{path}: seq {seq}, pc {pc}: non-contiguous native mapping")
        if len(native_hex) != native_size * 2:
            fail(f"{path}: seq {seq}, pc {pc}: native_hex size mismatch")
        cursor += native_size
    if cursor != end:
        fail(f"{path}: seq {seq}: instruction map does not reach code_end")


def summarize(inputs: list[pathlib.Path]) -> dict:
    manifests = []
    programs = []
    for path in inputs:
        manifest, current_programs, _ = read_corpus(path)
        manifest["path"] = str(path)
        manifests.append(manifest)
        programs.extend(current_programs)

    by_version: dict[int, list[dict]] = defaultdict(list)
    for program in programs:
        by_version[program["randomx"]].append(program)

    versions = {}
    for version, version_programs in sorted(by_version.items()):
        types: dict[str, dict[str, object]] = {}
        grouped: dict[str, list[int]] = defaultdict(list)
        zero = Counter()
        for program in version_programs:
            for instruction in program["instructions"]:
                name = instruction["type"]
                grouped[name].append(instruction["native_size"])
                if instruction["native_size"] == 0:
                    zero[name] += 1

        for name, sizes in sorted(grouped.items()):
            types[name] = {
                "occurrences": len(sizes),
                "native_bytes": sum(sizes),
                "mean_native_bytes": round(statistics.mean(sizes), 4),
                "median_native_bytes": statistics.median(sizes),
                "min_native_bytes": min(sizes),
                "max_native_bytes": max(sizes),
                "zero_byte_occurrences": zero[name],
            }

        code_sizes = [program["code_end"] - program["code_start"] for program in version_programs]
        versions[str(version)] = {
            "programs": len(version_programs),
            "backends": sorted({program["backend"] for program in version_programs}),
            "modes": sorted({program["mode"] for program in version_programs}),
            "instructions": sum(len(program["instructions"]) for program in version_programs),
            "native_bytes": sum(code_sizes),
            "mean_program_native_bytes": round(statistics.mean(code_sizes), 4),
            "min_program_native_bytes": min(code_sizes),
            "max_program_native_bytes": max(code_sizes),
            "instruction_types": types,
        }

    return {
        "schema": 1,
        "kind": "mfw-jit-corpus-static-summary",
        "warning": "Native byte counts are code-shape metrics, not runtime-cost measurements.",
        "inputs": manifests,
        "programs": len(programs),
        "versions": versions,
    }


def markdown(summary: dict) -> str:
    lines = [
        "# MFW RandomX JIT corpus summary",
        "",
        "> Native byte counts describe code shape; they are not cycle or bottleneck measurements.",
        "",
        f"Validated programs: **{summary['programs']}**",
        "",
    ]
    for version, data in summary["versions"].items():
        lines.extend([
            f"## RandomX v{version}",
            "",
            f"Programs: {data['programs']}; instructions: {data['instructions']}; "
            f"mean native program size: {data['mean_program_native_bytes']} bytes.",
            "",
            "| Instruction | Count | Native bytes | Mean B | Min | Max | Zero-byte |",
            "|---|---:|---:|---:|---:|---:|---:|",
        ])
        ordered = sorted(
            data["instruction_types"].items(),
            key=lambda item: (-item[1]["native_bytes"], item[0]),
        )
        for name, values in ordered:
            lines.append(
                f"| {name} | {values['occurrences']} | {values['native_bytes']} | "
                f"{values['mean_native_bytes']} | {values['min_native_bytes']} | "
                f"{values['max_native_bytes']} | {values['zero_byte_occurrences']} |"
            )
        lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("inputs", nargs="+", type=pathlib.Path)
    parser.add_argument("--json", type=pathlib.Path, dest="json_output")
    parser.add_argument("--markdown", type=pathlib.Path, dest="markdown_output")
    args = parser.parse_args()

    try:
        result = summarize(args.inputs)
    except (OSError, ValueError) as error:
        print(f"jit-corpus analyze: FAIL: {error}", file=sys.stderr)
        return 2

    encoded = json.dumps(result, indent=2, sort_keys=True) + "\n"
    rendered = markdown(result) + "\n"
    if args.json_output:
        args.json_output.write_text(encoded, encoding="utf-8")
    if args.markdown_output:
        args.markdown_output.write_text(rendered, encoding="utf-8")
    if not args.json_output and not args.markdown_output:
        print(encoded, end="")

    print(f"jit-corpus analyze: PASS ({result['programs']} programs)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
