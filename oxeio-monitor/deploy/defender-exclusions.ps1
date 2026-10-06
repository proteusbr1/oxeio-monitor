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
    catch { Write-Verbose "রেজিস্ট্রি পড়া গেল না: $($_.Exception.Message)" }
    return $null
}

if (-not $InstallDir) {
    $InstallDir = Get-AgentInstallDir
    if (-not $InstallDir) {
        $InstallDir = Join-Path $env:ProgramFiles 'oXeio'
        $installSource = 'ডিফল্ট (রেজিস্ট্রিতে পাওয়া যায়নি — এজেন্ট কি বসানো হয়েছে?)'
    }
    else { $installSource = 'HKLM\SOFTWARE\oXeio\Agent\InstallDir' }
}
else { $installSource = '-InstallDir দিয়ে দেওয়া' }

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

$action = if ($Remove) { 'তুলে নেওয়া হবে' } else { 'যোগ করা হবে' }

Write-Host ''
Write-Host '════════════════════════════════════════════════════════════' -ForegroundColor Cyan
Write-Host ' oXeio — Microsoft Defender ছাড় (H09)' -ForegroundColor Cyan
Write-Host '════════════════════════════════════════════════════════════' -ForegroundColor Cyan
Write-Host ''
Write-Host " কাজ          : $action"
Write-Host " ইনস্টল ফোল্ডার: $InstallDir"
Write-Host "                ($installSource)"
Write-Host ''
Write-Host ' ফোল্ডার:' -ForegroundColor Yellow
foreach ($p in $pathExclusions) { Write-Host "   · $p" }
Write-Host ' প্রসেস:' -ForegroundColor Yellow
foreach ($p in $processExclusions) { Write-Host "   · $p" }
Write-Host ''

if (-not $Remove) {
    Write-Host ' ⚠️  এগুলো Defender-এর পাহারার বাইরে চলে যাবে।' -ForegroundColor Red
    if ($IncludeDataFolder) {
        Write-Host ''
        Write-Host " ⚠️⚠️ -IncludeDataFolder দেওয়া হয়েছে।" -ForegroundColor Red
        Write-Host "      $DataDir-এ সাধারণ ইউজারের লেখার অধিকার আছে," -ForegroundColor Red
        Write-Host '      অর্থাৎ যে কেউ ওখানে ফাইল রাখলে সেটাও আর স্ক্যান হবে না।' -ForegroundColor Red
        Write-Host '      সত্যিই দরকার না হলে এই সুইচটা বাদ দিন।' -ForegroundColor Red
    }
    else {
        Write-Host "      ($DataDir বাদ রাখা হয়েছে — ভালো। -IncludeDataFolder দেখুন।)" -ForegroundColor DarkGray
    }
    Write-Host ''
}

# ══════════════════════════════════════════════════════════════════════════
#  3. Is Defender even there?
# ══════════════════════════════════════════════════════════════════════════

function Write-NoDefenderHelp {
    param([string]$Detail)

    Write-Host ''
    Write-Host '── এই মেশিনে Defender দিয়ে কিছু করার নেই ────' -ForegroundColor Yellow
    Write-Host ' Microsoft Defender চলছে না বা নিষ্ক্রিয় করা আছে।'
    Write-Host ' প্রায় সবসময় এর মানে অন্য একটা অ্যান্টিভাইরাস বসানো আছে।'
    Write-Host ''
    Write-Host ' করণীয়: সেই AV-র নিজের কনসোল খুলে উপরের ফোল্ডার ও'
    Write-Host '        প্রসেসগুলো তার ছাড়ের (exclusion) তালিকায় দিন।'
    if ($Detail) { Write-Host ''; Write-Host " বিস্তারিত: $Detail" -ForegroundColor DarkGray }
    Write-Host ''
}

# Careful: it is not enough to check whether the cmdlet **exists**.
#
#    Defender's module ships with Windows, so `Get-Command
#    Add-MpPreference` succeeds on nearly every machine - even where the Defender
#    service itself is off. That is exactly what happens when a third-party AV is
#    installed, and then the real call blows up with `0x800106ba`. With
#    `$ErrorActionPreference='Stop'` the script would die showing that cryptic
#    HRESULT - on exactly those of the office's 15 PCs that have another AV.
#
#    So the real call is attempted, and when it fails the script says clearly
#    (in Bengali) what to do.
if (-not (Get-Command -Name Add-MpPreference -ErrorAction SilentlyContinue)) {
    Write-NoDefenderHelp -Detail 'Defender-এর PowerShell মডিউলই নেই।'
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
        Write-Warning 'Defender-এর real-time protection বন্ধ (সম্ভবত অন্য AV চলছে)।'
        Write-Warning 'ছাড় বসানো যাবে, কিন্তু আসল স্ক্যানার অন্য কেউ হলে কাজে আসবে না।'
        Write-Host ''
    }
}
catch { Write-Verbose "Get-MpComputerStatus পাওয়া গেল না: $($_.Exception.Message)" }

# ══════════════════════════════════════════════════════════════════════════
#  4. Admin is required - but only when something is really being changed
# ══════════════════════════════════════════════════════════════════════════

# Careful: -WhatIf does not ask for admin, deliberately. After saying "look
#    first", if that did not work without elevation, nobody would look.
$isAdmin = ([Security.Principal.WindowsPrincipal] `
        [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin -and -not $WhatIfPreference) {
    throw 'অ্যাডমিন হিসেবে চালাতে হবে। (PowerShell-এ ডান-ক্লিক → "Run as administrator")'
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
    $label = if ($Kind -eq 'Path') { 'ফোল্ডার' } else { 'প্রসেস' }

    if ($Remove) {
        if (-not $already) {
            Write-Host "   — $label $Value  (তালিকায় নেই, কিছু করার নেই)" -ForegroundColor DarkGray
            return
        }
        if ($PSCmdlet.ShouldProcess($Value, "Defender ছাড় থেকে $label তুলে নেওয়া")) {
            if ($Kind -eq 'Path') { Remove-MpPreference -ExclusionPath $Value }
            else { Remove-MpPreference -ExclusionProcess $Value }
            Write-Host "   ✔ তোলা হলো: $label $Value" -ForegroundColor Green
        }
    }
    else {
        if ($already) {
            Write-Host "   — $label $Value  (আগে থেকেই আছে)" -ForegroundColor DarkGray
            return
        }
        if ($PSCmdlet.ShouldProcess($Value, "Defender ছাড়ে $label যোগ করা")) {
            if ($Kind -eq 'Path') { Add-MpPreference -ExclusionPath $Value }
            else { Add-MpPreference -ExclusionProcess $Value }
            Write-Host "   ✔ যোগ হলো: $label $Value" -ForegroundColor Green
        }
    }
}

Write-Host '── কাজ চলছে ─────────────────────────────────' -ForegroundColor Cyan

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
    Write-Host '-WhatIf ছিল — কিছুই বদলানো হয়নি।' -ForegroundColor Yellow
    Write-Host 'সত্যিই বসাতে চাইলে -WhatIf ছাড়া, অ্যাডমিন হিসেবে চালান।' -ForegroundColor Yellow
    Write-Host ''
    return
}

$after = Get-MpPreference
Write-Host ''
Write-Host '── এখন Defender-এর ছাড়ের তালিকা ─────────────' -ForegroundColor Cyan
Write-Host ' ফোল্ডার:'
if (@($after.ExclusionPath).Count -eq 0) { Write-Host '   (খালি)' -ForegroundColor DarkGray }
else { foreach ($p in $after.ExclusionPath) { Write-Host "   · $p" } }
Write-Host ' প্রসেস:'
if (@($after.ExclusionProcess).Count -eq 0) { Write-Host '   (খালি)' -ForegroundColor DarkGray }
else { foreach ($p in $after.ExclusionProcess) { Write-Host "   · $p" } }
Write-Host ''
Write-Host '⚠️ উপরে oXeio-র বাইরের কিছু দেখলে থামুন — ওগুলো অন্য কারো বসানো,' -ForegroundColor Yellow
Write-Host '   আর এই স্ক্রিপ্ট সেগুলোতে হাত দেয়নি।' -ForegroundColor Yellow
Write-Host ''
