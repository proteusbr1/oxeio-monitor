#Requires -Version 5.1
<#
.SYNOPSIS
    Adds Microsoft Defender exclusions for the oXeio agent.

.DESCRIPTION
    The agent writes small files all day - a .webp screenshot every 5 minutes,
    and constant INSERTs into the SQLite outbox. Defender's real-time scanning
    steps in on every write, which costs CPU and occasionally locks a file so
    that the agent's write fails.

    ┌──────────────────────────────────────────────────────────────────────┐
    │ Warning: this is a security decision, not mere performance tuning.   │
    │                                                                      │
    │ Excluding something from the antivirus means that spot is no longer  │
    │ guarded. Do not run it blindly. The script first prints what it will │
    │ do, and asks for confirmation at every step.                         │
    │                                                                      │
    │ Run it with `-WhatIf` first - then nothing is changed.               │
    └──────────────────────────────────────────────────────────────────────┘

    By default **process-based** exclusions are added, not folder-based (apart from
       the install folder). The reason is written under `-IncludeDataFolder` below -
       this is the most important decision in this script.

    What is added by default:
      - process  oXeio.Agent.exe
      - process  oXeio.Watchdog.exe
      - folder   C:\Program Files\oXeio   (only an admin can write there)

.PARAMETER IncludeDataFolder
    Also adds %ProgramData%\oXeio to the exclusion list.

    **Off** by default, deliberately. Ordinary users have "Modify" rights on that
    folder (the agent has to run under the staff member's account, so it had to
    be granted - see `AgentDataDirectory.cs`). If the folder is excluded from
    Defender, any user in the office can drop an .exe there and Defender will
    never look at it. So the exclusion effectively creates a "place to hide a virus".

    It is also usually not needed: the two process exclusions above already keep
    the **files the agent writes itself** out of scanning. So run without it
    first; add it only if you really see slowness.

.PARAMETER Remove
    Removes the exclusions (after an uninstall, or if they were added by mistake).

.PARAMETER Force
    Stops asking yes/no at every step - for running from a rollout script. What
    is being added is still printed.

    `-WhatIf` still wins: with `-Force -WhatIf` nothing changes.

.EXAMPLE
    # 1. Look first - nothing will change
    powershell -ExecutionPolicy Bypass -File deploy\defender-exclusions.ps1 -WhatIf

.EXAMPLE
    # 2. Really apply it (as admin) - asks for confirmation at every step
    powershell -ExecutionPolicy Bypass -File deploy\defender-exclusions.ps1

.EXAMPLE
    # 3. From a rollout script, without questions - knowingly
    #
    # `-Confirm:$false` **will not work** here. `powershell -File` treats every
    #    argument after it as a plain string, so `$false` becomes the literal
    #    "$false" and PowerShell says "Cannot convert 'System.String' to
    #    ... SwitchParameter". That is why a separate `-Force` switch exists.
    powershell -ExecutionPolicy Bypass -File deploy\defender-exclusions.ps1 -Force

.EXAMPLE
    # 4. Remove
    powershell -ExecutionPolicy Bypass -File deploy\defender-exclusions.ps1 -Remove
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [string]$InstallDir,
    [string]$DataDir,
    [switch]$IncludeDataFolder,
    [switch]$Remove,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

# Careful: with `ConfirmImpact = 'High'` it asks for confirmation at every step
#    by default - deliberate, so nobody runs it without understanding. That
#    would hang a rollout script, hence `-Force`.
#
#    `$WhatIfPreference` is not touched here, so even with `-Force -WhatIf`
#       -WhatIf wins - "look first" never turns into "just do it".
if ($Force) { $ConfirmPreference = 'None' }

# ══════════════════════════════════════════════════════════════════════════
#  1. Which folder, which process
# ══════════════════════════════════════════════════════════════════════════

# Careful: the registry is **forced** open in the 64-bit view, exactly as
#    `AgentSettings.cs` does. Run from 32-bit PowerShell, Windows would
#    silently redirect to WOW6432Node, where the MSI wrote nothing - the script
#    would fall back to the default path and the exclusion for an agent
#    installed on another drive would land in the wrong place.
function Get-AgentInstallDir {
    try {
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine', 'Registry64')
        try {
            $key = $base.OpenSubKey('SOFTWARE\oXeio\Agent')
            if ($key) {
                try {
                    $value = $key.GetValue('InstallDir')
                    if ($value) { return ([string]$value) }
                }
                finally { $key.Dispose() }
            }
        }
        finally { $base.Dispose() }
    }
    catch { Write-Verbose "Could not read the registry: $($_.Exception.Message)" }
    return $null
}

if (-not $InstallDir) {
    $InstallDir = Get-AgentInstallDir
    if (-not $InstallDir) {
        $InstallDir = Join-Path $env:ProgramFiles 'oXeio'
        $installSource = 'default (not found in the registry - is the agent installed?)'
    }
    else { $installSource = 'HKLM\SOFTWARE\oXeio\Agent\InstallDir' }
}
else { $installSource = 'given with -InstallDir' }

if (-not $DataDir) { $DataDir = Join-Path $env:ProgramData 'oXeio' }

# Careful: the trailing '\' is trimmed. The MSI writes `InstallDir` via
#    `[INSTALLFOLDER]`, and Windows Installer folder properties **always end
#    with '\'**. Defender stores that path as a separate string, so the same
#    folder would appear twice in the list (once with '\', once without) and
#    -Remove would never clear everything.
$InstallDir = $InstallDir.TrimEnd('\')
$DataDir = $DataDir.TrimEnd('\')

$pathExclusions = @($InstallDir)
if ($IncludeDataFolder) { $pathExclusions += $DataDir }

$processExclusions = @('oXeio.Agent.exe', 'oXeio.Watchdog.exe')

# ══════════════════════════════════════════════════════════════════════════
#  2. What we are about to do - always printed, with -WhatIf too
# ══════════════════════════════════════════════════════════════════════════

$action = if ($Remove) { 'remove' } else { 'add' }

Write-Host ''
Write-Host '════════════════════════════════════════════════════════════' -ForegroundColor Cyan
Write-Host ' oXeio — Microsoft Defender exclusions' -ForegroundColor Cyan
Write-Host '════════════════════════════════════════════════════════════' -ForegroundColor Cyan
Write-Host ''
Write-Host " Action        : $action"
Write-Host " Install folder: $InstallDir"
Write-Host "                ($installSource)"
Write-Host ''
Write-Host ' Folders:' -ForegroundColor Yellow
foreach ($p in $pathExclusions) { Write-Host "   · $p" }
Write-Host ' Processes:' -ForegroundColor Yellow
foreach ($p in $processExclusions) { Write-Host "   · $p" }
Write-Host ''

if (-not $Remove) {
    Write-Host ' ⚠️  These will no longer be scanned by Defender.' -ForegroundColor Red
    if ($IncludeDataFolder) {
        Write-Host ''
        Write-Host " ⚠️⚠️ -IncludeDataFolder was given." -ForegroundColor Red
        Write-Host "      Ordinary users can write to $DataDir," -ForegroundColor Red
        Write-Host '      so any file anyone puts there would no longer be scanned either.' -ForegroundColor Red
        Write-Host '      Leave this switch out unless you really need it.' -ForegroundColor Red
    }
    else {
        Write-Host "      ($DataDir is left out - good. See -IncludeDataFolder.)" -ForegroundColor DarkGray
    }
    Write-Host ''
}

# ══════════════════════════════════════════════════════════════════════════
#  3. Is Defender even there?
# ══════════════════════════════════════════════════════════════════════════

function Write-NoDefenderHelp {
    param([string]$Detail)

    Write-Host ''
    Write-Host '── Nothing to do with Defender on this machine ──' -ForegroundColor Yellow
    Write-Host ' Microsoft Defender is not running or has been disabled.'
    Write-Host ' This almost always means another antivirus is installed.'
    Write-Host ''
    Write-Host ' What to do: open that antivirus console and add the folders and'
    Write-Host '             processes above to its exclusion list.'
    if ($Detail) { Write-Host ''; Write-Host " Detail: $Detail" -ForegroundColor DarkGray }
    Write-Host ''
}

# Careful: it is not enough to check whether the cmdlet **exists**.
#
#    Defender's module ships with Windows, so `Get-Command
#    Add-MpPreference` succeeds on nearly every machine - even where the Defender
#    service itself is off. That is exactly what happens when a third-party AV is
#    installed, and then the real call blows up with `0x800106ba`. With
#    `$ErrorActionPreference='Stop'` the script would die showing that cryptic
#    HRESULT - on exactly those PCs that have another AV.
#
#    So the real call is attempted, and when it fails the script says clearly
#    what to do.
if (-not (Get-Command -Name Add-MpPreference -ErrorAction SilentlyContinue)) {
    Write-NoDefenderHelp -Detail 'The Defender PowerShell module is not present.'
    return
}

$current = $null
try { $current = Get-MpPreference }
catch {
    Write-NoDefenderHelp -Detail $_.Exception.Message
    return
}

# Careful: with a third-party AV, Defender can also run in "passive mode" - the
#    exclusion can still be added, but someone else is doing the real scanning,
#    so the script would say "success" while the slowness problem stayed.
try {
    $status = Get-MpComputerStatus
    if ($status -and -not $status.RealTimeProtectionEnabled) {
        Write-Warning 'Defender real-time protection is off (probably another AV is running).'
        Write-Warning 'Exclusions can be added, but they do not help if another product is the real scanner.'
        Write-Host ''
    }
}
catch { Write-Verbose "Get-MpComputerStatus not available: $($_.Exception.Message)" }

# ══════════════════════════════════════════════════════════════════════════
#  4. Admin is required - but only when something is really being changed
# ══════════════════════════════════════════════════════════════════════════

# Careful: -WhatIf does not ask for admin, deliberately. After saying "look
#    first", if that did not work without elevation, nobody would look.
$isAdmin = ([Security.Principal.WindowsPrincipal] `
        [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin -and -not $WhatIfPreference) {
    throw 'Must be run as administrator. (Right-click PowerShell → "Run as administrator")'
}

# ══════════════════════════════════════════════════════════════════════════
#  5. Add / remove
# ══════════════════════════════════════════════════════════════════════════

$currentPaths = @($current.ExclusionPath)
$currentProcesses = @($current.ExclusionProcess)

# Careful: Add-MpPreference / Remove-MpPreference do not handle -WhatIf properly
#    themselves (CDXML-generated commands). So the decision is taken here with
#    `ShouldProcess`, and without a "yes" the command is never called - so both
#    -WhatIf and -Confirm are guaranteed to work.
function Set-Exclusion {
    param(
        [ValidateSet('Path', 'Process')][string]$Kind,
        [string]$Value,
        [string[]]$Existing
    )

    $already = $Existing -contains $Value
    $label = if ($Kind -eq 'Path') { 'folder' } else { 'process' }

    if ($Remove) {
        if (-not $already) {
            Write-Host "   — $label $Value  (not in the list, nothing to do)" -ForegroundColor DarkGray
            return
        }
        if ($PSCmdlet.ShouldProcess($Value, "Remove $label from Defender exclusions")) {
            if ($Kind -eq 'Path') { Remove-MpPreference -ExclusionPath $Value }
            else { Remove-MpPreference -ExclusionProcess $Value }
            Write-Host "   ✔ removed: $label $Value" -ForegroundColor Green
        }
    }
    else {
        if ($already) {
            Write-Host "   — $label $Value  (already present)" -ForegroundColor DarkGray
            return
        }
        if ($PSCmdlet.ShouldProcess($Value, "Add $label to Defender exclusions")) {
            if ($Kind -eq 'Path') { Add-MpPreference -ExclusionPath $Value }
            else { Add-MpPreference -ExclusionProcess $Value }
            Write-Host "   ✔ added: $label $Value" -ForegroundColor Green
        }
    }
}

Write-Host '── Working ──────────────────────────────────' -ForegroundColor Cyan

foreach ($p in $pathExclusions) {
    Set-Exclusion -Kind 'Path' -Value $p -Existing $currentPaths
}
foreach ($p in $processExclusions) {
    Set-Exclusion -Kind 'Process' -Value $p -Existing $currentProcesses
}

# ══════════════════════════════════════════════════════════════════════════
#  6. What is in the list now
# ══════════════════════════════════════════════════════════════════════════

if ($WhatIfPreference) {
    Write-Host ''
    Write-Host '-WhatIf was given - nothing was changed.' -ForegroundColor Yellow
    Write-Host 'To apply it, run without -WhatIf, as administrator.' -ForegroundColor Yellow
    Write-Host ''
    return
}

$after = Get-MpPreference
Write-Host ''
Write-Host '── Defender exclusion list now ──────────────' -ForegroundColor Cyan
Write-Host ' Folders:'
if (@($after.ExclusionPath).Count -eq 0) { Write-Host '   (empty)' -ForegroundColor DarkGray }
else { foreach ($p in $after.ExclusionPath) { Write-Host "   · $p" } }
Write-Host ' Processes:'
if (@($after.ExclusionProcess).Count -eq 0) { Write-Host '   (empty)' -ForegroundColor DarkGray }
else { foreach ($p in $after.ExclusionProcess) { Write-Host "   · $p" } }
Write-Host ''
Write-Host '⚠️ Anything above that is not oXeio was added by someone else -' -ForegroundColor Yellow
Write-Host '   this script did not touch it.' -ForegroundColor Yellow
Write-Host ''
