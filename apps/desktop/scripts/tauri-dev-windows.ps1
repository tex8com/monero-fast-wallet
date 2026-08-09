<#
Start the Windows Tauri development app with the MSVC ARM64 environment that
Rust's native dependencies require.  This avoids a misleading `ring`/C-header
failure when `npm run tauri dev` is started from an ordinary PowerShell.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$desktopDirectory = Split-Path -Parent $PSScriptRoot
$RepoRoot = (Resolve-Path (Join-Path $desktopDirectory '..\..')).Path
$vcvars = 'C:\BuildTools\VC\Auxiliary\Build\vcvarsall.bat'

if (-not (Test-Path -LiteralPath $vcvars)) {
  throw "Visual C++ Build Tools were not found at $vcvars. Install the ARM64 C++ build tools first."
}

if ([string]::IsNullOrWhiteSpace($env:CARGO_TARGET_DIR)) {
  # Keep this target separate from test runs and non-Windows host builds.
  # A shared target can leave a locked generated Tauri manifest behind.
  $env:CARGO_TARGET_DIR = Join-Path $env:LOCALAPPDATA 'MoneroFastWallet\tauri-dev-windows-core'
}

# The host itself is built with MSVC, while the pinned native Monero engine is
# an ARM64 GNU DLL. Stage the engine and its three runtime dependencies next to
# the development executable before Cargo starts. The C-ABI bridge rejects the
# build instead of pretending that a missing core is usable.
$core = Join-Path $desktopDirectory 'native-libs\tex8_wallet_core.dll'
if (-not (Test-Path -LiteralPath $core)) {
  throw "Native Monero core DLL is missing: $core"
}
$coreTreeStamp = Join-Path $desktopDirectory 'native-libs\tex8_wallet_core.tree'
if (-not (Test-Path -LiteralPath $coreTreeStamp)) {
  throw "Native Monero core identity is missing: $coreTreeStamp. Rebuild the common Core; old DLLs are not accepted."
}
$coreLock = Join-Path $RepoRoot 'third_party\monero-patches\upstream.lock'
$expectedCoreTree = (Select-String -LiteralPath $coreLock -Pattern '^patched_tree=([0-9a-f]{40})$').Matches.Groups[1].Value
$actualCoreTree = (Get-Content -LiteralPath $coreTreeStamp -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($expectedCoreTree) -or $actualCoreTree -ne $expectedCoreTree) {
  throw "Native Monero core DLL is stale or unauthenticated. Expected $expectedCoreTree, got $actualCoreTree."
}
$runtimeDirectory = Join-Path $env:CARGO_TARGET_DIR 'debug'
New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
Copy-Item -LiteralPath $core -Destination (Join-Path $runtimeDirectory 'tex8_wallet_core.dll') -Force

$llvmMingw = 'C:\Users\rolandkohlhuber\AppData\Local\Microsoft\WinGet\Packages\MartinStorsjo.LLVM-MinGW.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\llvm-mingw-20260616-ucrt-aarch64\bin'
foreach ($runtimeDll in @('libc++.dll', 'libunwind.dll', 'libwinpthread-1.dll')) {
  $source = Join-Path $llvmMingw $runtimeDll
  if (-not (Test-Path -LiteralPath $source)) {
    throw "Required native Monero runtime dependency is missing: $source"
  }
  Copy-Item -LiteralPath $source -Destination (Join-Path $runtimeDirectory $runtimeDll) -Force
}

$env:DESKTOP_WINDOWS_MONERO_CORE_DLL = $core
$env:DESKTOP_WINDOWS_MONERO_CORE_TREE = $actualCoreTree

$command = 'call "{0}" arm64 >nul && cd /d "{1}" && npm run tauri dev' -f $vcvars, $desktopDirectory
cmd.exe /d /s /c $command
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
