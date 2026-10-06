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
সার্ট ফাইলটা পাওয়া যায়নি: $CerPath

⚠️ এটা সার্ভার-PC-তে make-code-cert.ps1 চালিয়ে তৈরি হয় (deploy\certs\)।
   ওই .cer ফাইলটা এই মেশিনে কপি করে আনুন — MSI-র সাথেই আনতে পারেন।
   ⚠️ .pfx আনবেন না, ওতে প্রাইভেট কী আছে আর এখানে ওটার দরকার নেই।
"@
}

$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 $CerPath

# Careful: both stores are needed - the doc above says why
$stores = @(
    @{ Name = 'Root';             Label = 'Trusted Root  ("সার্টটা আসল")' },
    @{ Name = 'TrustedPublisher'; Label = 'Trusted Publishers ("সই মানে ঠিক আছে")' }
)

# ── 1. What we are about to do - always printed, with -WhatIf too ───────

Write-Host ''
Write-Host '── সার্টিফিকেট ──────────────────────────────' -ForegroundColor Cyan
Write-Host "   Subject    : $($cert.Subject)"
Write-Host "   Thumbprint : $($cert.Thumbprint)"
Write-Host "   মেয়াদ শেষ  : $($cert.NotAfter.ToString('yyyy-MM-dd'))"
Write-Host "   ফাইল       : $CerPath"
Write-Host ''

if ($cert.NotAfter -lt (Get-Date)) {
    Write-Host '   ⚠️⚠️ এই সার্টের মেয়াদ শেষ। বসানো যাবে, কিন্তু নতুন সই আর' -ForegroundColor Yellow
    Write-Host '        গ্রহণযোগ্য হবে না — সার্ভার-PC-তে নতুন সার্ট বানান।' -ForegroundColor Yellow
    Write-Host ''
}

$verb = if ($Remove) { 'তুলে নেওয়া হবে' } else { 'বসানো হবে' }
Write-Host "── যা $verb ────────────────────" -ForegroundColor Cyan
foreach ($s in $stores) {
    $present = @(Get-ChildItem "Cert:\LocalMachine\$($s.Name)" -ErrorAction SilentlyContinue |
        Where-Object { $_.Thumbprint -eq $cert.Thumbprint }).Count -gt 0

    $state = if ($present) { 'আছে' } else { 'নেই' }
    Write-Host ("   {0,-42} — এখন {1}" -f $s.Label, $state)
}
Write-Host ''

# Careful: -WhatIf does not ask for admin, deliberately (same reasoning as in
#    defender-exclusions.ps1): after saying "look first", if looking needed admin, nobody would look.
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin -and -not $WhatIfPreference) {
    throw @"
অ্যাডমিন অধিকার লাগবে — LocalMachine-এর সার্ট স্টোরে লিখতে হয়।

PowerShell-টা "Run as administrator" দিয়ে খুলে আবার চালান।
(আগে দেখে নিতে চাইলে -WhatIf দিয়ে চালান, তাতে অ্যাডমিন লাগে না।)
"@
}

# ── 2. Do it ────────────────────────────────────────────────────────────

Write-Host '── কাজ চলছে ─────────────────────────────────' -ForegroundColor Cyan

foreach ($s in $stores) {
    $storePath = "Cert:\LocalMachine\$($s.Name)"
    $found = @(Get-ChildItem $storePath -ErrorAction SilentlyContinue |
        Where-Object { $_.Thumbprint -eq $cert.Thumbprint })

    if ($Remove) {
        if (-not $found) {
            Write-Host "   $($s.Name)  — ছিলই না, কিছু করার নেই"
            continue
        }
        if ($PSCmdlet.ShouldProcess($s.Name, 'সার্ট তুলে নেওয়া')) {
            $found | Remove-Item -Force
            Write-Host "   $($s.Name)  — তুলে নেওয়া হয়েছে" -ForegroundColor Green
        }
        continue
    }

    # Safe to run repeatedly - if it is already there, nothing is done. Running
    #    it twice on the same PC during a rollout is very common.
    if ($found) {
        Write-Host "   $($s.Name)  — আগে থেকেই আছে"
        continue
    }

    if ($PSCmdlet.ShouldProcess($s.Name, 'সার্ট বসানো')) {
        # Careful: Import-Certificate is not used - it belongs to the PKI module,
        #    and some Windows versions lack that module. X509Store is part of .NET
        #    itself, so it works on every machine.
        $store = New-Object System.Security.Cryptography.X509Certificates.X509Store(
            $s.Name, 'LocalMachine')
        try {
            $store.Open('ReadWrite')
            $store.Add($cert)
            Write-Host "   $($s.Name)  — বসানো হয়েছে" -ForegroundColor Green
        }
        finally { $store.Close() }
    }
}

if ($WhatIfPreference) {
    Write-Host ''
    Write-Host '   (-WhatIf — কিছুই বদলানো হয়নি)' -ForegroundColor Yellow
    Write-Host ''
    return
}

# ── 3. Verification ─────────────────────────────────────────────────────

Write-Host ''
Write-Host '── যাচাই ────────────────────────────────────' -ForegroundColor Cyan

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
    throw 'সার্ট স্টোরের অবস্থা প্রত্যাশিত নয় — উপরের তালিকা দেখুন।'
}

if ($Remove) {
    Write-Host '✅ তুলে নেওয়া হয়েছে' -ForegroundColor Green
}
else {
    Write-Host '✅ এই PC এখন oXeio-র সই চেনে' -ForegroundColor Green
    Write-Host ''
    Write-Host '   MSI-তে ডাবল-ক্লিক করলে "Unknown publisher" আর আসবে না।'
    Write-Host "   Publisher দেখাবে: $($cert.Subject -replace '^CN=', '')"
}
Write-Host ''
