#Requires -Version 5.1
<#
.SYNOPSIS
    Makes oXeio's code-signing certificate trusted on this PC (ADR-014).

.DESCRIPTION
    ┌──────────────────────────────────────────────────────────────────┐
    │ Run this once on every staff PC, as administrator.               │
    │ Run it with `-WhatIf` first - then nothing is changed.           │
    └──────────────────────────────────────────────────────────────────┘

    Careful: **the certificate has to go in two places, not one** - and this is
    the script's only tricky decision:

      Trusted Root          "this certificate is genuine"  - otherwise the chain is broken
      Trusted Publishers    "its signature is fine"        - otherwise a dialog appears

    A purchased certificate does not need the first, because its issuer
    (DigiCert etc.) is already installed in Windows. Careful: but a self-signed
    certificate **is its own issuer** - if it is not placed in Root, Windows will
    say "signature is invalid" or "certificate not trusted", and the dialog will
    keep appearing even though it is in Trusted Publishers. Much time is wasted
    putting it only in Publishers and hunting for "why it did not work".

    Careful: **LocalMachine, not CurrentUser** - the agent is installed for all
    users, and the MSI runs under the admin's account. Installed in CurrentUser,
    it would work only in the account of whoever installed it.

    Careful: this script does **not install** the agent and does not run the
    MSI. It only installs the certificate, and shows first what it is installing.

.PARAMETER CerPath
    The certificate file. If omitted, `certs\oxeio-code.cer` next to this script.

.PARAMETER Remove
    The reverse - removes the certificate from both stores (on the day the agent is removed).

.EXAMPLE
    # Look first - nothing changes, and no admin is needed either
    powershell -ExecutionPolicy Bypass -File deploy\trust-publisher.ps1 -WhatIf

.EXAMPLE
    # Really install (as administrator)
    powershell -ExecutionPolicy Bypass -File deploy\trust-publisher.ps1

.EXAMPLE
    # On the day the agent is removed
    powershell -ExecutionPolicy Bypass -File deploy\trust-publisher.ps1 -Remove
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [string]$CerPath,
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $CerPath) { $CerPath = Join-Path $here 'certs\oxeio-code.cer' }

if (-not (Test-Path $CerPath)) {
    throw @"
Certificate file not found: $CerPath

⚠️ It is created by running make-code-cert.ps1 on the build machine (deploy\certs\).
   Copy that .cer file to this machine - it can travel with the MSI.
   ⚠️ Do NOT copy the .pfx: it holds the private key, and it is not needed here.
"@
}

$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 $CerPath

# Careful: both stores are needed - the doc above says why
$stores = @(
    @{ Name = 'Root';             Label = 'Trusted Root  ("the certificate is genuine")' },
    @{ Name = 'TrustedPublisher'; Label = 'Trusted Publishers ("its signature is fine")' }
)

# ── 1. What we are about to do - always printed, with -WhatIf too ───────

Write-Host ''
Write-Host '── Certificate ──────────────────────────────' -ForegroundColor Cyan
Write-Host "   Subject    : $($cert.Subject)"
Write-Host "   Thumbprint : $($cert.Thumbprint)"
Write-Host "   Expires    : $($cert.NotAfter.ToString('yyyy-MM-dd'))"
Write-Host "   File       : $CerPath"
Write-Host ''

if ($cert.NotAfter -lt (Get-Date)) {
    Write-Host '   ⚠️⚠️ This certificate has expired. It can be installed, but new signatures' -ForegroundColor Yellow
    Write-Host '        made with it will not be accepted - make a new one on the build machine.' -ForegroundColor Yellow
    Write-Host ''
}

$verb = if ($Remove) { 'to be removed' } else { 'to be installed' }
Write-Host "── What is $verb ────────────────────" -ForegroundColor Cyan
foreach ($s in $stores) {
    $present = @(Get-ChildItem "Cert:\LocalMachine\$($s.Name)" -ErrorAction SilentlyContinue |
        Where-Object { $_.Thumbprint -eq $cert.Thumbprint }).Count -gt 0

    $state = if ($present) { 'present' } else { 'absent' }
    Write-Host ("   {0,-42} — now {1}" -f $s.Label, $state)
}
Write-Host ''

# Careful: -WhatIf does not ask for admin, deliberately (same reasoning as in
#    defender-exclusions.ps1): after saying "look first", if looking needed admin, nobody would look.
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin -and -not $WhatIfPreference) {
    throw @"
Administrator rights are needed - this writes to the LocalMachine certificate stores.

Open PowerShell with "Run as administrator" and run it again.
(To look first, run it with -WhatIf - that needs no admin.)
"@
}

# ── 2. Do it ────────────────────────────────────────────────────────────

Write-Host '── Working ──────────────────────────────────' -ForegroundColor Cyan

foreach ($s in $stores) {
    $storePath = "Cert:\LocalMachine\$($s.Name)"
    $found = @(Get-ChildItem $storePath -ErrorAction SilentlyContinue |
        Where-Object { $_.Thumbprint -eq $cert.Thumbprint })

    if ($Remove) {
        if (-not $found) {
            Write-Host "   $($s.Name)  — was not there, nothing to do"
            continue
        }
        if ($PSCmdlet.ShouldProcess($s.Name, 'Remove certificate')) {
            $found | Remove-Item -Force
            Write-Host "   $($s.Name)  — removed" -ForegroundColor Green
        }
        continue
    }

    # Safe to run repeatedly - if it is already there, nothing is done. Running
    #    it twice on the same PC during a rollout is very common.
    if ($found) {
        Write-Host "   $($s.Name)  — already present"
        continue
    }

    if ($PSCmdlet.ShouldProcess($s.Name, 'Install certificate')) {
        # Careful: Import-Certificate is not used - it belongs to the PKI module,
        #    and some Windows versions lack that module. X509Store is part of .NET
        #    itself, so it works on every machine.
        $store = New-Object System.Security.Cryptography.X509Certificates.X509Store(
            $s.Name, 'LocalMachine')
        try {
            $store.Open('ReadWrite')
            $store.Add($cert)
            Write-Host "   $($s.Name)  — installed" -ForegroundColor Green
        }
        finally { $store.Close() }
    }
}

if ($WhatIfPreference) {
    Write-Host ''
    Write-Host '   (-WhatIf — nothing was changed)' -ForegroundColor Yellow
    Write-Host ''
    return
}

# ── 3. Verification ─────────────────────────────────────────────────────

Write-Host ''
Write-Host '── Verification ─────────────────────────────' -ForegroundColor Cyan

$ok = $true
foreach ($s in $stores) {
    $present = @(Get-ChildItem "Cert:\LocalMachine\$($s.Name)" -ErrorAction SilentlyContinue |
        Where-Object { $_.Thumbprint -eq $cert.Thumbprint }).Count -gt 0

    $want = -not $Remove
    if ($present -ne $want) { $ok = $false }

    $mark = if ($present -eq $want) { '✅' } else { '❌' }
    Write-Host "   $mark $($s.Name)"
}

Write-Host ''
if (-not $ok) {
    throw 'The certificate stores are not in the expected state - see the list above.'
}

if ($Remove) {
    Write-Host '✅ Removed' -ForegroundColor Green
}
else {
    Write-Host '✅ This PC now recognises the oXeio signature' -ForegroundColor Green
    Write-Host ''
    Write-Host '   Double-clicking the MSI no longer shows "Unknown publisher".'
    Write-Host "   Publisher shown: $($cert.Subject -replace '^CN=', '')"
}
Write-Host ''
