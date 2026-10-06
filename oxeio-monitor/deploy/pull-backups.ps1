<#
    Backup **pull to the office PC**.

    Why this second path: `offsite-backup.sh` (rclone) is best, but it needs a
    cloud account and its credentials. This script needs **nothing new** - the
    SSH key you already use to log in to the server is enough. So the "only one
    copy, on one machine" risk is removed today, without waiting for the cloud
    to be sorted out.

    Careful: **this complements rclone, it does not replace it.** The office PC
    and the server are in the same city; fire, flood or theft could take both.
    It can be kept running even after a cloud remote is set up - having copies in
    two places is never bad.

    The files are **already encrypted** (AES-256-CBC). So even if the laptop is
    lost, nobody's hours/salaries/screenshots can be read.
    Careful: but it also means **if the passphrase is lost, the backup is lost
    too** - keeping `BACKUP_PASSPHRASE` separately, off the server, is your job,
    outside this script.

    Run:
        powershell -ExecutionPolicy Bypass -File deploy\pull-backups.ps1

    To run it by itself every day - **already set up**:
        task name : "oXeio backup pull"
        time      : every day at 9:30 pm
        log       : %USERPROFILE%\oXeio-backups\pull-log.txt

    Careful: the task is set up with `-Command` + try/catch, not with `-File`.
       The reason: this script has `$ErrorActionPreference = 'Stop'`, so when
       ssh fails the error becomes **terminating** and jumps out past the `*>>`
       redirect - the log would then say only "started", not why it stopped.
       Measured by running it with a wrong IP.

    To verify the behaviour is right:
        Get-ScheduledTaskInfo 'oXeio backup pull' |
            Select LastRunTime, LastTaskResult   # 0 = success

    Careful: if the PC is off at 9:30 pm the run is not lost - `StartWhenAvailable`
       is set, so it runs the next time the PC is on.
#>

[CmdletBinding()]
param(
    # Careful: the defaults are for this server - pass parameters if running elsewhere
    #
    # Careful: the server was changed (USA -> BDIX, ADR-034), so this line had
    #    to be edited by hand. Worth remembering: if the script goes to a wrong
    #    address it **makes no noise** - the daily third copy simply stops
    #    arriving. Change this again the next time the server changes.
    [string]$ServerHost = '165.101.189.253',
    [int]$Port = 2222,
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

Write-Host "`n-- R5 - backup pull --" -ForegroundColor Cyan

# ── 1. What it cannot run without ───────────────────────────────────────────
if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
    Die 'ssh পাওয়া গেল না (Windows-এ OpenSSH ক্লায়েন্ট চালু করুন)'
}
if (-not (Test-Path $KeyPath)) { Die "SSH কী নেই: $KeyPath" }

if (-not (Test-Path $LocalDir)) {
    New-Item -ItemType Directory -Path $LocalDir | Out-Null
    Say "ফোল্ডার তৈরি: $LocalDir"
}

$ssh = @('-i', $KeyPath, '-p', "$Port", '-o', 'ConnectTimeout=20',
         '-o', 'BatchMode=yes', "$User@$ServerHost")

# ── 2. What is on the server ────────────────────────────────────────────────
#
# Careful: `find -printf`, not `ls` - `ls` output would break if a name contained
#    spaces. The names are safe here, but keep the habit right.
$remoteList = & ssh @ssh "find '$RemoteDir' -maxdepth 1 -type f -printf '%f\n' | sort" 2>&1
if ($LASTEXITCODE -ne 0) { Die "সার্ভারে পৌঁছানো গেল না — $remoteList" }

$remote = @($remoteList | Where-Object { $_ -match '\.(dump\.enc|sha256|txt)$' })
if ($remote.Count -eq 0) { Die "সার্ভারে একটাও ব্যাকআপ ফাইল নেই ($RemoteDir)" }

$dumps = @($remote | Where-Object { $_ -like '*.dump.enc' })
Say "সার্ভারে $($dumps.Count) টা ডাম্প, মোট $($remote.Count) টা ফাইল"

# ── 3. Only what is not here yet ────────────────────────────────────────────
#
# Safe to run repeatedly - what is already here is not downloaded again, so
#    running it several times a day costs almost nothing.
$missing = @($remote | Where-Object { -not (Test-Path (Join-Path $LocalDir $_)) })

if ($missing.Count -eq 0) {
    Say 'নতুন কিছু নেই — সব কপি ইতিমধ্যেই এখানে'
} else {
    Write-Host "   নামানো হচ্ছে: $($missing.Count) টা ফাইল" -ForegroundColor DarkGray
    foreach ($f in $missing) {
        # Careful: the remote path for scp is quoted - otherwise a path with spaces would break
        & scp -i $KeyPath -P $Port -o ConnectTimeout=20 -o BatchMode=yes `
              "${User}@${ServerHost}:${RemoteDir}/${f}" (Join-Path $LocalDir $f) | Out-Null
        if ($LASTEXITCODE -ne 0) { Die "নামানো ব্যর্থ: $f" }
    }
    Say "$($missing.Count) টা নতুন ফাইল নামানো হয়েছে"
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
    Warn "$($bad.Count) টা ফাইলের হ্যাশ মেলেনি — মুছে ফেলা হয়েছে, পরের রানে আবার নামবে:"
    $bad | ForEach-Object { Write-Host "       $_" -ForegroundColor Yellow }
}
Say "$verified টা ডাম্পের হ্যাশ মিলেছে"

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
        Say "$($old.Count) টা পুরোনো ফাইল ছাঁটা হয়েছে ($KeepWeeks সপ্তাহের বেশি)"
    }
}

# ── 6. Result ───────────────────────────────────────────────────────────────
$localDumps = @(Get-ChildItem $LocalDir -Filter '*.dump.enc' -File)
$size = [math]::Round((($localDumps | Measure-Object Length -Sum).Sum / 1MB), 1)
$newest = $localDumps | Sort-Object Name | Select-Object -Last 1

Write-Host ''
Write-Host "[ok] এখানে $($localDumps.Count) টা ডাম্প - $size MB" -ForegroundColor Green
if ($newest) { Write-Host "     সবশেষ: $($newest.Name)" -ForegroundColor Green }
Write-Host "     ঘর: $LocalDir" -ForegroundColor DarkGray
Write-Host ''

# Careful: a hash mismatch gives a non-zero exit code - so the failure is
#    noticed in the scheduled task, otherwise everyone would feel safe seeing "runs daily".
if ($bad.Count -gt 0) { exit 2 }
