[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$DesktopDir = Split-Path -Parent $PSScriptRoot
$RepoRoot = (Resolve-Path (Join-Path $DesktopDir "..\..")).Path
$BuildScript = Join-Path $RepoRoot "native\cuda-derivation\build.ps1"
$BuildDir = if ($env:MONERO_CUDA_BUILD_DIR) { $env:MONERO_CUDA_BUILD_DIR } else { Join-Path $RepoRoot "build\cuda-derivation-windows-x64" }

if ($env:PROCESSOR_ARCHITECTURE -notin @("AMD64", "x86")) {
  throw "The CUDA desktop backend is supported only by the Windows x64 package. Windows ARM64 remains safely CPU-only."
}

$env:MONERO_CUDA_BUILD_DIR = $BuildDir
& $BuildScript

$Library = Join-Path $BuildDir "Release\tex8_wallet_cuda.dll"
if (-not (Test-Path -LiteralPath $Library)) {
  $Library = Join-Path $BuildDir "tex8_wallet_cuda.dll"
}
if (-not (Test-Path -LiteralPath $Library)) {
  throw "CUDA product library was not produced in $BuildDir"
}

$Destination = Join-Path $DesktopDir "native-libs\tex8_wallet_cuda.dll"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
Copy-Item -LiteralPath $Library -Destination $Destination -Force
Write-Host "Staged $Destination"
