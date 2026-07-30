#!/usr/bin/env python3
"""Fail-closed unit tests for the Harrier vector comparison boundary."""

from __future__ import annotations

import copy
import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from compare_embeddings import DIMENSION, cosine, require_vector_document


def vector_document() -> dict[str, object]:
    embedding = [0.0] * DIMENSION
    embedding[0] = 1.0
    return {
        "dimension": DIMENSION,
        "vectors": [
            {"id": f"case-{index}", "embedding": list(embedding)}
            for index in range(32)
        ],
    }


class VectorDocumentTests(unittest.TestCase):
    def test_accepts_minimum_normalized_fixture(self) -> None:
        fixture = vector_document()
        self.assertIs(require_vector_document(fixture, "fixture"), fixture)
        self.assertTrue(
            math.isclose(
                cosine(
                    fixture["vectors"][0]["embedding"],
                    fixture["vectors"][1]["embedding"],
                ),
                1.0,
            )
        )

    def test_rejects_duplicate_case_identifier(self) -> None:
        fixture = vector_document()
        fixture["vectors"][1]["id"] = fixture["vectors"][0]["id"]
        with self.assertRaisesRegex(RuntimeError, "duplicate case id"):
            require_vector_document(fixture, "fixture")

    def test_rejects_non_finite_component(self) -> None:
        fixture = vector_document()
        fixture["vectors"][0]["embedding"][0] = float("nan")
        with self.assertRaisesRegex(RuntimeError, "non-finite"):
            require_vector_document(fixture, "fixture")

    def test_rejects_non_normalized_vector(self) -> None:
        fixture = vector_document()
        fixture["vectors"][0]["embedding"][0] = 0.5
        with self.assertRaisesRegex(RuntimeError, "not L2-normalized"):
            require_vector_document(fixture, "fixture")

    def test_rejects_wrong_dimension(self) -> None:
        fixture = copy.deepcopy(vector_document())
        fixture["vectors"][0]["embedding"].pop()
        with self.assertRaisesRegex(RuntimeError, "640-dimensional"):
            require_vector_document(fixture, "fixture")


if __name__ == "__main__":
    unittest.main()
