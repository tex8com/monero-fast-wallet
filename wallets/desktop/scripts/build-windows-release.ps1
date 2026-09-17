<#
Build the complete Windows ARM64 release from the authenticated common Core.
The Core DLL is MinGW/ARM64 behind a stable C ABI; the Tauri host is MSVC/ARM64.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$MoneroSource,

  [Parameter(Mandatory = $true)]
  [string]$CoreBuildDirectory,

  [string]$LlvmMingwDirectory = 'C:\Users\rolandkohlhuber\AppData\Local\Microsoft\WinGet\Packages\MartinStorsjo.LLVM-MinGW.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\llvm-mingw-20260616-ucrt-aarch64\bin',

  [string]$VcpkgPrefix = 'C:\tex8-build\vcpkg-mingw-arm64\arm64-mingw-static',

  [string]$VcpkgRoot = 'C:\tex8-src\vcpkg',

  [string]$GrpcVcpkgInstallRoot = 'C:\tex8-build\vcpkg-grpc-arm64',

  [string]$GrpcVcpkgTargetTriplet = 'arm64-mingw-static-release'
)

$ErrorActionPreference = 'Stop'
$desktopDirectory = Split-Path -Parent $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $desktopDirectory '..\..')).Path
$nativeLibraries = Join-Path $desktopDirectory 'native-libs'
$coreLock = Join-Path $repoRoot 'third_party\monero-patches\upstream.lock'
$vcvars = 'C:\BuildTools\VC\Auxiliary\Build\vcvarsall.bat'
$cmake = 'C:\Program Files\CMake\bin\cmake.exe'
$productCoreRoot = Join-Path $repoRoot 'native\product-core'
$fastWalletProtocolRoot = Join-Path $repoRoot 'native\fast-wallet-protocol'
$fastCryptoRoot = Join-Path $MoneroSource 'external\monero-fast-crypto'
$walletCpuPackage = Join-Path $repoRoot 'third_party\curve25519-dalek-wallet-cpu'
$walletCpuLock = Join-Path $walletCpuPackage 'upstream.lock'
$walletCpuSeries = Join-Path $walletCpuPackage 'series'
$walletCpuSource = Join-Path (Split-Path -Parent $CoreBuildDirectory) 'curve25519-dalek-wallet-cpu'
$fastCryptoTarget = Join-Path (Split-Path -Parent $CoreBuildDirectory) 'monero-fast-crypto-gnullvm'
$productCoreTarget = Join-Path $CoreBuildDirectory 'mfw-product-core-gnullvm'
$fastWalletProtocolTarget = Join-Path $CoreBuildDirectory 'fast-wallet-protocol-gnullvm'
$grpcTargetPrefix = Join-Path $GrpcVcpkgInstallRoot $GrpcVcpkgTargetTriplet
$grpcHostPrefix = Join-Path $GrpcVcpkgInstallRoot 'arm64-windows'
$grpcPkgConfigDirectory = Join-Path $grpcTargetPrefix 'lib\pkgconfig'
$vcpkgInstalledRoot = Split-Path -Parent $VcpkgPrefix
$vcpkgTargetTriplet = 'arm64-mingw-static'
$vcpkgLibraryDirectory = Join-Path $VcpkgPrefix 'lib'
$icuIoLibrary = Join-Path $vcpkgLibraryDirectory 'libicuio.a'
$icuInLibrary = Join-Path $vcpkgLibraryDirectory 'libicuin.a'
$icuUcLibrary = Join-Path $vcpkgLibraryDirectory 'libicuuc.a'
$icuDataLibrary = Join-Path $vcpkgLibraryDirectory 'icudt.a'
$icuTuLibrary = Join-Path $vcpkgLibraryDirectory 'libicutu.a'
$iconvLibrary = Join-Path $vcpkgLibraryDirectory 'libiconv.a'
$vcpkgExecutable = Join-Path $VcpkgRoot 'vcpkg.exe'
$vcpkgOverlayPorts = Join-Path $desktopDirectory 'windows\vcpkg-overlays'
$vcpkgOverlayTriplets = Join-Path $desktopDirectory 'windows'

$env:Path = "$LlvmMingwDirectory;$env:Path"

foreach ($required in @(
  $VcpkgRoot,
  $vcpkgExecutable,
  $vcpkgOverlayPorts,
  (Join-Path $vcpkgOverlayPorts 'grpc\portfile.cmake'),
  (Join-Path $vcpkgOverlayTriplets "$GrpcVcpkgTargetTriplet.cmake")
)) {
  if (-not (Test-Path -LiteralPath $required)) {
    throw "Required Windows gRPC build input is missing: $required"
  }
}

& $vcpkgExecutable install "grpc:$GrpcVcpkgTargetTriplet" "curl:$GrpcVcpkgTargetTriplet" `
  '--host-triplet=arm64-windows' `
  "--x-install-root=$GrpcVcpkgInstallRoot" `
  "--overlay-ports=$vcpkgOverlayPorts" `
  "--overlay-triplets=$vcpkgOverlayTriplets" `
  '--clean-after-build'
if ($LASTEXITCODE -ne 0) { throw 'The native Windows ARM64 network dependency build failed.' }

# Older installations made from the same upstream gRPC release can retain a
# pkg-config-only CMake alias (`utf8_range_lib`) that has no archive on disk.
# Fresh overlay builds no longer emit it; normalize an existing build cache so
# incremental releases are identical to clean releases.
$utf8 = [System.Text.UTF8Encoding]::new($false)
foreach ($pkgConfigFile in Get-ChildItem -LiteralPath $grpcPkgConfigDirectory -Filter '*.pc' -File) {
  $contents = [System.IO.File]::ReadAllText($pkgConfigFile.FullName)
  $normalized = $contents.Replace(' -lutf8_range_lib', '')
  if ($normalized -ne $contents) {
    [System.IO.File]::WriteAllText($pkgConfigFile.FullName, $normalized, $utf8)
  }
}

function Resolve-FirstExistingPath {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Candidates,

    [Parameter(Mandatory = $true)]
    [string]$Description
  )

  foreach ($candidate in $Candidates) {
    if (Test-Path -LiteralPath $candidate) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }
  throw "$Description is missing. Checked: $($Candidates -join ', ')"
}

$grpcPlugin = Resolve-FirstExistingPath -Description 'The native ARM64 gRPC code generator' -Candidates @(
  (Join-Path $grpcHostPrefix 'tools\grpc\grpc_cpp_plugin.exe'),
  (Join-Path $grpcTargetPrefix 'tools\grpc\grpc_cpp_plugin.exe')
)
$protoc = Resolve-FirstExistingPath -Description 'The native ARM64 protobuf compiler' -Candidates @(
  (Join-Path $grpcHostPrefix 'tools\protobuf\protoc.exe'),
  (Join-Path $grpcTargetPrefix 'tools\protobuf\protoc.exe'),
  (Join-Path $VcpkgPrefix 'tools\protobuf\protoc.exe')
)
$pkgConfigExecutable = Get-ChildItem -LiteralPath (Join-Path $VcpkgRoot 'downloads\tools\msys2') `
  -Filter 'pkgconf.exe' -File -Recurse -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match '\\clangarm64\\bin\\pkgconf\.exe$' } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
if ($null -eq $pkgConfigExecutable) {
  throw 'The native Windows ARM64 pkgconf executable was not produced by vcpkg.'
}
$pkgConfig = $pkgConfigExecutable.FullName

foreach ($required in @(
  $MoneroSource,
  $CoreBuildDirectory,
  $LlvmMingwDirectory,
  $coreLock,
  $vcvars,
  $cmake,
  $productCoreRoot,
  $fastWalletProtocolRoot,
  $fastCryptoRoot,
  (Join-Path $fastCryptoRoot 'Cargo.toml'),
  (Join-Path $fastCryptoRoot 'Cargo.lock'),
  $walletCpuPackage,
  $walletCpuLock,
  $walletCpuSeries,
  $grpcTargetPrefix,
  $grpcPkgConfigDirectory,
  $grpcPlugin,
  $protoc,
  $pkgConfig,
  $vcpkgLibraryDirectory,
  $icuIoLibrary,
  $icuInLibrary,
  $icuUcLibrary,
  $icuDataLibrary,
  $icuTuLibrary,
  $iconvLibrary
)) {
  if (-not (Test-Path -LiteralPath $required)) {
    throw "Required Windows release input is missing: $required"
  }
}

# The authenticated Core checkout is read through the Parallels Z: drive.
# Git canonicalizes that drive to its UNC provider path before applying
# safe.directory, so register both exact spellings process-locally. Never
# weaken the ownership check globally or trust unrelated repositories.
$gitSafeDirectories = @(
  $MoneroSource,
  (Join-Path $MoneroSource 'external\miniupnp'),
  (Join-Path $MoneroSource 'external\randomx'),
  (Join-Path $MoneroSource 'external\rapidjson'),
  (Join-Path $MoneroSource 'external\supercop'),
  (Join-Path $MoneroSource 'external\trezor-common')
)
$gitSafeValues = [System.Collections.Generic.List[string]]::new()
foreach ($directory in $gitSafeDirectories) {
  $normalized = $directory.Replace('\', '/')
  $gitSafeValues.Add($normalized)
  if ($normalized -match '^([A-Za-z]):/(.*)$') {
    $drive = Get-PSDrive -Name $Matches[1] -ErrorAction SilentlyContinue
    $providerRoot = if ($null -ne $drive -and
      -not [string]::IsNullOrWhiteSpace($drive.DisplayRoot)) {
      $drive.DisplayRoot
    } elseif ($null -ne $drive) {
      $drive.Root
    }
    if (-not [string]::IsNullOrWhiteSpace($providerRoot) -and
      $providerRoot.StartsWith('\\')) {
      $unc = ($providerRoot.TrimEnd('\') + '\' + $Matches[2]).Replace('\', '/')
      $gitSafeValues.Add("%(prefix)/$unc")
    }
  }
}
$env:GIT_CONFIG_COUNT = [string]$gitSafeValues.Count
for ($index = 0; $index -lt $gitSafeValues.Count; $index++) {
  Set-Item -Path "Env:GIT_CONFIG_KEY_$index" -Value 'safe.directory'
  Set-Item -Path "Env:GIT_CONFIG_VALUE_$index" -Value $gitSafeValues[$index]
}

$expectedCoreTree = (Select-String -LiteralPath $coreLock -Pattern '^patched_tree=([0-9a-f]{40})$').Matches.Groups[1].Value
if ([string]::IsNullOrWhiteSpace($expectedCoreTree)) {
  throw "The pinned Monero Core tree is missing from $coreLock"
}
$safeSource = $MoneroSource.Replace('\', '/')
$actualCoreTree = (& git.exe -c "safe.directory=$safeSource" -C $MoneroSource rev-parse 'HEAD^{tree}').Trim()
if ($LASTEXITCODE -ne 0 -or $actualCoreTree -ne $expectedCoreTree) {
  throw "The Windows Core source is unauthenticated. Expected $expectedCoreTree, got $actualCoreTree."
}

$pkgConfigDirectories = @(
  $grpcPkgConfigDirectory,
  (Join-Path $grpcTargetPrefix 'share\pkgconfig'),
  (Join-Path $VcpkgPrefix 'lib\pkgconfig'),
  (Join-Path $VcpkgPrefix 'share\pkgconfig')
) | Where-Object { Test-Path -LiteralPath $_ }
$env:PKG_CONFIG_PATH = $pkgConfigDirectories -join ';'
$env:PKG_CONFIG = $pkgConfig

# Materialize the authenticated wallet-specific Dalek backend on Windows.
# Cargo's lock intentionally has no registry checksum for this path override.
function Get-WalletCpuLockValue {
  param([Parameter(Mandatory = $true)][string]$Name)
  $match = Select-String -LiteralPath $walletCpuLock -Pattern "^$([regex]::Escape($Name))=(.+)$"
  if ($null -eq $match) { throw "Missing $Name in $walletCpuLock" }
  return $match.Matches[0].Groups[1].Value
}
$walletCpuRepository = Get-WalletCpuLockValue 'repository'
$walletCpuBaseCommit = Get-WalletCpuLockValue 'base_commit'
$walletCpuPatchedTree = Get-WalletCpuLockValue 'patched_crate_tree'
if (-not (Test-Path -LiteralPath (Join-Path $walletCpuSource '.git'))) {
  if ((Test-Path -LiteralPath $walletCpuSource) -and
    (Get-ChildItem -LiteralPath $walletCpuSource -Force | Select-Object -First 1)) {
    throw "The Windows wallet CPU source directory exists but is not a Git checkout: $walletCpuSource"
  }
  & git.exe clone --no-checkout $walletCpuRepository $walletCpuSource
  if ($LASTEXITCODE -ne 0) { throw 'The pinned Dalek source checkout failed.' }
  & git.exe -C $walletCpuSource checkout --detach $walletCpuBaseCommit
  if ($LASTEXITCODE -ne 0) { throw 'The pinned Dalek base checkout failed.' }
}
$walletCpuStatus = (& git.exe -C $walletCpuSource status --porcelain --untracked-files=all) -join "`n"
if ($LASTEXITCODE -ne 0 -or -not [string]::IsNullOrWhiteSpace($walletCpuStatus)) {
  throw 'The Windows wallet CPU dependency contains uncommitted or untracked changes.'
}
$walletCpuActualTree = (& git.exe -C $walletCpuSource rev-parse 'HEAD:curve25519-dalek').Trim()
if ($LASTEXITCODE -ne 0) { throw 'The Dalek crate tree could not be read.' }
if ($walletCpuActualTree -ne $walletCpuPatchedTree) {
  $walletCpuHead = (& git.exe -C $walletCpuSource rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $walletCpuHead -ne $walletCpuBaseCommit) {
    throw "Unexpected Dalek source state: $walletCpuHead"
  }
  $walletCpuPatches = @()
  foreach ($patchEntry in Get-Content -LiteralPath $walletCpuSeries) {
    $patchEntry = $patchEntry.Trim()
    if ([string]::IsNullOrWhiteSpace($patchEntry)) { continue }
    $patchPath = Join-Path $walletCpuPackage $patchEntry
    if (-not (Test-Path -LiteralPath $patchPath)) { throw "Missing wallet CPU patch: $patchPath" }
    $walletCpuPatches += $patchPath
  }
  & git.exe -c 'user.name=TEX8 dependency builder' `
    -c 'user.email=dependency-builder@invalid' `
    -C $walletCpuSource am --committer-date-is-author-date @walletCpuPatches
  if ($LASTEXITCODE -ne 0) {
    & git.exe -C $walletCpuSource am --abort
    throw 'The authenticated wallet CPU patch series did not apply cleanly.'
  }
  $walletCpuActualTree = (& git.exe -C $walletCpuSource rev-parse 'HEAD:curve25519-dalek').Trim()
}
if ($walletCpuActualTree -ne $walletCpuPatchedTree) {
  throw "The wallet CPU dependency tree is invalid. Expected $walletCpuPatchedTree, got $walletCpuActualTree."
}
$walletCpuCrate = Join-Path $walletCpuSource 'curve25519-dalek'
$walletCpuCargoPath = $walletCpuCrate.Replace('\', '/')

& cargo.exe build --release --locked --target aarch64-pc-windows-gnullvm `
  --config "patch.crates-io.curve25519-dalek.path='$walletCpuCargoPath'" `
  --manifest-path (Join-Path $fastCryptoRoot 'Cargo.toml') `
  --target-dir $fastCryptoTarget
if ($LASTEXITCODE -ne 0) { throw 'The Windows Monero Fast Crypto build failed.' }
$fastCryptoLibrary = Join-Path $fastCryptoTarget 'aarch64-pc-windows-gnullvm\release\libmonero_fast_crypto.a'
if (-not (Test-Path -LiteralPath $fastCryptoLibrary)) {
  throw 'The Windows Monero Fast Crypto static library was not produced.'
}
$llvmNm = Join-Path $LlvmMingwDirectory 'llvm-nm.exe'
if (-not (Test-Path -LiteralPath $llvmNm)) {
  throw "The LLVM symbol verifier is missing: $llvmNm"
}
$fastCryptoExports = (& $llvmNm -g --defined-only $fastCryptoLibrary) -join "`n"
if ($LASTEXITCODE -ne 0 -or
  $fastCryptoExports -notmatch '(^|\s)fast_generate_key_derivation_batch_same_scalar(\s|$)') {
  throw 'The Windows Monero Fast Crypto library is stale or incomplete: the batch-same-scalar export is missing.'
}

& cargo.exe build --release --locked --target aarch64-pc-windows-gnullvm `
  --manifest-path (Join-Path $productCoreRoot 'Cargo.toml') `
  --target-dir $productCoreTarget
if ($LASTEXITCODE -ne 0) { throw 'The Windows Product Core build failed.' }
& cargo.exe build --release --locked --target aarch64-pc-windows-gnullvm `
  --manifest-path (Join-Path $fastWalletProtocolRoot 'Cargo.toml') `
  --target-dir $fastWalletProtocolTarget
if ($LASTEXITCODE -ne 0) { throw 'The Windows Fast Wallet protocol build failed.' }

$productCoreRuntime = Get-ChildItem -LiteralPath $productCoreTarget -Filter 'mfw_product_core.dll' -File -Recurse |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
$productCoreLibrary = Get-ChildItem -LiteralPath $productCoreTarget -Filter 'libmfw_product_core.dll.a' -File -Recurse |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
$fastWalletProtocolRuntime = Get-ChildItem -LiteralPath $fastWalletProtocolTarget -Filter 'fast_wallet_protocol.dll' -File -Recurse |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
$fastWalletProtocolLibrary = Get-ChildItem -LiteralPath $fastWalletProtocolTarget -Filter 'libfast_wallet_protocol.dll.a' -File -Recurse |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
if ($null -eq $productCoreRuntime -or $null -eq $productCoreLibrary) {
  throw 'The Windows Product Core DLL and import library were not produced.'
}
if ($null -eq $fastWalletProtocolRuntime -or $null -eq $fastWalletProtocolLibrary) {
  throw 'The Windows Fast Wallet protocol DLL and import library were not produced.'
}

$inject = Join-Path $desktopDirectory 'windows\monero-bridge-inject.cmake'
$bridge = Join-Path $repoRoot 'native\desktop-bridge'
& $cmake '-U*GRPC*' -S $MoneroSource -B $CoreBuildDirectory `
  "-DCMAKE_PROJECT_INCLUDE=$inject" `
  "-DTEX8_DESKTOP_BRIDGE_ROOT=$bridge" `
  '-DTEX8_DESKTOP_BUILD_BRIDGE=ON' `
  "-DTEX8_WINDOWS_VCPKG_LIB=$vcpkgLibraryDirectory" `
  "-DCMAKE_PREFIX_PATH=$grpcTargetPrefix;$VcpkgPrefix" `
  "-DVCPKG_INSTALLED_DIR=$vcpkgInstalledRoot" `
  "-DVCPKG_TARGET_TRIPLET=$vcpkgTargetTriplet" `
  "-DPKG_CONFIG_EXECUTABLE=$pkgConfig" `
  "-DICUIO_LIBRARIES=$icuIoLibrary" `
  "-DICUIN_LIBRARIES=$icuInLibrary" `
  "-DICUUC_LIBRARIES=$icuUcLibrary" `
  "-DICUDT_LIBRARIES=$icuDataLibrary" `
  "-DICUTU_LIBRARIES=$icuTuLibrary" `
  "-DICONV_LIBRARIES=$iconvLibrary" `
  '-DMONERO_ENABLE_GRPC_STREAM=ON' `
  "-DGRPC_CPP_PLUGIN_PATH=$grpcPlugin" `
  "-DPROTOC_PATH=$protoc" `
  "-DMFW_PRODUCT_CORE_ROOT=$productCoreRoot" `
  "-DMFW_PRODUCT_CORE_LIBRARY=$($productCoreLibrary.FullName)" `
  "-DMFW_FAST_WALLET_PROTOCOL_ROOT=$fastWalletProtocolRoot" `
  "-DMFW_FAST_WALLET_PROTOCOL_LIBRARY=$($fastWalletProtocolLibrary.FullName)" `
  "-DMONERO_FAST_CRYPTO_INCLUDE_DIR=$(Join-Path $fastCryptoRoot 'include')" `
  "-DMONERO_FAST_CRYPTO_LIBRARY=$fastCryptoLibrary" `
  '-DMANUAL_SUBMODULES=1'
if ($LASTEXITCODE -ne 0) { throw 'The Windows Core configure step failed.' }

& $cmake --build $CoreBuildDirectory --target tex8_wallet_core --config Release
if ($LASTEXITCODE -ne 0) { throw 'The Windows Core build failed.' }

$core = Get-ChildItem -LiteralPath $CoreBuildDirectory -Filter 'libtex8_wallet_core.dll' -File -Recurse |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
if ($null -eq $core) { throw 'The Windows Core DLL was not produced.' }

New-Item -ItemType Directory -Force -Path $nativeLibraries | Out-Null
Copy-Item -LiteralPath $core.FullName -Destination (Join-Path $nativeLibraries 'tex8_wallet_core.dll') -Force
Copy-Item -LiteralPath $fastWalletProtocolRuntime.FullName -Destination (Join-Path $nativeLibraries 'fast_wallet_protocol.dll') -Force
Set-Content -LiteralPath (Join-Path $nativeLibraries 'tex8_wallet_core.tree') -Value $actualCoreTree -NoNewline
foreach ($runtimeDll in @('libc++.dll', 'libunwind.dll', 'libwinpthread-1.dll')) {
  $source = Join-Path $LlvmMingwDirectory $runtimeDll
  if (-not (Test-Path -LiteralPath $source)) {
    throw "Required native Core runtime is missing: $source"
  }
  Copy-Item -LiteralPath $source -Destination (Join-Path $nativeLibraries $runtimeDll) -Force
}

$env:DESKTOP_WINDOWS_MONERO_CORE_DLL = Join-Path $nativeLibraries 'tex8_wallet_core.dll'
$env:DESKTOP_WINDOWS_MONERO_CORE_TREE = $actualCoreTree
$env:DESKTOP_REQUIRE_MONERO = '1'
$env:CARGO_TARGET_DIR = 'C:\tex8-build\desktop-cargo-target-v2'

Push-Location $desktopDirectory
try {
  # Finder/SMB can leave AppleDouble sidecar files when this release tree is
  # staged from macOS. Tauri scans the permissions directory as UTF-8 TOML, so
  # those binary `._*` files must never enter the Windows application manifest.
  Get-ChildItem -LiteralPath $desktopDirectory -Recurse -Force -File -Filter '._*' |
    Remove-Item -Force

  & npm.cmd ci
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
  foreach ($script in @(
    'check',
    'test:parity-contract',
    'test:connection-contract',
    'test:news-contract',
    'test:mfw-contract',
    'test:update-contract',
    'test:push-contract',
    'test:platform-contract',
    'test:acceleration-contract',
    'test:wallet-contract'
  )) {
    & npm.cmd run $script
    if ($LASTEXITCODE -ne 0) { throw "Desktop gate failed: $script" }
  }

  $releaseDirectory = Join-Path $env:CARGO_TARGET_DIR 'release'
  New-Item -ItemType Directory -Force -Path $releaseDirectory | Out-Null
  foreach ($runtimeFile in @('tex8_wallet_core.dll', 'fast_wallet_protocol.dll', 'libc++.dll', 'libunwind.dll', 'libwinpthread-1.dll')) {
    Copy-Item -LiteralPath (Join-Path $nativeLibraries $runtimeFile) -Destination $releaseDirectory -Force
  }

  # NumKong 7.7.1 infers x86 kernels from the MSVC toolset version even when
  # compiling for Windows ARM64. Force only those foreign targets off while
  # retaining the probed ARM64/NEON kernels used by the community search.
  $numKongForeignTargets = @(
    'NK_TARGET_HASWELL',
    'NK_TARGET_SKYLAKE',
    'NK_TARGET_ICELAKE',
    'NK_TARGET_GENOA',
    'NK_TARGET_SAPPHIRE',
    'NK_TARGET_SAPPHIREAMX',
    'NK_TARGET_GRANITEAMX',
    'NK_TARGET_DIAMOND',
    'NK_TARGET_TURIN',
    'NK_TARGET_ALDER',
    'NK_TARGET_SIERRA'
  )
  # Cargo's cc crate invokes the native ARM64 MSVC compiler directly. Unlike
  # CMake/MSBuild, that path does not add the Windows SDK's `_ARM64_` selector,
  # so winnt.h otherwise rejects the translation unit before NumKong can build.
  $numKongForeignTargetFlags = @('-D_ARM64_=1') + ($numKongForeignTargets | ForEach-Object { "-D$_=0" })
  $numKongForeignTargetFlags = $numKongForeignTargetFlags -join ' '
  $existingArm64MsvcCFlags = [Environment]::GetEnvironmentVariable('CFLAGS_aarch64_pc_windows_msvc')
  $existingArm64MsvcCxxFlags = [Environment]::GetEnvironmentVariable('CXXFLAGS_aarch64_pc_windows_msvc')
  $env:CFLAGS_aarch64_pc_windows_msvc = "$existingArm64MsvcCFlags $numKongForeignTargetFlags".Trim()
  $env:CXXFLAGS_aarch64_pc_windows_msvc = "$existingArm64MsvcCxxFlags $numKongForeignTargetFlags".Trim()

  # Build the closed-app notification helper before the normal Windows config
  # validates it as a bundled resource. The temporary override disables only
  # packaging validation for this bootstrap build; the final Tauri build below
  # uses the complete Windows resource map.
  $env:TAURI_CONFIG = '{"bundle":{"resources":[]}}'
  $bootstrapCommand = 'call "{0}" arm64 >nul && cd /d "{1}" && cargo build --manifest-path src-tauri\Cargo.toml --release --bin monero-fast-walletd' -f $vcvars, $desktopDirectory
  & cmd.exe /d /s /c $bootstrapCommand
  $bootstrapExitCode = $LASTEXITCODE
  Remove-Item Env:TAURI_CONFIG -ErrorAction SilentlyContinue
  if ($bootstrapExitCode -ne 0) { throw 'The Windows notification helper build failed.' }

  $manifestHelperDirectory = Join-Path $desktopDirectory 'src-tauri\target\release'
  New-Item -ItemType Directory -Force -Path $manifestHelperDirectory | Out-Null
  Copy-Item -LiteralPath (Join-Path $releaseDirectory 'monero-fast-walletd.exe') `
    -Destination (Join-Path $manifestHelperDirectory 'monero-fast-walletd.exe') -Force

  $command = 'call "{0}" arm64 >nul && cd /d "{1}" && cargo test --release --manifest-path src-tauri\Cargo.toml && npm run tauri build -- --bundles nsis --config src-tauri\tauri.windows.conf.json' -f $vcvars, $desktopDirectory
  & cmd.exe /d /s /c $command
  if ($LASTEXITCODE -ne 0) { throw 'The Windows release build failed.' }
} finally {
  Pop-Location
}

$installer = Get-ChildItem -LiteralPath (Join-Path $env:CARGO_TARGET_DIR 'release\bundle\nsis') -Filter '*setup.exe' -File |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
if ($null -eq $installer) { throw 'The Windows NSIS installer was not produced.' }
$installer | Select-Object FullName, Length, LastWriteTime
