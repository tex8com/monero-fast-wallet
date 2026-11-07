# Current-user NSIS cleanup. No wallet, credential or notification configuration
# is deleted or rewritten. Reinstallation can therefore resume existing opt-in.
[CmdletBinding()]
param([string]$InstallDirectory)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:MfwTaskSource = 'com.tex8.monerowallet.desktop.notification-agent.v1'

function Test-MfwSamePath([string]$Left, [string]$Right) {
    try {
        return [string]::Equals([IO.Path]::GetFullPath($Left.Replace('/', '\')), [IO.Path]::GetFullPath($Right.Replace('/', '\')), [StringComparison]::OrdinalIgnoreCase)
    } catch { return $false }
}
function Test-MfwRuntimePath([string]$Executable, [string]$ConfigPath) {
    try {
        $root = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $ConfigPath) 'runtime')) + '\'
        $path = [IO.Path]::GetFullPath($Executable.Replace('/', '\'))
        if (!$path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { return $false }
        return $path.Substring($root.Length) -cmatch '^[0-9a-fA-F]{24}\\monero-fast-walletd\.exe$'
    } catch { return $false }
}
function Test-MfwConfigArguments([string]$Arguments, [string]$ConfigPath) {
    return [string]::Equals($Arguments.Replace('/', '\'), ('--config "' + $ConfigPath.Replace('/', '\') + '"'), [StringComparison]::OrdinalIgnoreCase)
}
function Test-MfwExecutablePath([string]$Executable, [string]$ConfigPath, [string]$InstallDirectory, [switch]$Protocol) {
    return (Test-MfwRuntimePath $Executable $ConfigPath) -or (!$Protocol -and (Test-MfwSamePath $Executable (Join-Path $InstallDirectory 'target\release\monero-fast-walletd.exe')))
}
function Test-MfwOwnedTask([string]$Document, [string]$Sid, [string]$ConfigPath) {
    if ($Sid -notmatch '^S-1-(\d+-)*\d+$' -or $Document.Length -gt 65536) { return $false }
    try {
        $settings = [Xml.XmlReaderSettings]::new()
        $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
        $settings.XmlResolver = $null
        $reader = [Xml.XmlReader]::Create([IO.StringReader]::new($Document), $settings)
        $xml = [Xml.XmlDocument]::new()
        $xml.XmlResolver = $null
        try { $xml.Load($reader) } finally { $reader.Dispose() }
        $ns = [Xml.XmlNamespaceManager]::new($xml.NameTable)
        $ns.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
        $source = $xml.SelectNodes('/t:Task/t:RegistrationInfo/t:Source', $ns)
        $principals = $xml.SelectNodes('/t:Task/t:Principals/t:Principal', $ns)
        $actions = $xml.SelectNodes('/t:Task/t:Actions/*', $ns)
        if ($source.Count -ne 1 -or $source[0].InnerText -cne $script:MfwTaskSource -or $principals.Count -ne 1 -or $actions.Count -ne 1 -or $actions[0].LocalName -cne 'Exec') { return $false }
        $principal = $principals[0]
        $user = $principal.SelectNodes('t:UserId', $ns)
        $logon = $principal.SelectNodes('t:LogonType', $ns)
        $level = $principal.SelectNodes('t:RunLevel', $ns)
        $command = $actions[0].SelectNodes('t:Command', $ns)
        $arguments = $actions[0].SelectNodes('t:Arguments', $ns)
        return $user.Count -eq 1 -and $user[0].InnerText -ceq $Sid -and $logon.Count -eq 1 -and $logon[0].InnerText -ceq 'InteractiveToken' -and ($level.Count -eq 0 -or ($level.Count -eq 1 -and $level[0].InnerText -ceq 'LeastPrivilege')) -and $command.Count -eq 1 -and $arguments.Count -eq 1 -and (Test-MfwRuntimePath $command[0].InnerText $ConfigPath) -and (Test-MfwConfigArguments $arguments[0].InnerText $ConfigPath)
    } catch { return $false }
}
function Test-MfwOwnedCommand([string]$Command, [string]$ConfigPath, [string]$InstallDirectory, [switch]$Protocol, [switch]$ProcessCommand) {
    $executable = if ($ProcessCommand) { '(?:"(?<exe>[^"\r\n]+)"|(?<exe>[^"\s]+))' } else { '"(?<exe>[^"\r\n]+)"' }
    $pattern = '^' + $executable + ' --config "(?<config>[^"\r\n]+)"'
    if ($Protocol) { $pattern += ' --open-notification "%1"' }
    $match = [regex]::Match($Command, ($pattern + '$'), [Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if (!$match.Success -or !(Test-MfwSamePath $match.Groups['config'].Value $ConfigPath)) { return $false }
    return Test-MfwExecutablePath $match.Groups['exe'].Value $ConfigPath $InstallDirectory -Protocol:$Protocol
}
function Assert-MfwNoReparsePoint([string]$Path) {
    $current = [IO.Path]::GetFullPath($Path)
    while (![string]::IsNullOrEmpty($current)) {
        $item = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
        if ($null -ne $item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'unsafe-path' }
        $current = [IO.Path]::GetDirectoryName($current)
    }
}
function Test-MfwExceptionHResult([Exception]$Exception, [long]$Code) {
    # COM method failures can be wrapped by PowerShell's invocation exception.
    for ($depth = 0; $null -ne $Exception -and $depth -lt 8; $depth++) {
        if (($Exception.HResult -band 0xffffffffL) -eq $Code) { return $true }
        $Exception = $Exception.InnerException
    }
    return $false
}
function Read-MfwAgentConfig([string]$Path) {
    if ((Get-Item -LiteralPath $Path).Length -gt 16384) { throw 'invalid-config' }
    # Rust writes UTF-8 without a BOM. Windows PowerShell 5's Get-Content
    # default is the system code page and corrupts Unicode installation paths.
    return [IO.File]::ReadAllText($Path, [Text.UTF8Encoding]::new($false, $true)) | ConvertFrom-Json
}
function Get-MfwRegisteredTask($Folder, [string]$TaskName) {
    try { return $Folder.GetTask($TaskName) } catch {
        if (Test-MfwExceptionHResult $_.Exception 0x80070002L) { return $null }
        throw 'task-query-failed'
    }
}
function Remove-MfwRegistryEntries([string]$Sid, [string]$ConfigPath, [string]$InstallDirectory) {
    $classes = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Classes', $true)
    if ($null -ne $classes) {
        try {
            $protocol = $classes.OpenSubKey('tex8-mfw-notification')
            if ($null -ne $protocol) {
                try {
                    $owner = $protocol.GetValue('MfwOwner', $null)
                    $commandKey = $protocol.OpenSubKey('shell\open\command')
                    $command = if ($null -ne $commandKey) { try { $commandKey.GetValue('', '') } finally { $commandKey.Dispose() } } else { '' }
                    $owned = $owner -ceq ($script:MfwTaskSource + ':' + $Sid) -and (Test-MfwOwnedCommand ([string]$command) $ConfigPath $InstallDirectory -Protocol)
                } finally { $protocol.Dispose() }
                if ($owned) { $classes.DeleteSubKeyTree('tex8-mfw-notification', $false) }
            }
        } finally { $classes.Dispose() }
    }
    $run = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Run', $true)
    if ($null -ne $run) {
        try {
            $command = $run.GetValue('Monero Fast Wallet Notifications', $null)
            if ($null -ne $command -and (Test-MfwOwnedCommand ([string]$command) $ConfigPath $InstallDirectory)) { $run.DeleteValue('Monero Fast Wallet Notifications', $false) }
        } finally { $run.Dispose() }
    }
}
function Stop-MfwOwnedProcesses([string]$Sid, [string]$ConfigPath, [string]$InstallDirectory) {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        $owned = @()
        foreach ($item in @(Get-CimInstance Win32_Process -Filter "Name='monero-fast-walletd.exe'" -OperationTimeoutSec 5)) {
            if (!$item.ExecutablePath -or !$item.CommandLine -or !(Test-MfwExecutablePath $item.ExecutablePath $ConfigPath $InstallDirectory) -or !(Test-MfwOwnedCommand $item.CommandLine $ConfigPath $InstallDirectory -ProcessCommand)) { continue }
            $owner = Invoke-CimMethod -InputObject $item -MethodName GetOwnerSid -OperationTimeoutSec 5
            if ($owner.ReturnValue -ne 0) { throw 'process-owner-unavailable' }
            if ($owner.Sid -cne $Sid) { continue }
            try { $process = [Diagnostics.Process]::GetProcessById([int]$item.ProcessId) } catch [ArgumentException] { continue }
            try {
                # Keep this process handle, not an image-name kill or a later
                # recycled PID. Refuse inconsistent executable/creation data.
                if ($process.HasExited) { continue }
                if (!(Test-MfwSamePath $process.MainModule.FileName $item.ExecutablePath) -or [Math]::Abs(($process.StartTime.ToUniversalTime() - $item.CreationDate.ToUniversalTime()).TotalSeconds) -gt 1) { throw 'process-changed' }
                $owned += [int]$item.ProcessId
                $process.Kill()
                [void]$process.WaitForExit(1000)
            } finally { $process.Dispose() }
        }
        if ($owned.Count -eq 0) { return }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'process-stop-timeout'
}
function Invoke-MfwNotificationUninstall([string]$InstallDirectory) {
    $script:MfwCleanupPhase = 'identity'
    if (![IO.Path]::IsPathRooted($InstallDirectory)) { throw 'invalid-install-directory' }
    $InstallDirectory = [IO.Path]::GetFullPath($InstallDirectory)
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ($sid -notmatch '^S-1-(\d+-)*\d+$') { throw 'invalid-user' }
    $directory = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'com.tex8.monerowallet.desktop\notifications'
    $configPath = Join-Path $directory 'background-agent.json'
    Assert-MfwNoReparsePoint $directory
    if (Test-Path -LiteralPath $configPath) {
        Assert-MfwNoReparsePoint $configPath
        $config = Read-MfwAgentConfig $configPath
        if ($config.version -ne 5 -or $config.platform -cne 'windows' -or $config.provider -cne 'windows-agent' -or !(Test-MfwSamePath $config.appCommand (Join-Path $InstallDirectory 'monero-wallet-desktop.exe'))) { throw 'another-installation-config' }
    }
    $script:MfwCleanupPhase = 'task'
    $scheduler = New-Object -ComObject 'Schedule.Service'
    $scheduler.Connect()
    $folder = $scheduler.GetFolder('\')
    $taskName = 'TEX8.MoneroFastWallet.Notifications.' + $sid
    $task = Get-MfwRegisteredTask $folder $taskName
    if ($null -ne $task) {
        if (!(Test-MfwOwnedTask $task.Xml $sid $configPath) -or $task.Definition.Principal.RunLevel -ne 0 -or $task.Definition.Principal.LogonType -ne 3) { throw 'task-ownership-conflict' }
        Assert-MfwNoReparsePoint ([string]$task.Definition.Actions.Item(1).Path)
        # Disable the one-minute watchdog before stopping its exact task.
        $task.Enabled = $false
        try { $task.Stop(0) } catch {
            if (!(Test-MfwExceptionHResult $_.Exception 0x8004130BL)) { throw 'task-stop-failed' }
        }
        $again = Get-MfwRegisteredTask $folder $taskName
        if ($null -eq $again -or !(Test-MfwOwnedTask $again.Xml $sid $configPath)) { throw 'task-changed' }
        $folder.DeleteTask($taskName, 0)
    }
    $script:MfwCleanupPhase = 'registry'
    Remove-MfwRegistryEntries $sid $configPath $InstallDirectory
    $script:MfwCleanupPhase = 'process'
    Stop-MfwOwnedProcesses $sid $configPath $InstallDirectory
    $script:MfwCleanupPhase = 'runtime'
    $runtime = Join-Path $directory 'runtime'
    if (Test-Path -LiteralPath $runtime) {
        Assert-MfwNoReparsePoint $runtime
        foreach ($child in @(Get-ChildItem -LiteralPath $runtime -Directory)) {
            if ($child.Name -cnotmatch '^[0-9a-fA-F]{24}$') { continue }
            Assert-MfwNoReparsePoint $child.FullName
            $helper = Join-Path $child.FullName 'monero-fast-walletd.exe'
            if (!(Test-Path -LiteralPath $helper)) { continue }
            Assert-MfwNoReparsePoint $helper
            $digest = (Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash
            if (!$digest.StartsWith($child.Name, [StringComparison]::OrdinalIgnoreCase)) { throw 'runtime-fingerprint-conflict' }
            Remove-Item -LiteralPath $helper -Force
            if (@(Get-ChildItem -LiteralPath $child.FullName -Force).Count -eq 0) { Remove-Item -LiteralPath $child.FullName }
        }
    }
}

# Dot-sourcing exposes only pure ownership helpers for the fixture tests.
if ($MyInvocation.InvocationName -ne '.') {
    try {
        Invoke-MfwNotificationUninstall $InstallDirectory
        Write-Output 'notification-cleanup-complete'
        exit 0
    } catch {
        # Keep paths, installation identifiers and raw OS exceptions private.
        Write-Output ('notification-cleanup-failed:' + $script:MfwCleanupPhase)
        exit 2
    }
}
