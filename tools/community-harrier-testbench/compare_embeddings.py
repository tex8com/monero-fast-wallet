#!/usr/bin/env python3
"""Compare a platform's Harrier vectors with the canonical reference."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any

MIN_COSINE = 0.98
DIMENSION = 640
MIN_REFERENCE_CASES = 32
CONTRACT_FIELDS = (
    "schemaVersion",
    "modelId",
    "sourceRevision",
    "sourceWeightsSha256",
    "tokenizerSha256",
    "queryPromptVersion",
    "documentPromptVersion",
    "pooling",
    "normalization",
    "dimension",
    "maxInputTokens",
    "referenceCasesSha256",
)
EXECUTORCH_RUNTIME = "executorch"
EXECUTORCH_RUNTIME_VERSION = "1.3.1"


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def cosine(left: list[float], right: list[float]) -> float:
    numerator = sum(a * b for a, b in zip(left, right))
    left_norm = math.sqrt(sum(value * value for value in left))
    right_norm = math.sqrt(sum(value * value for value in right))
    if left_norm == 0.0 or right_norm == 0.0:
        raise ValueError("zero-length embedding")
    return numerator / (left_norm * right_norm)


def require_vector_document(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise RuntimeError(f"{label} must be a JSON object")
    vectors = value.get("vectors")
    if not isinstance(vectors, list) or len(vectors) < MIN_REFERENCE_CASES:
        raise RuntimeError(
            f"{label} must contain at least {MIN_REFERENCE_CASES} reference vectors"
        )
    if value.get("dimension") != DIMENSION:
        raise RuntimeError(f"{label} must declare {DIMENSION} dimensions")

    identifiers: set[str] = set()
    for item in vectors:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            raise RuntimeError(f"{label} contains an invalid reference case")
        case_id = item["id"]
        if case_id in identifiers:
            raise RuntimeError(f"{label} contains duplicate case id {case_id}")
        identifiers.add(case_id)
        embedding = item.get("embedding")
        if not isinstance(embedding, list) or len(embedding) != DIMENSION:
            raise RuntimeError(
                f"{label} case {case_id} is not a {DIMENSION}-dimensional embedding"
            )
        if any(
            isinstance(component, bool)
            or not isinstance(component, (int, float))
            or not math.isfinite(component)
            for component in embedding
        ):
            raise RuntimeError(f"{label} case {case_id} has a non-finite component")
        norm = math.sqrt(sum(float(component) ** 2 for component in embedding))
        if not math.isclose(norm, 1.0, rel_tol=0.0, abs_tol=1e-4):
            raise RuntimeError(
                f"{label} case {case_id} is not L2-normalized (norm={norm:.8f})"
            )
    return value


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--backend", required=True)
    args = parser.parse_args()

    reference = require_vector_document(
        json.loads(args.reference.read_text(encoding="utf-8")),
        "reference",
    )
    candidate = require_vector_document(
        json.loads(args.candidate.read_text(encoding="utf-8")),
        "candidate",
    )
    for field in CONTRACT_FIELDS:
        if reference.get(field) != candidate.get(field):
            raise RuntimeError(f"candidate {field} does not match the reference contract")
    if candidate.get("runtime") != EXECUTORCH_RUNTIME:
        raise RuntimeError("candidate runtime is not ExecuTorch")
    if candidate.get("runtimeVersion") != EXECUTORCH_RUNTIME_VERSION:
        raise RuntimeError(
            f"candidate runtimeVersion must be {EXECUTORCH_RUNTIME_VERSION}"
        )
    if candidate.get("backend") != args.backend:
        raise RuntimeError("candidate backend does not match --backend")
    artifact_sha256 = candidate.get("pteSha256")
    if (
        not isinstance(artifact_sha256, str)
        or len(artifact_sha256) != 64
        or any(character not in "0123456789abcdef" for character in artifact_sha256)
    ):
        raise RuntimeError("candidate PTE SHA-256 is invalid")

    expected = {item["id"]: item["embedding"] for item in reference["vectors"]}
    actual = {item["id"]: item["embedding"] for item in candidate["vectors"]}
    if expected.keys() != actual.keys():
        raise RuntimeError("candidate case identifiers do not exactly match the reference")

    cases = []
    for case_id in sorted(expected):
        left = expected[case_id]
        right = actual[case_id]
        similarity = cosine(left, right)
        cases.append(
            {
                "id": case_id,
                "cosine": similarity,
                "maxAbsDifference": max(abs(a - b) for a, b in zip(left, right)),
            }
        )
    minimum = min(item["cosine"] for item in cases)
    report = {
        "schemaVersion": 1,
        "backend": args.backend,
        "runtime": EXECUTORCH_RUNTIME,
        "runtimeVersion": EXECUTORCH_RUNTIME_VERSION,
        "artifactSha256": artifact_sha256,
        "referenceSha256": sha256_file(args.reference),
        "candidateSha256": sha256_file(args.candidate),
        "referenceCases": len(cases),
        "minimumCosine": minimum,
        "minimumCosinePpm": round(minimum * 1_000_000),
        "maximumAbsoluteDifference": max(item["maxAbsDifference"] for item in cases),
        "passed": minimum >= MIN_COSINE,
        "cases": cases,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    if not report["passed"]:
        raise SystemExit(
            f"Harrier backend failed: minimum cosine {minimum:.6f} is below {MIN_COSINE:.2f}"
        )
    print(f"Harrier backend passed {len(cases)} cases; minimum cosine={minimum:.6f}")


if __name__ == "__main__":
    main()
