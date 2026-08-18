#!/usr/bin/env python3
"""Verify the default-off AArch64 CBRANCH 32-bit TST candidate."""

from __future__ import annotations

import argparse
import json
import pathlib
import sys


MASK19 = (1 << 19) - 1


def sign_extend_19(value: int) -> int:
    value &= MASK19
    return value - (1 << 19) if value & (1 << 18) else value


def expected_tst(mode: int, dst: int, mod_cond: int) -> int:
    base = 0xF2781C1F if mode == 0 else 0x72181C1F
    return (base - (mod_cond << 16)) | (dst << 5)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("map", type=pathlib.Path)
    parser.add_argument("--mode", type=int, choices=(0, 1), required=True)
    parser.add_argument("--reference", type=pathlib.Path,
                        help="mode-0 map generated from the same deterministic corpus")
    args = parser.parse_args()

    program_records = []
    programs = 0
    branches = 0
    sizes: set[int] = set()
    for line in args.map.read_text(encoding="utf-8").splitlines():
        record = json.loads(line)
        if record.get("record") != "program" or record.get("backend") != "aarch64":
            continue
        program_records.append(record)
        programs += 1
        for instruction in record["instructions"]:
            if instruction["type"] != "CBRANCH":
                continue
            branches += 1
            native = bytes.fromhex(instruction["native_hex"])
            if len(native) < 12 or len(native) % 4:
                raise ValueError(f"invalid CBRANCH size at seq={record['seq']} pc={instruction['pc']}")
            words = [int.from_bytes(native[index:index + 4], "little")
                     for index in range(0, len(native), 4)]
            tst = words[-2]
            branch = words[-1]
            dst = (tst >> 5) & 31
            mod_cond = instruction["mod"] >> 4
            if tst != expected_tst(args.mode, dst, mod_cond):
                raise ValueError(
                    f"wrong TST at seq={record['seq']} pc={instruction['pc']}: "
                    f"0x{tst:08x} != 0x{expected_tst(args.mode, dst, mod_cond):08x}"
                )
            if branch & 0xFF00001F != 0x54000000:
                raise ValueError(f"CBRANCH tail is not B.EQ at seq={record['seq']} pc={instruction['pc']}")
            displacement = sign_extend_19(branch >> 5) * 4
            if displacement >= 0 or displacement % 4:
                raise ValueError(f"invalid backward displacement {displacement}")
            sizes.add(len(native))

    if programs == 0 or branches == 0:
        raise ValueError("map contains no AArch64 programs/CBRANCH instructions")

    if args.reference:
        reference_records = []
        for line in args.reference.read_text(encoding="utf-8").splitlines():
            record = json.loads(line)
            if record.get("record") == "program" and record.get("backend") == "aarch64":
                reference_records.append(record)
        if len(reference_records) != len(program_records):
            raise ValueError("candidate/reference program counts differ")
        compared = 0
        for candidate, reference in zip(program_records, reference_records):
            for field in ("seq", "randomx", "mode", "program_size", "code_start",
                          "code_end", "read_regs", "entropy"):
                if candidate[field] != reference[field]:
                    raise ValueError(f"candidate/reference {field} differs at seq={candidate['seq']}")
            if len(candidate["instructions"]) != len(reference["instructions"]):
                raise ValueError(f"instruction count differs at seq={candidate['seq']}")
            for cand_insn, ref_insn in zip(candidate["instructions"], reference["instructions"]):
                for field in ("pc", "type", "opcode", "dst", "src", "mod", "imm32",
                              "native_offset", "native_size"):
                    if cand_insn[field] != ref_insn[field]:
                        raise ValueError(
                            f"candidate/reference {field} differs at "
                            f"seq={candidate['seq']} pc={cand_insn['pc']}"
                        )
                cand_words = [int.from_bytes(bytes.fromhex(cand_insn["native_hex"])[index:index + 4], "little")
                              for index in range(0, cand_insn["native_size"], 4)]
                ref_words = [int.from_bytes(bytes.fromhex(ref_insn["native_hex"])[index:index + 4], "little")
                             for index in range(0, ref_insn["native_size"], 4)]
                if cand_insn["type"] == "CBRANCH":
                    dst = (cand_words[-2] >> 5) & 31
                    mod_cond = cand_insn["mod"] >> 4
                    if cand_words[-2] != expected_tst(args.mode, dst, mod_cond):
                        raise ValueError("candidate CBRANCH TST does not match requested mode")
                    if ref_words[-2] != expected_tst(0, dst, mod_cond):
                        raise ValueError("reference CBRANCH is not mode 0")
                    if cand_words[:-2] != ref_words[:-2] or cand_words[-1] != ref_words[-1]:
                        raise ValueError(
                            f"CBRANCH changed outside TST at seq={candidate['seq']} pc={cand_insn['pc']}"
                        )
                    compared += 1
                elif cand_words != ref_words:
                    raise ValueError(
                        f"non-CBRANCH native bytes differ at seq={candidate['seq']} pc={cand_insn['pc']}"
                    )
        if compared != branches:
            raise ValueError("not every candidate CBRANCH was compared")

    # All legal masks occupy bits 8..30. Exhaustively prove that truncating the
    # input to W does not change Z for values that differ arbitrarily above bit
    # 31. The branch decision is the Z flag only.
    probes = (0, 1, 0xFFFFFFFF, 0x0123456789ABCDEF, 0xFFFFFFFFFFFFFFFF)
    for mod_cond in range(16):
        mask = 0xFF << (8 + mod_cond)
        assert mask < (1 << 32)
        for value in probes:
            z64 = (value & mask) == 0
            z32 = ((value & 0xFFFFFFFF) & mask) == 0
            if z64 != z32:
                raise AssertionError("32/64-bit TST semantic mismatch")

    print(
        f"AArch64 CBRANCH mode {args.mode}: PASS "
        f"({programs} programs, {branches} branches, sizes={sorted(sizes)}, "
        f"reference={'yes' if args.reference else 'no'})"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"AArch64 CBRANCH verify: FAIL: {error}", file=sys.stderr)
        raise SystemExit(2)
