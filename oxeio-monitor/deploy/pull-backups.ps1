<#
    Backup **pull to an office PC** (or any Windows machine you keep).

    Why this second path: `offsite-backup.sh` (rclone) is best, but it needs a
    cloud account and its credentials. This script needs **nothing new** - the
    SSH key you already use to log in to the server is enough. So the "only one
    copy, on one machine" risk is removed today, without waiting for the cloud
    to be sorted out.

    Careful: **this complements rclone, it does not replace it.** If the office
    PC and the server are in the same city, fire, flood or theft could take both.
    It can be kept running even after a cloud remote is set up - having copies in
    two places is never bad.

    The files are **already encrypted** (AES-256-CBC). So even if the laptop is
    lost, nobody's hours/salaries/screenshots can be read.
    Careful: but it also means **if the passphrase is lost, the backup is lost
    too** - keeping `BACKUP_PASSPHRASE` separately, off the server, is your job,
    outside this script.

    Run:
        powershell -ExecutionPolicy Bypass -File deploy\pull-backups.ps1 -ServerHost monitor.example.com

    To run it by itself every day, register a scheduled task, for example:
        task name : "oXeio backup pull"
        time      : every day in the evening
        log       : %USERPROFILE%\oXeio-backups\pull-log.txt

    Careful: set the task up with `-Command` + try/catch, not with `-File`.
       The reason: this script has `$ErrorActionPreference = 'Stop'`, so when
       ssh fails the error becomes **terminating** and jumps out past the `*>>`
       redirect - the log would then say only "started", not why it stopped.
       Measured by running it with a wrong IP.

    To verify the behaviour is right:
        Get-ScheduledTaskInfo 'oXeio backup pull' |
            Select LastRunTime, LastTaskResult   # 0 = success

    Careful: tick "run as soon as possible after a scheduled start is missed"
       (`StartWhenAvailable`), so a run is not lost when the PC was off.
#>

[CmdletBinding()]
param(
    # Your server's name or IP. Required: there is no sensible default.
    # Careful: if the script goes to a wrong address it **makes no noise** in a
    #    scheduled task - the daily copy simply stops arriving. Update the task
    #    when the server changes.
    [Parameter(Mandatory = $true)]
    [string]$ServerHost,
    # 2222 if sshd also listens there (deploy/README.md, "SSH times out")
    [int]$Port = 22,
    [string]$User = 'root',
    [string]$KeyPath = "$HOME\.ssh\oxeio",
    [string]$RemoteDir = '/opt/oxeio/oxeio-monitor/.data/backups',

    # By default in the user's own folder - not Documents, because that is often
    #    synced to OneDrive, and a backup going to the cloud on its own should be
    #    a conscious decision, not an accident.
    [string]$LocalDir = "$HOME\oXeio-backups",

    # How many weeks of local copies to keep (0 = prune nothing)
    [int]$KeepWeeks = 8
)

$ErrorActionPreference = 'Stop'

function Say  { param($m) Write-Host "   [ok] $m" -ForegroundColor Green }
function Warn { param($m) Write-Host "   [!] $m" -ForegroundColor Yellow }
function Die  { param($m) Write-Host "`n[x] $m`n" -ForegroundColor Red; exit 1 }

Write-Host "`n-- oXeio backup pull --" -ForegroundColor Cyan

# ── 1. What it cannot run without ───────────────────────────────────────────
if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
    Die 'ssh not found (enable the OpenSSH Client feature in Windows)'
}
if (-not (Test-Path $KeyPath)) { Die "SSH key not found: $KeyPath" }

if (-not (Test-Path $LocalDir)) {
    New-Item -ItemType Directory -Path $LocalDir | Out-Null
    Say "folder created: $LocalDir"
}

$ssh = @('-i', $KeyPath, '-p', "$Port", '-o', 'ConnectTimeout=20',
         '-o', 'BatchMode=yes', "$User@$ServerHost")

# ── 2. What is on the server ────────────────────────────────────────────────
#
# Careful: `find -printf`, not `ls` - `ls` output would break if a name contained
#    spaces. The names are safe here, but keep the habit right.
$remoteList = & ssh @ssh "find '$RemoteDir' -maxdepth 1 -type f -printf '%f\n' | sort" 2>&1
if ($LASTEXITCODE -ne 0) { Die "could not reach the server — $remoteList" }

$remote = @($remoteList | Where-Object { $_ -match '\.(dump\.enc|sha256|txt)$' })
if ($remote.Count -eq 0) { Die "not a single backup file on the server ($RemoteDir)" }

$dumps = @($remote | Where-Object { $_ -like '*.dump.enc' })
Say "$($dumps.Count) dump(s) on the server, $($remote.Count) file(s) in all"

# ── 3. Only what is not here yet ────────────────────────────────────────────
#
# Safe to run repeatedly - what is already here is not downloaded again, so
#    running it several times a day costs almost nothing.
$missing = @($remote | Where-Object { -not (Test-Path (Join-Path $LocalDir $_)) })

if ($missing.Count -eq 0) {
    Say 'nothing new — every copy is already here'
} else {
    Write-Host "   downloading: $($missing.Count) file(s)" -ForegroundColor DarkGray
    foreach ($f in $missing) {
        # Careful: the remote path for scp is quoted - otherwise a path with spaces would break
        & scp -i $KeyPath -P $Port -o ConnectTimeout=20 -o BatchMode=yes `
              "${User}@${ServerHost}:${RemoteDir}/${f}" (Join-Path $LocalDir $f) | Out-Null
        if ($LASTEXITCODE -ne 0) { Die "download failed: $f" }
    }
    Say "$($missing.Count) new file(s) downloaded"
}

# ── 4. Verification - a backup that has not been tested is not a backup, it is a guess
#
# Careful: this step is the real reason for this script. A file having been
#    downloaded does not mean it is **intact** - a half-downloaded dump sits on
#    the disk just fine, and is discovered only on the very day it is needed.
#    Next to every dump is a `.sha256` from the server - it is compared here.
$verified = 0; $bad = @()
foreach ($d in $dumps) {
    $local = Join-Path $LocalDir $d
    $sumFile = Join-Path $LocalDir "$d.sha256"
    if (-not (Test-Path $local) -or -not (Test-Path $sumFile)) { continue }

    # Format: "<hash>  <filename>"
    $expected = ((Get-Content $sumFile -First 1) -split '\s+')[0]
    $actual = (Get-FileHash $local -Algorithm SHA256).Hash.ToLower()

    if ($expected -eq $actual) { $verified++ }
    else {
        $bad += $d
        # A corrupt copy is **deleted** - otherwise the next run would see it
        #    "present" and not download it again, and the broken file would stay forever.
        Remove-Item $local -Force
    }
}

if ($bad.Count -gt 0) {
    Warn "$($bad.Count) file(s) failed the hash check — deleted, the next run downloads them again:"
    $bad | ForEach-Object { Write-Host "       $_" -ForegroundColor Yellow }
}
Say "$verified dump(s) passed the hash check"

# ── 5. Prune old local copies ───────────────────────────────────────────────
#
# Careful: pruning happens only **here**, not on the server - and never by the
#    rule "delete here too because it is gone from the server". If the server's
#    disk were wiped, that rule would delete the last copy at that very moment
#    (the same reasoning as the copy-vs-sync decision in `offsite-backup.sh`).
if ($KeepWeeks -gt 0) {
    $cutoff = (Get-Date).AddDays(-7 * $KeepWeeks)
    $old = @(Get-ChildItem $LocalDir -File |
             Where-Object { $_.LastWriteTime -lt $cutoff -and $_.Name -like '*.dump.enc*' })
    if ($old.Count -gt 0) {
        $old | Remove-Item -Force
        Say "$($old.Count) old file(s) pruned (older than $KeepWeeks weeks)"
    }
}

# ── 6. Result ───────────────────────────────────────────────────────────────
$localDumps = @(Get-ChildItem $LocalDir -Filter '*.dump.enc' -File)
$size = [math]::Round((($localDumps | Measure-Object Length -Sum).Sum / 1MB), 1)
$newest = $localDumps | Sort-Object Name | Select-Object -Last 1

Write-Host ''
Write-Host "[ok] $($localDumps.Count) dump(s) here - $size MB" -ForegroundColor Green
if ($newest) { Write-Host "     newest: $($newest.Name)" -ForegroundColor Green }
Write-Host "     folder: $LocalDir" -ForegroundColor DarkGray
Write-Host ''

# Careful: a hash mismatch gives a non-zero exit code - so the failure is
#    noticed in the scheduled task, otherwise everyone would feel safe seeing "runs daily".
if ($bad.Count -gt 0) { exit 2 }
