#!/usr/bin/env python3
"""Map Linux perf cycle-sample PCs to deterministic MFW RandomX JIT programs."""

from __future__ import annotations

import argparse
import bisect
import json
import pathlib
import re
import sys
from collections import Counter, defaultdict


SAMPLE = re.compile(r"^\s*(\d+(?:\.\d+)?):?\s+((?:0x)?[0-9a-fA-F]+)\b")


def read_map(path: pathlib.Path) -> tuple[list[dict], list[tuple[int, int, int]]]:
    programs = []
    events: dict[int, dict[str, dict]] = defaultdict(dict)
    with path.open(encoding="utf-8") as source:
        for line in source:
            record = json.loads(line)
            if record.get("record") == "program":
                programs.append(record)
            elif record.get("record") == "event":
                sequence = record.get("seq")
                event = record.get("event")
                if isinstance(sequence, int) and event in ("replay_start", "replay_end"):
                    if event in events[sequence]:
                        raise ValueError(f"duplicate {event} for program {sequence}")
                    events[sequence][event] = record
    if not programs:
        raise ValueError("stable replay map contains no programs")
    programs.sort(key=lambda item: item["seq"])
    if len({item["seq"] for item in programs}) != len(programs):
        raise ValueError("stable replay map contains duplicate program sequences")

    windows = []
    for program in programs:
        sequence = program["seq"]
        pair = events.get(sequence, {})
        start = pair.get("replay_start", {}).get("monotonic_ns")
        end = pair.get("replay_end", {}).get("monotonic_ns")
        if not isinstance(start, int) or not isinstance(end, int) or end < start:
            raise ValueError(f"program {sequence} has no valid monotonic replay window")
        windows.append((start, end, sequence))
    windows.sort()
    return programs, windows


def load_samples(path: pathlib.Path, programs: list[dict], windows: list[tuple[int, int, int]]) -> dict:
    program_by_sequence = {program["seq"]: program for program in programs}
    interval_maps = {}
    for program in programs:
        base = program["native_base"]
        intervals = []
        for instruction in program["instructions"]:
            begin = base + instruction["native_offset"]
            end = begin + instruction["native_size"]
            if end > begin:
                intervals.append((begin, end, instruction))
        intervals.sort()
        interval_maps[program["seq"]] = ([entry[0] for entry in intervals], intervals)

    window_starts = [window[0] for window in windows]

    def active_sequence(time_ns: int) -> int | None:
        index = bisect.bisect_right(window_starts, time_ns) - 1
        if index >= 0 and windows[index][0] <= time_ns <= windows[index][1]:
            return windows[index][2]
        return None

    def locate(sequence: int, address: int):
        address &= ~3
        starts, intervals = interval_maps[sequence]
        index = bisect.bisect_right(starts, address) - 1
        if index >= 0 and intervals[index][0] <= address < intervals[index][1]:
            return intervals[index][2]
        return None

    type_samples = Counter()
    instruction_samples: Counter[tuple[int, int]] = Counter()
    program_samples = Counter()
    parsed_samples = 0
    roi_samples = 0
    mapped_samples = 0

    with path.open(encoding="utf-8", errors="replace") as source:
        for line in source:
            match = SAMPLE.match(line)
            if not match:
                continue
            parsed_samples += 1
            time_ns = int(float(match.group(1)) * 1_000_000_000)
            sequence = active_sequence(time_ns)
            if sequence is None:
                continue
            roi_samples += 1
            instruction = locate(sequence, int(match.group(2), 16))
            if instruction is None:
                continue
            mapped_samples += 1
            type_samples[instruction["type"]] += 1
            instruction_samples[(sequence, instruction["pc"])] += 1
            program_samples[sequence] += 1

    def percent(value: int, denominator: int) -> float:
        return round(100.0 * value / denominator, 4) if denominator else 0.0

    by_type = [{
        "type": name,
        "samples": samples,
        "mapped_sample_percent": percent(samples, mapped_samples),
    } for name, samples in type_samples.most_common()]
    by_instruction = []
    for (sequence, pc), samples in instruction_samples.most_common():
        instruction = program_by_sequence[sequence]["instructions"][pc]
        by_instruction.append({
            "seq": sequence,
            "pc": pc,
            "type": instruction["type"],
            "samples": samples,
            "mapped_sample_percent": percent(samples, mapped_samples),
            "native_offset": instruction["native_offset"],
            "native_size": instruction["native_size"],
        })

    first = programs[0]
    return {
        "schema": 1,
        "kind": "mfw-jit-corpus-linux-perf-cycle-profile",
        "source": str(path),
        "randomx": first["randomx"],
        "backend": first["backend"],
        "mode": first["mode"],
        "programs": len(programs),
        "parsed_perf_samples": parsed_samples,
        "replay_roi_samples": roi_samples,
        "mapped_jit_samples": mapped_samples,
        "mapped_roi_percent": percent(mapped_samples, roi_samples),
        "by_program": [{"seq": sequence, "mapped_samples": program_samples[sequence]}
                       for sequence in sorted(program_by_sequence)],
        "by_type": by_type,
        "by_instruction": by_instruction,
        "warning": "Cycle samples are statistical and period-dependent; light replay is not Fast-mode H/s.",
    }


def markdown(result: dict) -> str:
    lines = [
        f"# MFW Linux perf JIT profile — RandomX v{result['randomx']}",
        "",
        f"Programs: **{result['programs']}**. Mapped JIT samples in replay ROI: "
        f"**{result['mapped_jit_samples']} / {result['replay_roi_samples']}** "
        f"({result['mapped_roi_percent']}%).",
        "",
        "> Cycle sampling is statistical and period-dependent. Light replay is not a Fast-mode H/s benchmark.",
        "",
        "| Instruction type | Samples | Share of mapped JIT |",
        "|---|---:|---:|",
    ]
    for item in result["by_type"]:
        lines.append(f"| {item['type']} | {item['samples']} | {item['mapped_sample_percent']:.3f}% |")
    lines.extend([
        "",
        "## Hottest virtual PCs",
        "",
        "| Program | PC | Type | Samples | Share | Native offset | Bytes |",
        "|---:|---:|---|---:|---:|---:|---:|",
    ])
    for item in result["by_instruction"][:30]:
        lines.append(
            f"| {item['seq']} | {item['pc']} | {item['type']} | {item['samples']} | "
            f"{item['mapped_sample_percent']:.3f}% | {item['native_offset']} | {item['native_size']} |"
        )
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("map", type=pathlib.Path)
    parser.add_argument("samples", type=pathlib.Path)
    parser.add_argument("--json", type=pathlib.Path, dest="json_output")
    parser.add_argument("--markdown", type=pathlib.Path, dest="markdown_output")
    args = parser.parse_args()
    try:
        programs, windows = read_map(args.map)
        result = load_samples(args.samples, programs, windows)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"jit-corpus perf: FAIL: {error}", file=sys.stderr)
        return 2

    encoded = json.dumps(result, indent=2, sort_keys=True) + "\n"
    rendered = markdown(result) + "\n"
    if args.json_output:
        args.json_output.write_text(encoded, encoding="utf-8")
    if args.markdown_output:
        args.markdown_output.write_text(rendered, encoding="utf-8")
    if not args.json_output and not args.markdown_output:
        print(encoded, end="")
    print(f"jit-corpus perf: PASS ({result['mapped_jit_samples']} mapped JIT samples)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
