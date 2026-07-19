<#
Run the WNS MSIX check *as the signed-in Windows user*.

`prlctl exec` uses Local System, which cannot install a per-user MSIX or
create a user WNS channel. The host creates a scheduled task with /IT to run
this script in the console user's session. The result JSON deliberately
contains no WNS channel URI, address, wallet data, or secret.
#>
[CmdletBinding()]
param(
  [string]$OutputRoot = 'C:\tex8-build\monero-wns-msix-test',
  [string]$BuildRoot = 'C:\tex8-build\wns-production'
)

$ErrorActionPreference = 'Stop'
$packageScript = Join-Path $PSScriptRoot 'package-windows-wns-test.ps1'
$resultPath = Join-Path $OutputRoot 'wns-interactive-result.json'
$packageName = 'TEX8LLP.Monero'
$manifest = Join-Path $OutputRoot 'stage\AppxManifest.xml'
$packageFamilyName = 'TEX8LLP.Monero_k24x978nvjqdg'

New-Item -ItemType Directory -Path $OutputRoot -Force | Out-Null
Remove-Item -LiteralPath $resultPath -Force -ErrorAction SilentlyContinue

# The debug-only startup switch asks the packaged application to acquire a
# channel and persist only its normal opaque installation record. Setting the
# user environment makes it visible to a process launched through AppsFolder.
$env:MONERO_DESKTOP_TEST_WNS_ON_START = '1'
[Environment]::SetEnvironmentVariable('MONERO_DESKTOP_TEST_WNS_ON_START', '1', 'User')

try {
  if (-not (Test-Path -LiteralPath $manifest)) {
    & $packageScript -BuildRoot $BuildRoot -OutputRoot $OutputRoot -PrepareOnly
  }
  if (-not (Test-Path -LiteralPath $manifest)) {
    throw "The prepared WNS MSIX staging manifest is missing: $manifest"
  }

  # Do not mistake an unpackaged dev-shell record for an MSIX result. Preserve
  # any prior record next to it, then require this package launch to create a
  # fresh one.
  $existingInstallations = Get-ChildItem -Path $env:APPDATA -Filter 'desktop-installation.json' -File -Recurse -ErrorAction SilentlyContinue
  foreach ($candidate in $existingInstallations) {
    try {
      $parsed = Get-Content -LiteralPath $candidate.FullName -Raw | ConvertFrom-Json
      if ($parsed.platform -eq 'windows' -and $parsed.provider -eq 'wns') {
        Copy-Item -LiteralPath $candidate.FullName -Destination "$($candidate.FullName).before-wns-msix-test" -Force
        Remove-Item -LiteralPath $candidate.FullName -Force
      }
    } catch { }
  }

  # A development registration is intentionally used here instead of the
  # self-signed MSIX file: it supplies the exact package identity without
  # requiring a trusted-root installation UI. This must run as the interactive
  # user (not Local System) and is never a production installation path.
  Add-AppxPackage -Register $manifest -ForceApplicationShutdown -ErrorAction Stop
  # AppsFolder is a shell namespace rather than a normal executable path.
  # Delegate activation to Explorer so the package runs with its identity.
  Start-Process explorer.exe -ArgumentList "shell:AppsFolder\$packageFamilyName!App"
  Start-Sleep -Seconds 10

  $package = Get-AppxPackage -Name $packageName -ErrorAction Stop
  $installations = Get-ChildItem -Path $env:APPDATA -Filter 'desktop-installation.json' -File -Recurse -ErrorAction SilentlyContinue
  $installation = $null
  foreach ($candidate in $installations) {
    try {
      $parsed = Get-Content -LiteralPath $candidate.FullName -Raw | ConvertFrom-Json
      if ($parsed.platform -eq 'windows' -and $parsed.provider -eq 'wns') {
        $installation = $parsed
        break
      }
    } catch { }
  }
  $packageExecutable = Join-Path (Split-Path -Parent $manifest) 'monero-wallet-desktop.exe'
  $packageProcessSeen = @(
    Get-Process -Name 'monero-wallet-desktop' -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -eq $packageExecutable }
  ).Count -gt 0

  [pscustomobject]@{
    outcome = if ($installation -and $installation.providerStatus -eq 'ready' -and -not [string]::IsNullOrWhiteSpace($installation.endpoint)) { 'ready' } else { 'channel-not-ready' }
    packageName = $package.Name
    packageFamilyName = $package.PackageFamilyName
    packageFullName = $package.PackageFullName
    packageStatus = [string]$package.Status
    providerStatus = if ($installation) { $installation.providerStatus } else { 'installation-record-not-found' }
    delivery = if ($installation -and -not [string]::IsNullOrWhiteSpace($installation.endpoint)) { 'wns' } else { 'not-configured' }
    endpointPresent = [bool]($installation -and -not [string]::IsNullOrWhiteSpace($installation.endpoint))
    packageProcessSeen = $packageProcessSeen
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
  } | ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding utf8
} catch {
  [pscustomobject]@{
    outcome = 'failed'
    error = $_.Exception.Message
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
  } | ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding utf8
  throw
} finally {
  Remove-Item Env:MONERO_DESKTOP_TEST_WNS_ON_START -ErrorAction SilentlyContinue
  [Environment]::SetEnvironmentVariable('MONERO_DESKTOP_TEST_WNS_ON_START', $null, 'User')
}
