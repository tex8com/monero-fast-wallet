#!/usr/bin/env python3
"""Freeze the exact texts and token IDs consumed by native Harrier runtimes."""

from __future__ import annotations

import argparse
import hashlib
import json
import unicodedata
from pathlib import Path

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


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def normalize_query_text_v1(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).lower()
    normalized = " ".join(normalized.split())
    if not 1 <= len(normalized) <= 160:
        raise ValueError("normalized query must contain 1 to 160 characters")
    return normalized


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--model-cache", type=Path, required=True)
    parser.add_argument(
        "--cases",
        type=Path,
        default=Path(__file__).with_name("reference_cases.json"),
    )
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    if sha256_file(args.model_dir / "model.safetensors") != MODEL_SHA256:
        raise RuntimeError("source model SHA-256 mismatch")
    if sha256_file(args.model_dir / "tokenizer.json") != TOKENIZER_SHA256:
        raise RuntimeError("tokenizer SHA-256 mismatch")
    tokenizer = AutoTokenizer.from_pretrained(
        MODEL_ID,
        revision=MODEL_REVISION,
        cache_dir=args.model_cache,
        local_files_only=True,
        trust_remote_code=False,
    )
    if (
        tokenizer.padding_side != "right"
        or tokenizer.truncation_side != "right"
        or tokenizer.pad_token_id != 0
        or tokenizer.bos_token_id != 2
        or tokenizer.eos_token_id != 1
    ):
        raise RuntimeError("tokenizer padding/special-token contract changed")

    cases = json.loads(args.cases.read_text(encoding="utf-8"))
    prepared_cases = []
    for case in cases:
        text = case["text"].strip()
        if case["kind"] == "query":
            text = QUERY_INSTRUCTION + normalize_query_text_v1(text)
        input_ids = tokenizer(
            text,
            max_length=MAX_INPUT_TOKENS,
            truncation=True,
            add_special_tokens=True,
        )["input_ids"]
        prepared_cases.append(
            {
                "id": case["id"],
                "kind": case["kind"],
                "language": case["language"],
                "preparedText": text,
                "inputIds": input_ids,
            }
        )

    payload = {
        "schemaVersion": 1,
        "modelId": MODEL_ID,
        "sourceRevision": MODEL_REVISION,
        "sourceWeightsSha256": MODEL_SHA256,
        "tokenizerSha256": TOKENIZER_SHA256,
        "tokenizerRepository": "meta-pytorch/tokenizers",
        "tokenizerRevision": "0b10f027bc66e9d372e3321c9fa0142d1c52891b",
        "referenceCasesSha256": sha256_file(args.cases),
        "queryInstruction": QUERY_INSTRUCTION,
        "maxInputTokens": MAX_INPUT_TOKENS,
        "paddingSide": "right",
        "truncationSide": "right",
        "paddingToken": 0,
        "beginToken": 2,
        "endToken": 1,
        "cases": prepared_cases,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    print(f"wrote {len(prepared_cases)} prepared Harrier cases to {args.output}")


if __name__ == "__main__":
    main()
