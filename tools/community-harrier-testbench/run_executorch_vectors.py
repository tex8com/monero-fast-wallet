#!/usr/bin/env python3
"""Run a Harrier ExecuTorch artifact over the frozen conformance cases."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import unicodedata
from pathlib import Path

import torch
from executorch.extension.pybindings.portable_lib import _load_for_executorch
# These imports register the quantized operators used by the XNNPACK
# embedding artifacts with the Python portable runtime.
from executorch.kernels import quantized as _quantized_kernels  # noqa: F401
from torch.ao.quantization.fx._decomposed import (  # noqa: F401
    quantized_decomposed_lib as _quantized_decomposed_lib,
)
from transformers import AutoTokenizer

MODEL_ID = "microsoft/harrier-oss-v1-270m"
MODEL_REVISION = "31de22b673913c7d658c0f03f792d77c2dcf8ebd"
MODEL_SHA256 = "90933b6826b61afd9331e0ebe3c0598b421a32eda5fb301a114fe36f306cb51a"
TOKENIZER_SHA256 = "6852f8d561078cc0cebe70ca03c5bfdd0d60a45f9d2e0e1e4cc05b68e9ec329e"
QUERY_INSTRUCTION = (
    "Instruct: Given a community search query, retrieve relevant "
    "public profiles, posts, services, products, news, and clearly labeled "
    "advertisements\nQuery: "
)
MAX_INPUT_TOKENS = 256
DIMENSION = 640


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def normalize_query_text_v1(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).lower()
    normalized = " ".join(normalized.split())
    if not 1 <= len(normalized) <= 160:
        raise ValueError("normalized query must contain 1 to 160 characters")
    return normalized


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pte", type=Path, required=True)
    parser.add_argument("--expected-pte-sha256", required=True)
    parser.add_argument(
        "--backend",
        choices=("xnnpack-a8w8",),
        required=True,
    )
    parser.add_argument("--model-cache", type=Path, required=True)
    parser.add_argument(
        "--cases",
        type=Path,
        default=Path(__file__).with_name("reference_cases.json"),
    )
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    actual_pte_hash = sha256_file(args.pte)
    if actual_pte_hash != args.expected_pte_sha256:
        raise RuntimeError(f"PTE SHA-256 mismatch: {actual_pte_hash}")
    tokenizer = AutoTokenizer.from_pretrained(
        MODEL_ID,
        revision=MODEL_REVISION,
        cache_dir=args.model_cache,
        local_files_only=True,
        trust_remote_code=False,
    )
    module = _load_for_executorch(str(args.pte))
    cases = json.loads(args.cases.read_text(encoding="utf-8"))
    vectors = []
    for case in cases:
        text = case["text"].strip()
        if case["kind"] == "query":
            text = QUERY_INSTRUCTION + normalize_query_text_v1(text)
        encoded = tokenizer(
            [text],
            max_length=MAX_INPUT_TOKENS,
            padding="max_length",
            truncation=True,
            return_tensors="pt",
        )
        output = module.forward(
            (encoded["input_ids"], encoded["attention_mask"])
        )[0].to(torch.float32)
        embedding = [float(value) for value in output[0].tolist()]
        if len(embedding) != DIMENSION or any(
            not math.isfinite(value) for value in embedding
        ):
            raise RuntimeError(f"{case['id']} produced an invalid embedding")
        vectors.append(
            {
                "id": case["id"],
                "kind": case["kind"],
                "language": case["language"],
                "embedding": embedding,
            }
        )

    payload = {
        "schemaVersion": 1,
        "modelId": MODEL_ID,
        "sourceRevision": MODEL_REVISION,
        "sourceWeightsSha256": MODEL_SHA256,
        "tokenizerSha256": TOKENIZER_SHA256,
        "queryPromptVersion": "community-query-v2",
        "documentPromptVersion": "community-document-v1",
        "pooling": "last-token",
        "normalization": "l2",
        "dimension": DIMENSION,
        "maxInputTokens": MAX_INPUT_TOKENS,
        "referenceCasesSha256": sha256_file(args.cases),
        "runtime": "executorch",
        "runtimeVersion": "1.3.1",
        "backend": args.backend,
        "pteSha256": actual_pte_hash,
        "vectors": vectors,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    print(f"wrote {len(vectors)} ExecuTorch vectors to {args.output}")


if __name__ == "__main__":
    main()
