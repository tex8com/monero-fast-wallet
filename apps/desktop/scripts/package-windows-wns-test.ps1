<#
Create, sign, register, and launch a VM-local MSIX test wrapper. It gives the
desktop process the real Monero Store identity so WNS can create a channel.
The generated certificate is trusted only in the current test user profile;
it is never a release-signing certificate.
#>
[CmdletBinding()]
param(
  [string]$BuildRoot = 'C:\tex8-build\tauri-dev-user',
  [string]$OutputRoot = 'C:\tex8-build\monero-wns-msix-test',
  [switch]$PrepareOnly
)

$ErrorActionPreference = 'Stop'
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if (-not $PrepareOnly -and $currentSid -eq 'S-1-5-18') {
  throw 'MSIX installation and WNS validation must run as the signed-in Windows user, not Local System. Use test-windows-wns-interactive.ps1 from a host/VM automation context.'
}
$desktopDirectory = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent (Split-Path -Parent $desktopDirectory)
$manifest = Join-Path $desktopDirectory 'windows\wns-test\AppxManifest.xml'
$binary = Join-Path $BuildRoot 'debug\monero-wallet-desktop.exe'
$makeAppx = 'C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\arm64\makeappx.exe'
$signTool = 'C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\arm64\signtool.exe'
$publisher = 'CN=DF621DE2-61A1-469F-AABA-73A338CFF2AE'
$packageFamilyName = 'TEX8LLP.Monero_k24x978nvjqdg'

foreach ($path in @($manifest, $binary, $makeAppx, $signTool)) {
  if (-not (Test-Path -LiteralPath $path)) { throw "Required test packaging input is missing: $path" }
}

$stage = Join-Path $OutputRoot 'stage'
$package = Join-Path $OutputRoot 'MoneroFastWallet-WnsTest.msix'
Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path (Join-Path $stage 'Assets') -Force | Out-Null
New-Item -ItemType Directory -Path $OutputRoot -Force | Out-Null
Copy-Item -LiteralPath $manifest -Destination (Join-Path $stage 'AppxManifest.xml') -Force
Copy-Item -LiteralPath $binary -Destination (Join-Path $stage 'monero-wallet-desktop.exe') -Force

foreach ($asset in @(
  @{ Source = '128x128.png'; Destination = 'StoreLogo.png' },
  @{ Source = '128x128.png'; Destination = 'Square150x150Logo.png' },
  @{ Source = '128x128.png'; Destination = 'Square44x44Logo.png' }
)) {
  Copy-Item -LiteralPath (Join-Path $desktopDirectory "src-tauri\icons\$($asset.Source)") -Destination (Join-Path $stage "Assets\$($asset.Destination)") -Force
}

Remove-Item -LiteralPath $package -Force -ErrorAction SilentlyContinue
& $makeAppx pack /d $stage /p $package /o | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'makeappx could not create the WNS test package.' }
if ($PrepareOnly) {
  Write-Host "WNS MSIX staging layout prepared: $stage"
  return
}

# The package identity must match the Store product. A self-signed certificate
# with this subject is valid only for sideload testing after it is trusted on
# this VM; Microsoft Store signing remains the release path.
$certificateFile = Join-Path $OutputRoot 'MoneroFastWallet-WnsTest.cer'
$certificate = Get-ChildItem -Path Cert:\CurrentUser\My | Where-Object { $_.Subject -eq $publisher -and $_.HasPrivateKey } | Select-Object -First 1
if (-not $certificate) {
  $certificate = New-SelfSignedCertificate `
    -Type Custom `
    -Subject $publisher `
    -KeyUsage DigitalSignature `
    -KeyExportPolicy Exportable `
    -CertStoreLocation Cert:\CurrentUser\My `
    -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3')
}
Export-Certificate -Cert $certificate -FilePath $certificateFile -Force | Out-Null
# MSIX validates the package-signing chain against a trusted root. Trusted
# People is insufficient for a self-signed development certificate. This must
# be invoked in the signed-in user's session; Local System cannot manage a
# user package or user certificate root.
& "$env:SystemRoot\System32\certutil.exe" -user -addstore -f Root $certificateFile | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'The WNS test signing certificate could not be trusted for the current Windows user.' }
& $signTool sign /fd SHA256 /sha1 $certificate.Thumbprint /s My $package | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'signtool could not sign the WNS test package.' }

Add-AppxPackage -Path $package -ForceApplicationShutdown
Start-Process "shell:AppsFolder\$packageFamilyName!App"
Write-Host "WNS MSIX test package registered and launched: $package"
