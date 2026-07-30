#!/usr/bin/env python3
"""Generate the canonical Harrier V1 CPU reference vectors.

This script intentionally performs no remote inference. It downloads one
pinned public model revision, verifies the two security-critical assets, and
then runs deterministic local inference.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import unicodedata
from pathlib import Path
from typing import Any

import torch
import torch.nn.functional as functional
from huggingface_hub import snapshot_download
from transformers import AutoModel, AutoTokenizer

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
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def require_hash(path: Path, expected: str) -> None:
    actual = sha256_file(path)
    if actual != expected:
        raise RuntimeError(f"{path.name} SHA-256 mismatch: {actual}")


def last_token_pool(hidden: torch.Tensor, attention_mask: torch.Tensor) -> torch.Tensor:
    if bool(attention_mask[:, -1].sum() == attention_mask.shape[0]):
        return hidden[:, -1]
    sequence_lengths = attention_mask.sum(dim=1) - 1
    batch = torch.arange(hidden.shape[0], device=hidden.device)
    return hidden[batch, sequence_lengths]


def normalize_query_text_v1(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).lower()
    normalized = " ".join(normalized.split())
    if not 1 <= len(normalized) <= 160:
        raise ValueError("normalized query must contain 1 to 160 characters")
    return normalized


def encode_case(
    model: torch.nn.Module,
    tokenizer: Any,
    case: dict[str, str],
    pad_to_max: bool,
) -> list[float]:
    text = case["text"].strip()
    if case["kind"] == "query":
        text = QUERY_INSTRUCTION + normalize_query_text_v1(text)
    encoded = tokenizer(
        [text],
        max_length=MAX_INPUT_TOKENS,
        padding="max_length" if pad_to_max else True,
        truncation=True,
        return_tensors="pt",
    )
    with torch.inference_mode():
        output = model(**encoded)
        pooled = last_token_pool(output.last_hidden_state, encoded["attention_mask"])
        normalized = functional.normalize(pooled.float(), p=2, dim=1)
    return [float(value) for value in normalized[0].cpu().tolist()]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", type=Path, default=Path(__file__).with_name("reference_cases.json"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--model-cache", type=Path)
    parser.add_argument(
        "--pad-to-max",
        action="store_true",
        help="diagnostic: right-pad every case to the static 256-token runtime shape",
    )
    args = parser.parse_args()

    torch.set_num_threads(1)
    torch.use_deterministic_algorithms(True)
    local_model = Path(
        snapshot_download(
            repo_id=MODEL_ID,
            revision=MODEL_REVISION,
            cache_dir=args.model_cache,
            allow_patterns=[
                "*.json",
                "*.safetensors",
                "1_Pooling/*",
            ],
        )
    )
    require_hash(local_model / "model.safetensors", MODEL_SHA256)
    require_hash(local_model / "tokenizer.json", TOKENIZER_SHA256)

    # Loading a tokenizer from a local directory that also contains model files
    # triggers a false Mistral-regex warning in Transformers 4.57.x. Harrier is
    # a Gemma model, so bind the official repository id and exact revision while
    # requiring the already verified local cache instead of applying a Mistral
    # tokenizer mutation.
    tokenizer = AutoTokenizer.from_pretrained(
        MODEL_ID,
        revision=MODEL_REVISION,
        cache_dir=args.model_cache,
        local_files_only=True,
        trust_remote_code=False,
    )
    model = AutoModel.from_pretrained(
        local_model,
        local_files_only=True,
        trust_remote_code=False,
        dtype=torch.float32,
    ).eval()
    cases = json.loads(args.cases.read_text(encoding="utf-8"))
    vectors = [
        {
            "id": case["id"],
            "kind": case["kind"],
            "language": case["language"],
            "embedding": encode_case(model, tokenizer, case, args.pad_to_max),
        }
        for case in cases
    ]
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
        "dimension": 640,
        "maxInputTokens": MAX_INPUT_TOKENS,
        "inputPadding": "max-length" if args.pad_to_max else "longest",
        "pythonVersion": platform.python_version(),
        "torchVersion": torch.__version__,
        "transformersVersion": __import__("transformers").__version__,
        "tokenizersVersion": __import__("tokenizers").__version__,
        "referenceCasesSha256": sha256_file(args.cases),
        "vectors": vectors,
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(encoded + "\n", encoding="utf-8")
    print(f"wrote {len(vectors)} canonical vectors to {args.output}")


if __name__ == "__main__":
    main()
