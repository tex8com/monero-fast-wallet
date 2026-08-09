$ErrorActionPreference = "Stop"

$CudaSourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = (Resolve-Path (Join-Path $CudaSourceDir "..\..")).Path
$BuildDir = if ($env:MONERO_CUDA_BUILD_DIR) { $env:MONERO_CUDA_BUILD_DIR } else { Join-Path $RepoRoot "build\cuda-derivation" }
$Architectures = if ($env:MONERO_CUDA_ARCHITECTURES) { $env:MONERO_CUDA_ARCHITECTURES } else { "75;86;89;120" }

if (-not (Get-Command cmake -ErrorAction SilentlyContinue)) { throw "cmake is required" }
if (-not (Get-Command nvcc -ErrorAction SilentlyContinue)) { throw "CUDA nvcc is required" }

cmake -S $CudaSourceDir -B $BuildDir -A x64 `
  -DCMAKE_BUILD_TYPE=Release `
  "-DCMAKE_CUDA_ARCHITECTURES=$Architectures"
cmake --build $BuildDir --config Release --parallel

Write-Host "CUDA product library built in $BuildDir"
