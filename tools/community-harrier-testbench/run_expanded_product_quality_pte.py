#!/usr/bin/env python3
"""Embed the expanded product-quality fixture with the accepted A8W8 PTE."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import time
from pathlib import Path

import torch
from executorch.extension.pybindings.portable_lib import _load_for_executorch
from executorch.kernels import quantized as _quantized_kernels  # noqa: F401
from torch.ao.quantization.fx._decomposed import (  # noqa: F401
    quantized_decomposed_lib as _quantized_decomposed_lib,
)

DIMENSION = 640
PTE_SHA256 = "237b9297d51ec3904042d06de340755365483da0be0054fa05b9d17468274d02"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def embedding(module: object, item: dict[str, object]) -> list[float]:
    input_ids = torch.tensor([item["inputIds"]], dtype=torch.long)
    attention_mask = torch.tensor(
        [item["attentionMask"]], dtype=torch.long
    )
    output = module.forward((input_ids, attention_mask))[0].to(torch.float32)
    values = [float(value) for value in output[0].tolist()]
    norm = math.sqrt(sum(value * value for value in values))
    if (
        len(values) != DIMENSION
        or any(not math.isfinite(value) for value in values)
        or not 0.995 <= norm <= 1.005
    ):
        raise RuntimeError(f"{item['id']} produced an invalid embedding")
    return values


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pte", type=Path, required=True)
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    if sha256_file(args.pte) != PTE_SHA256:
        raise RuntimeError("PTE SHA-256 mismatch")
    prepared = json.loads(args.fixture.read_text(encoding="utf-8"))
    if prepared.get("schemaVersion") != 2:
        raise RuntimeError("expanded fixture schema mismatch")

    load_started = time.perf_counter()
    module = _load_for_executorch(str(args.pte))
    load_ms = (time.perf_counter() - load_started) * 1000.0
    cases = prepared["cases"]
    if not cases or cases[0]["kind"] != "document":
        raise RuntimeError("fixture must start with a document")

    # Prepare the backend once without counting the warm-up.
    embedding(module, cases[0]["embeddingInputs"][0] | {"id": cases[0]["id"]})

    products = []
    queries = []
    measured = 0
    measurement_started = time.perf_counter()
    for item in cases:
        if item["kind"] == "document":
            chunks = []
            primary = None
            for source in item["embeddingInputs"]:
                vector = embedding(module, source | {"id": item["id"]})
                measured += 1
                if source["primary"]:
                    if primary is not None:
                        raise RuntimeError("multiple primary product vectors")
                    primary = vector
                else:
                    chunks.append(
                        {
                            "source": source["source"],
                            "ordinal": source["ordinal"],
                            "fullInputTokens": source["fullInputTokens"],
                            "retainedInputTokens": source[
                                "retainedInputTokens"
                            ],
                            "wasTruncated": source["wasTruncated"],
                            "embedding": vector,
                        }
                    )
            if primary is None:
                raise RuntimeError("primary product vector is missing")
            products.append(
                {
                    "id": item["id"],
                    "title": item["title"],
                    "titleCharacters": len(item["title"]),
                    "bulletCharacters": [
                        len(value) for value in item["bullets"]
                    ],
                    "descriptionCharacters": len(item["description"]),
                    "fullInputTokens": item["fullInputTokens"],
                    "retainedInputTokens": item["retainedInputTokens"],
                    "wasTruncated": item["wasTruncated"],
                    "embedding": primary,
                    "embeddingChunks": chunks,
                }
            )
        else:
            vector = embedding(module, item)
            measured += 1
            queries.append(
                {
                    "id": item["id"],
                    "queryGroupId": item["queryGroupId"],
                    "queryKind": item["queryKind"],
                    "polarity": item["polarity"],
                    "evaluatedProductId": item["evaluatedProductId"],
                    "expectedTopProductId": item["expectedTopProductId"],
                    "fullInputTokens": item["fullInputTokens"],
                    "retainedInputTokens": item["retainedInputTokens"],
                    "wasTruncated": item["wasTruncated"],
                    "embedding": vector,
                }
            )
    measurement_ms = (time.perf_counter() - measurement_started) * 1000.0

    output = {
        "schemaVersion": 1,
        "artifactTarget": "xnnpack_a8w8",
        "embeddingDimension": DIMENSION,
        "embeddingsPerSecond": measured * 1000.0 / measurement_ms,
        "measuredEmbeddings": measured,
        "loadMs": load_ms,
        "measurementMs": measurement_ms,
        "products": products,
        "queries": queries,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(output, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    print(
        f"wrote {len(products)} products and {len(queries)} labeled query "
        f"vectors ({measured} embeddings, "
        f"{output['embeddingsPerSecond']:.6f}/s) to {args.output}"
    )


if __name__ == "__main__":
    main()
