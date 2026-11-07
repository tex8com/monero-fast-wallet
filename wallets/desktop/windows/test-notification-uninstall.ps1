# Executes the real cleanup ownership predicates without accessing Task
# Scheduler, registry, credentials, wallet data or running processes.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'uninstall-notification-agent.ps1')
$script:checks = 0
function Assert-Result([bool]$Actual, [bool]$Expected, [string]$Label) {
    if ($Actual -ne $Expected) { throw ('Uninstall contract failed: ' + $Label) }
    $script:checks++
}
$sid = 'S-1-5-21-123-456-789-1001'
$userName = 'M' + [char]0xFC + 'ller & Test'
$directory = 'C:\Users\' + $userName + '\AppData\Roaming\com.tex8.monerowallet.desktop\notifications'
$config = Join-Path $directory 'background-agent.json'
$helper = Join-Path $directory ('runtime\' + ('a' * 24) + '\monero-fast-walletd.exe')
$install = 'C:\Users\' + $userName + '\AppData\Local\Monero Fast Wallet'
$escape = { param([string]$Value) [Security.SecurityElement]::Escape($Value) }
$task = @"
<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
 <RegistrationInfo><Source>com.tex8.monerowallet.desktop.notification-agent.v1</Source></RegistrationInfo>
 <Principals><Principal id="User"><UserId>$sid</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
 <Actions Context="User"><Exec><Command>$(& $escape $helper)</Command><Arguments>$(& $escape ('--config "' + $config + '"'))</Arguments></Exec></Actions>
</Task>
"@
Assert-Result (Test-MfwOwnedTask $task $sid $config) $true 'current-user Unicode task'
Assert-Result (Test-MfwOwnedTask ($task.Replace('<RunLevel>LeastPrivilege</RunLevel>', '')) $sid $config) $true 'scheduler default least privilege'
Assert-Result (Test-MfwOwnedTask ($task.Replace('LeastPrivilege', 'HighestAvailable')) $sid $config) $false 'elevated task preserved'
Assert-Result (Test-MfwOwnedTask ($task.Replace('InteractiveToken', 'Password')) $sid $config) $false 'password task preserved'
Assert-Result (Test-MfwOwnedTask $task ($sid + '2') $config) $false 'other principal preserved'
Assert-Result (Test-MfwOwnedTask ($task.Replace('notification-agent.v1', 'notification-agent.foreign')) $sid $config) $false 'foreign source preserved'
Assert-Result (Test-MfwOwnedTask ($task.Replace('</Actions>', '<ComHandler><ClassId>foreign</ClassId></ComHandler></Actions>')) $sid $config) $false 'additional action preserved'
Assert-Result (Test-MfwOwnedTask ($task.Replace('</Arguments>', ' --extra</Arguments>')) $sid $config) $false 'additional switches preserved'
Assert-Result (Test-MfwOwnedTask ($task.Replace('</Principals>', '<Principal><UserId>other</UserId></Principal></Principals>')) $sid $config) $false 'additional principal preserved'
Assert-Result (Test-MfwOwnedTask $task ($sid + '<') $config) $false 'invalid SID rejected'
Assert-Result (Test-MfwOwnedTask ('<!DOCTYPE Task [<!ENTITY ext SYSTEM "file:///C:/private">]>' + $task) $sid $config) $false 'external entities rejected'
Assert-Result (Test-MfwOwnedTask ('x' * 65537) $sid $config) $false 'bounded task XML'
Assert-Result (Test-MfwRuntimePath $helper $config) $true 'owned runtime'
Assert-Result (Test-MfwRuntimePath $helper.Replace(('a' * 24), ('a' * 23)) $config) $false 'invalid runtime fingerprint'
Assert-Result (Test-MfwRuntimePath (Join-Path $directory 'runtime\..\foreign\monero-fast-walletd.exe') $config) $false 'path traversal rejected'
Assert-Result (Test-MfwRuntimePath (Join-Path $directory 'runtime-other\aaaaaaaaaaaaaaaaaaaaaaaa\monero-fast-walletd.exe') $config) $false 'prefix collision rejected'
Assert-Result (Test-MfwConfigArguments ('--config "' + $config.Replace('\', '/') + '"') $config) $true 'mixed separators'
Assert-Result (Test-MfwConfigArguments ('--config "' + $config + '" --open-notification test') $config) $false 'activation process excluded'
$command = '"' + $helper + '" --config "' + $config + '"'
Assert-Result (Test-MfwOwnedCommand $command $config $install) $true 'owned legacy startup'
Assert-Result (Test-MfwOwnedCommand ($command + ' --extra') $config $install) $false 'foreign startup arguments preserved'
Assert-Result (Test-MfwOwnedCommand ($command.Replace($helper, 'C:\foreign\monero-fast-walletd.exe')) $config $install) $false 'foreign executable preserved'
Assert-Result (Test-MfwOwnedCommand ($command + ' --open-notification "%1"') $config $install -Protocol) $true 'owned notification protocol'
Assert-Result (Test-MfwOwnedCommand ($command + ' --open-notification "%2"') $config $install -Protocol) $false 'foreign protocol arguments preserved'
Assert-Result (Test-MfwOwnedCommand $command ($config + '.other') $install) $false 'other config preserved'
$noSpacesConfig = 'C:\fixture\notifications\background-agent.json'
$noSpacesHelper = 'C:\fixture\notifications\runtime\aaaaaaaaaaaaaaaaaaaaaaaa\monero-fast-walletd.exe'
Assert-Result (Test-MfwOwnedCommand ($noSpacesHelper + ' --config "' + $noSpacesConfig + '"') $noSpacesConfig $install -ProcessCommand) $true 'scheduler unquoted executable'
$missingTask = [Runtime.InteropServices.COMException]::new('fixture', [int]([long]0x80070002L - 0x100000000L))
$wrappedMissing = [InvalidOperationException]::new('fixture wrapper', $missingTask)
Assert-Result (Test-MfwExceptionHResult $wrappedMissing 0x80070002L) $true 'wrapped missing task is idempotent'
Assert-Result (Test-MfwExceptionHResult ([UnauthorizedAccessException]::new()) 0x80070002L) $false 'access failure is never treated as missing'
$fixture = [IO.Path]::GetTempFileName()
try {
    $appCommand = Join-Path $install 'monero-wallet-desktop.exe'
    $json = @{ version = 5; appCommand = $appCommand } | ConvertTo-Json
    [IO.File]::WriteAllText($fixture, $json, [Text.UTF8Encoding]::new($false))
    $loaded = Read-MfwAgentConfig $fixture
    Assert-Result ($loaded.appCommand -ceq $appCommand) $true 'BOM-less UTF-8 config retains Unicode app path in PS5'
} finally { [IO.File]::Delete($fixture) }
Write-Output ('Notification uninstall ownership tests passed: ' + $script:checks)
