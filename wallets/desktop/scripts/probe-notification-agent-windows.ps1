# Read-only by default. -CrashRestartProbe terminates only the verified current
# user's helper task process, then waits for Task Scheduler recovery. No push.
param([Parameter(Mandatory=$true)][string]$ConfigPath, [switch]$CrashRestartProbe)
$ErrorActionPreference = 'Stop'
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$taskName = 'TEX8.MoneroFastWallet.Notifications.' + $currentSid
$source = 'com.tex8.monerowallet.desktop.notification-agent.v1'
function Read-Health {
    $path = Join-Path (Split-Path -Parent $ConfigPath) 'agent-health.json'
    if (!(Test-Path -LiteralPath $path)) { return $null }
    if ((Get-Item -LiteralPath $path).Length -gt 4096) { throw 'Agent health exceeds its limit.' }
    return Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
}
function Now-Seconds { return [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() }
function Verified-Process($health, $executable) {
    if (!$health -or $health.version -ne 1 -or !(($health.instanceId -as [string]) -match '^[0-9a-f]{32}$')) { return $false }
    $age = (Now-Seconds) - [long]$health.heartbeatAt
    if ($age -lt 0 -or $age -gt 10) { return $false }
    $process = Get-Process -Id ([int]$health.pid) -ErrorAction SilentlyContinue
    if (!$process -or !$process.Path) { return $false }
    return [string]::Equals([IO.Path]::GetFullPath($process.Path), [IO.Path]::GetFullPath($executable), [StringComparison]::OrdinalIgnoreCase)
}
try {
    $ConfigPath = [IO.Path]::GetFullPath($ConfigPath)
    $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    [xml]$xml = Export-ScheduledTask -TaskName $taskName -TaskPath '\'
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ($xml.Task.RegistrationInfo.Source -ne $source -or $xml.Task.Principals.Principal.UserId -ne $sid -or $xml.Task.Principals.Principal.LogonType -ne 'InteractiveToken' -or $xml.Task.Principals.Principal.RunLevel -ne 'LeastPrivilege') { throw 'Task identity does not match this application and current user.' }
    $executable = [string]$xml.Task.Actions.Exec.Command
    $task = Get-ScheduledTask -TaskName $taskName -TaskPath '\'
    $info = Get-ScheduledTaskInfo -TaskName $taskName -TaskPath '\'
    $initial = Read-Health
    $verified = Verified-Process $initial $executable
    $recovered = $null
    if ($CrashRestartProbe) {
        if (!$config.enabled -or !$verified) { throw 'Crash probe requires an enabled task with a fresh verified helper process.' }
        # Exact PID/path/task ownership was checked. Never kill by image name.
        if (!(Verified-Process $initial $executable)) { throw 'Helper process changed before the crash probe.' }
        Stop-Process -Id ([int]$initial.pid) -Force
        $until = [DateTime]::UtcNow.AddSeconds(95)
        do {
            Start-Sleep -Milliseconds 500
            $next = Read-Health
            if ((Verified-Process $next $executable) -and $next.instanceId -ne $initial.instanceId) { $recovered = $true; break }
        } while ([DateTime]::UtcNow -lt $until)
        if (!$recovered) { throw 'Task Scheduler did not recover the helper within 95 seconds.' }
    }
    $protocol = Get-ItemProperty -LiteralPath 'HKCU:\Software\Classes\tex8-mfw-notification' -ErrorAction SilentlyContinue
    $protocolOwned = $protocol -and $protocol.MfwOwner -eq ($source + ':' + $sid)
    $protocolCommand = Get-ItemProperty -LiteralPath 'HKCU:\Software\Classes\tex8-mfw-notification\shell\open\command' -ErrorAction SilentlyContinue
    $protocolTargetsHelper = $protocolCommand -and $protocolCommand.'(default)'.Contains($executable) -and $protocolCommand.'(default)'.Contains('--open-notification "%1"')
    $health = Read-Health
    $fresh = Verified-Process $health $executable
    $peerAge = if ($health -and $null -ne $health.lastPeerAt) { (Now-Seconds) - [long]$health.lastPeerAt } else { 999999 }
    $legacy = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'Monero Fast Wallet Notifications' -ErrorAction SilentlyContinue
    [pscustomobject]@{
        taskOwned = $true; taskState = [string]$task.State; lastTaskResult = $info.LastTaskResult
        restartInterval = [string]$xml.Task.Settings.RestartOnFailure.Interval
        watchdogInterval = [string]$xml.Task.Triggers.TimeTrigger.Repetition.Interval
        leastPrivilege = $true; logonAutostart = ($null -ne $xml.Task.Triggers.LogonTrigger)
        legacyRunPresent = ($null -ne $legacy); helperFreshAndPathVerified = $fresh
        protocolHandlerOwned = [bool]$protocolOwned; protocolTargetsCurrentHelper = [bool]$protocolTargetsHelper
        connected = ($fresh -and $health.connected -eq $true -and $peerAge -ge 0 -and $peerAge -le 60)
        phase = if ($health) { $health.phase } else { 'unknown' }
        osPhase = if ($health) { $health.osPhase } else { $null }
        crashRecoveryVerified = $recovered
        bannerPresentationVerified = $false
    } | ConvertTo-Json -Depth 4
    if (!$fresh) { exit 2 }
} catch { Write-Error ('Notification agent probe: ' + $_.Exception.Message); exit 1 }
