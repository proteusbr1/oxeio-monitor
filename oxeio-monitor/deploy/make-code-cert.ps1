#Requires -Version 5.1
<#
.SYNOPSIS
    Creates a self-signed code-signing certificate for signing oXeio's exe and
    MSI (ADR-014).

.DESCRIPTION
    Why no purchased certificate is needed - three reasons in ADR-014: the MSI
    is not downloaded through a browser so SmartScreen does not fire - nor does
    the auto-update path - and the real answer to the AV is an exclusion, not a
    signature. For a company's own PCs signing it ourselves is enough, at zero cost.

    Three things come out:

      oxeio-code.cer   public certificate   -> distribute to every PC (trust-publisher.ps1)
      oxeio-code.pfx   backup with the key  -> SECRET, and losing it is a disaster
      thumbprint       40-character print   -> build.ps1 -SignWith <this>

    Careful: **if the pfx is lost, nothing can ever be signed with the same
    identity again.** A new certificate means a new identity, i.e. going to
    every PC again to install the new `.cer`. Wherever you keep the file,
    keep a backup.

    Note: this script puts the certificate in **this user's** certificate store
    (`Cert:\CurrentUser\My`), because the private key is needed there for
    signing. No admin rights are needed, and nothing changes on any other
    machine or store.

    Note: this is **not** the TLS certificate. That one is `make-cert.ps1` - the
    two do different jobs, and one cannot stand in for the other (different EKU).

.PARAMETER Subject
    The name written in the certificate - this is what shows as the "Publisher"
    at install time. Default "oXeio".

.PARAMETER Years
    Validity. Default 5 years.

    Note: the TLS certificate's 825-day limit does not apply here - that is a
    browser rule. For code signing a long validity is the advantage, because
    when it expires you have to go to every PC again.

.PARAMETER OutDir
    Where the files are written. Default `certs\` next to this script.

.PARAMETER Force
    Permission to overwrite existing files.

    Careful: a new certificate = a new identity. MSIs signed with the old one
    stay valid, but no PC will recognise the new signatures until
    the new `.cer` is distributed.

.EXAMPLE
    # First time
    powershell -ExecutionPolicy Bypass -File deploy\make-code-cert.ps1

.EXAMPLE
    # Look first - nothing changes
    powershell -ExecutionPolicy Bypass -File deploy\make-code-cert.ps1 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [string]$Subject = 'oXeio',
    [ValidateRange(1, 20)][int]$Years = 5,
    [string]$OutDir,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $OutDir) { $OutDir = Join-Path $here 'certs' }

$cerPath = Join-Path $OutDir 'oxeio-code.cer'
$pfxPath = Join-Path $OutDir 'oxeio-code.pfx'
$infoPath = Join-Path $OutDir 'oxeio-code.txt'

# ── 1. What we are about to do - always printed, with -WhatIf too ───────

Write-Host ''
Write-Host '── Code-signing certificate ─────────────────' -ForegroundColor Cyan
Write-Host "   Name     : CN=$Subject"
Write-Host "   Validity : $Years years"
Write-Host "   Store    : Cert:\CurrentUser\My  (no admin needed)"
Write-Host "   Files    : $cerPath"
Write-Host "              $pfxPath  ⚠️ secret"
Write-Host ''

$existing = @($cerPath, $pfxPath) | Where-Object { Test-Path $_ }
if ($existing -and -not $Force) {
    throw @"
Files from an earlier run exist - nothing was overwritten:
$($existing -join "`n")

⚠️⚠️ A new certificate means a NEW IDENTITY. MSIs signed with the old one stay
   valid, but no PC will recognise the new signatures - every PC needs the new
   .cer installed again (trust-publisher.ps1).

   If you really want a new certificate: -Force
"@
}

# ── 2. Create ───────────────────────────────────────────────────────────

if (-not $PSCmdlet.ShouldProcess("CN=$Subject", 'Create code-signing certificate')) {
    Write-Host '   (-WhatIf — nothing was changed)' -ForegroundColor Yellow
    Write-Host ''
    return
}

# Careful: the password is asked for **before the certificate is created**, not after.
#
#    It used to be the other way round: create the certificate, then prompt. If
#    someone pressed Ctrl+C there (or the prompt failed), an **orphan
#    certificate** was left in the store while no .cer/.pfx was written.
#    Careful: and the guard above looks at the **files**, not the certificate -
#    so running again would quietly create a second certificate, with no way to
#    tell which one was used for signing.
#
#    Now if it stops, nothing is created.
Write-Host '   ⚠️ Choose a password for the .pfx backup (remember it -' -ForegroundColor Yellow
Write-Host '      without it the certificate cannot be restored from the backup):' -ForegroundColor Yellow
$pfxPassword = Read-Host '   Password' -AsSecureString

if ($pfxPassword.Length -eq 0) {
    throw 'Empty password - no certificate was created without a .pfx backup.'
}

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

Write-Host '── Working ──────────────────────────────────' -ForegroundColor Cyan

# Careful: -Type CodeSigningCert is deliberate. It sets EKU 1.3.6.1.5.5.7.3.3,
#    and without it Set-AuthenticodeSignature **will not accept** the
#    certificate - the message is "Cannot sign code. The specified certificate is
#    not suitable", from which the cause is hard to see.
#
# Careful: without -KeyExportPolicy Exportable the .pfx could not be made, so
#    no backup could be taken either - and changing machines would lose the identity.
# Careful: if anything fails from here on, the certificate is removed from the
#    store - leaving nothing is cleaner than leaving a half-done state.
$cert = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject "CN=$Subject" `
    -KeyAlgorithm RSA `
    -KeyLength 3072 `
    -KeyExportPolicy Exportable `
    -KeyUsage DigitalSignature `
    -CertStoreLocation 'Cert:\CurrentUser\My' `
    -NotAfter (Get-Date).AddYears($Years)

Write-Host "   certificate created — thumbprint $($cert.Thumbprint)"

# The public part - this is what goes to every PC, and it has no private key
[IO.File]::WriteAllBytes($cerPath, $cert.Export('Cert'))
Write-Host "   $cerPath"

# Careful: the pfx contains the private key, so it cannot be written without a password.
#    The password has to be typed - deliberately not given on the command line,
#    otherwise it would stay in PowerShell's history file.
Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $pfxPassword -Force | Out-Null
Write-Host "   $pfxPath  ⚠️ secret"

@"
oXeio code-signing certificate
===============================

Subject     : CN=$Subject
Thumbprint  : $($cert.Thumbprint)
Expires     : $($cert.NotAfter.ToString('yyyy-MM-dd'))
Created     : $(Get-Date -Format 'yyyy-MM-dd HH:mm')

To sign:
    powershell -File agent\installer\build.ps1 -ServerUrl https://monitor.example.com -SignWith $($cert.Thumbprint)

To make every PC trust it (once per PC, as administrator):
    powershell -File deploy\trust-publisher.ps1

⚠️ If oxeio-code.pfx is lost, nothing can be signed with the same identity again.
"@ | Set-Content -Path $infoPath -Encoding UTF8

Write-Host "   $infoPath"

# ── 3. Next steps ───────────────────────────────────────────────────────

Write-Host ''
Write-Host '✅ Created' -ForegroundColor Green
Write-Host ''
Write-Host '── thumbprint (build.ps1 -SignWith) ─────────' -ForegroundColor Cyan
Write-Host "   $($cert.Thumbprint)" -ForegroundColor Green
Write-Host ''
Write-Host '── Next steps ───────────────────────────────' -ForegroundColor Cyan
Write-Host "   1· Build the MSI :  build.ps1 -ServerUrl <your server> -SignWith $($cert.Thumbprint)"
Write-Host '   2· On every PC   :  trust-publisher.ps1  (as administrator)'
Write-Host ''
Write-Host '   ⚠️ Skip step 2 and the signature is there, but Windows does not recognise it -' -ForegroundColor Yellow
Write-Host '      the "Unknown publisher" dialog still appears.' -ForegroundColor Yellow
Write-Host ''
