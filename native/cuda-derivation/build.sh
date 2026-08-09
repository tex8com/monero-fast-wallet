#!/usr/bin/env bash
set -euo pipefail

cuda_source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cuda_repo_root="$(cd "${cuda_source_dir}/../.." && pwd)"
cuda_build_dir="${MONERO_CUDA_BUILD_DIR:-${cuda_repo_root}/build/cuda-derivation}"
cuda_architectures="${MONERO_CUDA_ARCHITECTURES:-75;86;89;120}"

command -v cmake >/dev/null || { echo "cmake is required" >&2; exit 1; }
command -v nvcc >/dev/null || { echo "CUDA nvcc is required" >&2; exit 1; }

cmake -S "${cuda_source_dir}" -B "${cuda_build_dir}" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CUDA_ARCHITECTURES="${cuda_architectures}"
cmake --build "${cuda_build_dir}" --config Release --parallel

printf '%s\n' "CUDA product library built in ${cuda_build_dir}"
