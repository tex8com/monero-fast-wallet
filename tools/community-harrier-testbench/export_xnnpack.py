#!/usr/bin/env python3
"""Export the pinned Harrier embedding contract to ExecuTorch XNNPACK.

Optimum ExecuTorch supports Gemma 3 text generation, but its pinned exporter
does not provide a feature-extraction task. This wrapper exports only the
wallet's required boundary: token ids + attention mask -> one normalized
640-dimensional embedding.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import subprocess
from dataclasses import asdict
from pathlib import Path

import torch
from executorch.backends.xnnpack.partition.xnnpack_partitioner import (
    XnnpackPartitioner,
)
from executorch.devtools.backend_debug import get_delegation_info
from executorch.exir import (
    EdgeCompileConfig,
    ExecutorchBackendConfig,
    to_edge_transform_and_lower,
)
from executorch.exir.passes import MemoryPlanningPass
from optimum.executorch.passes.remove_padding_idx_embedding_pass import (
    RemovePaddingIdxEmbeddingPass,
)
from optimum.exporters.executorch.quantization import quantize_model_
from torchao.utils import unwrap_tensor_subclass
from transformers import AutoModel, AutoTokenizer

MODEL_ID = "microsoft/harrier-oss-v1-270m"
MODEL_REVISION = "31de22b673913c7d658c0f03f792d77c2dcf8ebd"
MODEL_SHA256 = "90933b6826b61afd9331e0ebe3c0598b421a32eda5fb301a114fe36f306cb51a"
TOKENIZER_SHA256 = "6852f8d561078cc0cebe70ca03c5bfdd0d60a45f9d2e0e1e4cc05b68e9ec329e"
EXPORTER_REVISION = "d1140eca622900404c1c5af3f74425034c239f37"
EXECUTORCH_VERSION = "1.3.1"
TORCH_VERSION = "2.12.0"
TORCHAO_VERSION = "0.17.0+cpu"
TRANSFORMERS_VERSION = "5.0.0rc1"
MAX_INPUT_TOKENS = 256
DIMENSION = 640


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


def require_distribution_version(name: str, expected: str) -> None:
    actual = importlib.metadata.version(name)
    if actual != expected:
        raise RuntimeError(f"{name} must be {expected}, found {actual}")


def require_exporter_revision(path: Path) -> None:
    actual = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=path,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    if actual != EXPORTER_REVISION:
        raise RuntimeError(
            f"optimum-executorch must be {EXPORTER_REVISION}, found {actual}"
        )


class HarrierEmbeddingModule(torch.nn.Module):
    """Static V1 inference boundary with pooling and normalization included."""

    def __init__(self, model: torch.nn.Module) -> None:
        super().__init__()
        self.model = model

    def forward(
        self,
        input_ids: torch.Tensor,
        attention_mask: torch.Tensor,
    ) -> torch.Tensor:
        hidden = self.model(
            input_ids=input_ids,
            attention_mask=attention_mask,
            use_cache=False,
            return_dict=False,
        )[0]
        sequence_lengths = attention_mask.to(torch.int64).sum(dim=1) - 1
        batch = torch.arange(hidden.shape[0], device=hidden.device)
        pooled = hidden[batch, sequence_lengths].to(torch.float32)
        squared_norm = (pooled * pooled).sum(dim=1, keepdim=True)
        return pooled * torch.rsqrt(torch.clamp(squared_norm, min=1e-12))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--model-cache", type=Path, required=True)
    parser.add_argument("--exporter-source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument(
        "--linear-quantization",
        choices=("8da8w",),
        default="8da8w",
    )
    args = parser.parse_args()

    require_distribution_version("executorch", EXECUTORCH_VERSION)
    require_distribution_version("torch", TORCH_VERSION)
    require_distribution_version("torchao", TORCHAO_VERSION)
    require_distribution_version("transformers", TRANSFORMERS_VERSION)
    require_exporter_revision(args.exporter_source)
    require_hash(args.model_dir / "model.safetensors", MODEL_SHA256)
    require_hash(args.model_dir / "tokenizer.json", TOKENIZER_SHA256)

    tokenizer = AutoTokenizer.from_pretrained(
        MODEL_ID,
        revision=MODEL_REVISION,
        cache_dir=args.model_cache,
        local_files_only=True,
        trust_remote_code=False,
    )
    sample = tokenizer(
        ["privacy-friendly Monero wallet"],
        max_length=MAX_INPUT_TOKENS,
        padding="max_length",
        truncation=True,
        return_tensors="pt",
    )

    eager_model = AutoModel.from_pretrained(
        args.model_dir,
        local_files_only=True,
        trust_remote_code=False,
        dtype=torch.float32,
        attn_implementation="sdpa",
    ).eval()
    eager_model.config.use_cache = False
    if eager_model.config.hidden_size != DIMENSION:
        raise RuntimeError(
            f"Harrier hidden size must be {DIMENSION}, found "
            f"{eager_model.config.hidden_size}"
        )
    quantize_model_(
        eager_model,
        qlinear_config=args.linear_quantization,
        qlinear_group_size=0,
        qembedding_config="8w",
        qembedding_group_size=0,
    )
    module = unwrap_tensor_subclass(HarrierEmbeddingModule(eager_model).eval())
    inputs = (sample["input_ids"], sample["attention_mask"])
    exported = torch.export.export(module, inputs, strict=True)

    edge = to_edge_transform_and_lower(
        {"forward": exported},
        partitioner=[XnnpackPartitioner()],
        compile_config=EdgeCompileConfig(
            _check_ir_validity=False,
            _skip_dim_order=True,
        ),
        transform_passes=[RemovePaddingIdxEmbeddingPass()],
    )
    program = edge.to_executorch(
        config=ExecutorchBackendConfig(
            extract_delegate_segments=True,
            memory_planning_pass=MemoryPlanningPass(alloc_graph_input=False),
            do_quant_fusion_and_const_prop=True,
        )
    )
    delegation = get_delegation_info(program.exported_program("forward").graph_module)
    if delegation.num_delegated_subgraphs == 0 or delegation.num_delegated_nodes == 0:
        raise RuntimeError("XNNPACK export contains no delegated computation")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("wb") as destination:
        program.write_to_file(destination)

    operators = {
        name: asdict(value)
        for name, value in sorted(delegation.delegation_by_operator.items())
    }
    report = {
        "schemaVersion": 1,
        "target": "xnnpack-a8w8",
        "modelId": MODEL_ID,
        "sourceRevision": MODEL_REVISION,
        "sourceWeightsSha256": MODEL_SHA256,
        "tokenizerSha256": TOKENIZER_SHA256,
        "exporterRevision": EXPORTER_REVISION,
        "executorchVersion": EXECUTORCH_VERSION,
        "torchVersion": TORCH_VERSION,
        "torchaoVersion": TORCHAO_VERSION,
        "transformersVersion": TRANSFORMERS_VERSION,
        "maxInputTokens": MAX_INPUT_TOKENS,
        "dimension": DIMENSION,
        "linearQuantization": "8da8w-per-axis",
        "embeddingQuantization": "8w-per-axis",
        "pteSha256": sha256_file(args.output),
        "pteBytes": args.output.stat().st_size,
        "delegatedSubgraphs": delegation.num_delegated_subgraphs,
        "delegatedNodes": delegation.num_delegated_nodes,
        "nonDelegatedNodes": delegation.num_non_delegated_nodes,
        "operators": operators,
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(
        json.dumps(report, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    print(
        f"wrote {args.output} ({report['pteBytes']} bytes, "
        f"{delegation.num_delegated_nodes} delegated nodes)"
    )


if __name__ == "__main__":
    main()
