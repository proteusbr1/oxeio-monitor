#Requires -Version 5.1
<#
.SYNOPSIS
    Creates a self-signed code-signing certificate for signing oXeio's exe and
    MSI (ADR-014).

.DESCRIPTION
    Why no purchased certificate is needed - three reasons in ADR-014: the MSI
    is not downloaded through a browser so SmartScreen does not fire - nor does
    the auto-update path - and the real answer to the AV is an exclusion, not a
    signature. For 15 machines signing it ourselves is enough, at zero cost.

    Three things come out:

      oxeio-code.cer   public certificate   -> distribute to the 15 PCs (trust-publisher.ps1)
      oxeio-code.pfx   backup with the key  -> SECRET, and losing it is a disaster
      thumbprint       40-character print   -> build.ps1 -SignWith <this>

    Careful: **if the pfx is lost, nothing can ever be signed with the same
    identity again.** A new certificate means a new identity, i.e. going to each
    of the 15 PCs again to install the new `.cer`. Wherever you keep the file,
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
    when it expires you have to go to the 15 PCs again.

.PARAMETER OutDir
    Where the files are written. Default `certs\` next to this script.

.PARAMETER Force
    Permission to overwrite existing files.

    Careful: a new certificate = a new identity. MSIs signed with the old one
    stay valid, but none of the 15 PCs will recognise the new signatures until
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
Write-Host '── কোড-সাইনিং সার্টিফিকেট ───────────────────' -ForegroundColor Cyan
Write-Host "   নাম    : CN=$Subject"
Write-Host "   মেয়াদ  : $Years বছর"
Write-Host "   স্টোর   : Cert:\CurrentUser\My  (অ্যাডমিন লাগে না)"
Write-Host "   ফাইল   : $cerPath"
Write-Host "            $pfxPath  ⚠️ গোপন"
Write-Host ''

$existing = @($cerPath, $pfxPath) | Where-Object { Test-Path $_ }
if ($existing -and -not $Force) {
    throw @"
আগের ফাইল আছে — ঢাকা হয়নি:
$($existing -join "`n")

⚠️⚠️ নতুন সার্ট মানে **নতুন পরিচয়**। আগের সার্ট দিয়ে সই করা MSI-গুলো
   তখনো বৈধ থাকবে, কিন্তু নতুন সইগুলো ১৫টা PC-র কেউ চিনবে না — প্রতিটাতে
   আবার গিয়ে নতুন .cer বসাতে হবে (trust-publisher.ps1)।

   সত্যিই নতুন সার্ট চাইলে: -Force
"@
}

# ── 2. Create ───────────────────────────────────────────────────────────

if (-not $PSCmdlet.ShouldProcess("CN=$Subject", 'কোড-সাইনিং সার্টিফিকেট বানানো')) {
    Write-Host '   (-WhatIf — কিছুই বদলানো হয়নি)' -ForegroundColor Yellow
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
Write-Host '   ⚠️ .pfx ব্যাকআপের জন্য একটা পাসওয়ার্ড দিন (মনে রাখুন —' -ForegroundColor Yellow
Write-Host '      এটা ছাড়া ব্যাকআপ থেকে সার্ট ফেরানো যাবে না):' -ForegroundColor Yellow
$pfxPassword = Read-Host '   পাসওয়ার্ড' -AsSecureString

if ($pfxPassword.Length -eq 0) {
    throw 'পাসওয়ার্ড খালি — .pfx ব্যাকআপ ছাড়া সার্ট বানানো হয়নি।'
}

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

Write-Host '── কাজ চলছে ─────────────────────────────────' -ForegroundColor Cyan

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

Write-Host "   সার্ট তৈরি — thumbprint $($cert.Thumbprint)"

# The public part - this is what goes to the 15 PCs, and it has no private key
[IO.File]::WriteAllBytes($cerPath, $cert.Export('Cert'))
Write-Host "   $cerPath"

# Careful: the pfx contains the private key, so it cannot be written without a password.
#    The password has to be typed - deliberately not given on the command line,
#    otherwise it would stay in PowerShell's history file.
Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $pfxPassword -Force | Out-Null
Write-Host "   $pfxPath  ⚠️ গোপন"

@"
oXeio কোড-সাইনিং সার্টিফিকেট
============================

Subject     : CN=$Subject
Thumbprint  : $($cert.Thumbprint)
মেয়াদ শেষ   : $($cert.NotAfter.ToString('yyyy-MM-dd'))
তৈরি        : $(Get-Date -Format 'yyyy-MM-dd HH:mm')

সই করতে:
    powershell -File agent\installer\build.ps1 -SignWith $($cert.Thumbprint)

১৫টা PC-তে বিশ্বাস করাতে (প্রতিটাতে একবার, অ্যাডমিন হিসেবে):
    powershell -File deploy\trust-publisher.ps1

⚠️ oxeio-code.pfx হারালে একই পরিচয়ে আর সই করা যাবে না।
"@ | Set-Content -Path $infoPath -Encoding UTF8

Write-Host "   $infoPath"

# ── 3. Next steps ───────────────────────────────────────────────────────

Write-Host ''
Write-Host '✅ তৈরি' -ForegroundColor Green
Write-Host ''
Write-Host '── thumbprint (build.ps1 -SignWith) ─────────' -ForegroundColor Cyan
Write-Host "   $($cert.Thumbprint)" -ForegroundColor Green
Write-Host ''
Write-Host '── পরের ধাপ ─────────────────────────────────' -ForegroundColor Cyan
Write-Host "   ১· MSI বানান  :  build.ps1 -SignWith $($cert.Thumbprint)"
Write-Host '   ২· ১৫টা PC-তে :  trust-publisher.ps1  (অ্যাডমিন হিসেবে)'
Write-Host ''
Write-Host '   ⚠️ ধাপ ২ বাদ দিলে সই থাকবে ঠিকই, কিন্তু Windows সেটা চিনবে না —' -ForegroundColor Yellow
Write-Host '      "Unknown publisher" ডায়ালগটা তখনো আসবে।' -ForegroundColor Yellow
Write-Host ''
