#Requires -Version 5.1
<#
.SYNOPSIS
    Creates a self-signed TLS certificate for the oXeio API.

.DESCRIPTION
    The office LAN has no public domain, so Let's Encrypt cannot be used. This
    script creates a self-signed certificate and its private key - in a form
    Node can read directly (TLS_CERT / TLS_KEY).

    Four files are produced:

      oxeio-cert.pem   certificate (PEM)        -> TLS_CERT
      oxeio-key.pem    private key (PKCS#8)     -> TLS_KEY   SECRET
      oxeio.pfx        both together            -> for importing into Windows,
                                                   and for -ReuseKey   SECRET
      oxeio-pin.txt    SPKI pin + details       -> the value to put on the agent

    Note: this script **installs nothing** - it does not put anything in the
       certificate store, does not restart the server, does not change any
       setting. It only writes files. The remaining steps are in README.md, to
       be done by hand.

.PARAMETER Hostname
    The certificate's main name (CN and first SAN). Defaults to this machine's name.

.PARAMETER IpAddress
    IP addresses to go into the SAN. If omitted, it finds all of the machine's LAN IPv4 addresses itself.

.PARAMETER AlsoDns
    Extra DNS names (aliases, FQDN).

.PARAMETER Days
    Validity. Default 825 days - for the reason see README § 7.

.PARAMETER ReuseKey
    Builds the new certificate from the **same private key** as the previous
    oxeio.pfx.
    Use this for renewals - with the same key the SPKI pin stays the same too,
    so none of the 15 PCs needs touching.

.PARAMETER Force
    Permission to overwrite existing files. Careful: a new key means a new pin.

.EXAMPLE
    # First time - it finds the name and IP itself
    powershell -ExecutionPolicy Bypass -File deploy\make-cert.ps1

.EXAMPLE
    # Stated explicitly (recommended)
    powershell -ExecutionPolicy Bypass -File deploy\make-cert.ps1 `
        -Hostname oxeio.office.local -IpAddress 192.168.0.10

.EXAMPLE
    # Renewal - nothing has to change on the agents
    powershell -ExecutionPolicy Bypass -File deploy\make-cert.ps1 -ReuseKey
#>
[CmdletBinding()]
param(
    [string]$Hostname,
    [string[]]$IpAddress,
    [string[]]$AlsoDns = @(),
    [ValidateRange(1, 3650)][int]$Days = 825,
    [ValidateSet(2048, 3072, 4096)][int]$KeySize = 2048,
    [string]$OutDir,
    [switch]$ReuseKey,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

# ══════════════════════════════════════════════════════════════════════════
#  DER encoder
#
#  Careful: it has to be written by hand, because Windows PowerShell 5.1 runs
#     on .NET Framework, which **lacks** `RSA.ExportPkcs8PrivateKey()` (that is
#     .NET Core 3.0+). This machine does not have pwsh 7, and asking the owner
#     to install PowerShell 7 just to make a certificate would be an extra step
#     before rollout.
#
#  As little as possible is written by hand: the hard part of the **public**
#     key is taken from .NET's own encoder ($cert.PublicKey.EncodedKeyValue),
#     so only the wrapper has to be written here. For the private key there is
#     no way around it - the 9 INTEGERs must be encoded by hand.
# ══════════════════════════════════════════════════════════════════════════
class Der {
    # DER length: one byte if under 128, otherwise "how many bytes" + the bytes.
    static [byte[]] Length([int]$n) {
        if ($n -lt 0x80) { return [byte[]]@([byte]$n) }
        $tmp = New-Object 'System.Collections.Generic.List[byte]'
        $v = $n
        while ($v -gt 0) { $tmp.Insert(0, [byte]($v -band 0xFF)); $v = $v -shr 8 }
        $out = New-Object 'System.Collections.Generic.List[byte]'
        $out.Add([byte](0x80 -bor $tmp.Count))
        $out.AddRange($tmp)
        return $out.ToArray()
    }

    static [byte[]] Tlv([byte]$tag, [byte[]]$content) {
        $out = New-Object 'System.Collections.Generic.List[byte]'
        $out.Add($tag)
        $out.AddRange([Der]::Length($content.Length))
        $out.AddRange($content)
        return $out.ToArray()
    }

    # Careful: a DER INTEGER is **signed**. RSA numbers are always positive, but
    #    if the leftmost bit is 1, DER reads it as negative - so a leading
    #    0x00 must be added. Without it the key would look fine, yet
    #    OpenSSL/Node would give a cryptic error like "bad decrypt".
    static [byte[]] Integer([byte[]]$unsigned) {
        $i = 0
        while ($i -lt ($unsigned.Length - 1) -and $unsigned[$i] -eq 0) { $i++ }
        $body = New-Object 'System.Collections.Generic.List[byte]'
        if (($unsigned[$i] -band 0x80) -ne 0) { $body.Add([byte]0) }
        for ($j = $i; $j -lt $unsigned.Length; $j++) { $body.Add($unsigned[$j]) }
        return [Der]::Tlv(0x02, $body.ToArray())
    }

    # Careful: the name is `Seq`, not `Sequence`. `sequence` is a reserved
    #    workflow keyword in Windows PowerShell 5.1, and as a class method name
    #    the whole file fails to parse - with the misleading message "Missing
    #    statement body after keyword 'Sequence'", from which the real cause
    #    cannot be guessed.
    static [byte[]] Seq([byte[]]$content) { return [Der]::Tlv(0x30, $content) }

    static [byte[]] OctetString([byte[]]$content) { return [Der]::Tlv(0x04, $content) }

    # BIT STRING's first byte = "how many bits are unused at the end". For a key it is always 0.
    static [byte[]] BitString([byte[]]$content) {
        $body = New-Object 'System.Collections.Generic.List[byte]'
        $body.Add([byte]0)
        $body.AddRange($content)
        return [Der]::Tlv(0x03, $body.ToArray())
    }

    static [byte[]] Cat([byte[][]]$parts) {
        $out = New-Object 'System.Collections.Generic.List[byte]'
        foreach ($p in $parts) { $out.AddRange($p) }
        return $out.ToArray()
    }
}

# AlgorithmIdentifier { rsaEncryption (1.2.840.113549.1.1.1), NULL } - a constant.
# For RSA it never changes, so it is written directly as bytes instead of encoded.
$RsaAlgId = [byte[]]@(
    0x30, 0x0D, 0x06, 0x09, 0x2A, 0x86, 0x48, 0x86,
    0xF7, 0x0D, 0x01, 0x01, 0x01, 0x05, 0x00
)

function ConvertTo-Pem {
    param([Parameter(Mandatory)][string]$Label, [Parameter(Mandatory)][byte[]]$Bytes)

    $b64 = [Convert]::ToBase64String($Bytes)
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append("-----BEGIN $Label-----`n")
    for ($i = 0; $i -lt $b64.Length; $i += 64) {
        $len = [Math]::Min(64, $b64.Length - $i)
        [void]$sb.Append($b64.Substring($i, $len)).Append("`n")
    }
    [void]$sb.Append("-----END $Label-----`n")
    return $sb.ToString()
}

# RSAParameters -> PKCS#8 (`BEGIN PRIVATE KEY`).
# Node could read PKCS#1 too, but PKCS#8 is the common language of all of today's tools.
function ConvertTo-Pkcs8 {
    param([Parameter(Mandatory)][System.Security.Cryptography.RSAParameters]$P)

    $pkcs1 = [Der]::Seq([Der]::Cat([byte[][]]@(
        [Der]::Integer([byte[]]@(0)),
        [Der]::Integer($P.Modulus),
        [Der]::Integer($P.Exponent),
        [Der]::Integer($P.D),
        [Der]::Integer($P.P),
        [Der]::Integer($P.Q),
        [Der]::Integer($P.DP),
        [Der]::Integer($P.DQ),
        [Der]::Integer($P.InverseQ)
    )))

    return [Der]::Seq([Der]::Cat([byte[][]]@(
        [Der]::Integer([byte[]]@(0)),
        $RsaAlgId,
        [Der]::OctetString($pkcs1)
    )))
}

# SPKI = the basis of the pin. It identifies the **key**, not the certificate -
#    so keeping the key the same keeps the pin the same even after renewal.
function Get-SpkiBytes {
    param([Parameter(Mandatory)][System.Security.Cryptography.X509Certificates.X509Certificate2]$Cert)

    $rsaPublicKey = $Cert.PublicKey.EncodedKeyValue.RawData
    return [Der]::Seq([Der]::Cat([byte[][]]@(
        $RsaAlgId,
        [Der]::BitString($rsaPublicKey)
    )))
}

function Get-Sha256Base64 {
    param([Parameter(Mandatory)][byte[]]$Bytes)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return [Convert]::ToBase64String($sha.ComputeHash($Bytes)) }
    finally { $sha.Dispose() }
}

function Get-Sha256Hex {
    param([Parameter(Mandatory)][byte[]]$Bytes)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return (($sha.ComputeHash($Bytes) | ForEach-Object { $_.ToString('X2') }) -join ':') }
    finally { $sha.Dispose() }
}

# ══════════════════════════════════════════════════════════════════════════
#  1. Which names, which IPs
# ══════════════════════════════════════════════════════════════════════════

# Careful: `powershell -File` **does not understand arrays** - `-IpAddress
#    10.0.0.1,10.0.0.2` arrives as a single string, and it would stop with "not
#    a valid IP". The README says to use `-File` (the simplest), so the script
#    splits the commas itself. The alternative was to teach the owner `-Command`
#    and its quoting tangles.
function Split-List {
    param([string[]]$Values)
    $out = @()
    foreach ($v in @($Values)) {
        if (-not $v) { continue }
        foreach ($part in ($v -split '[,;\s]+')) {
            $p = $part.Trim()
            if ($p) { $out += $p }
        }
    }
    return $out
}

$IpAddress = Split-List $IpAddress
$AlsoDns = Split-List $AlsoDns

if (-not $Hostname) { $Hostname = $env:COMPUTERNAME.ToLowerInvariant() }

if (-not $IpAddress -or $IpAddress.Count -eq 0) {
    $found = @()
    try {
        # Careful: APIPA (169.254.x) and loopback are excluded - no point having them in the SAN.
        #    IPs of virtual adapters (Docker/WSL/Hyper-V) are **not excluded**:
        #    an extra SAN does no harm, but if the real one were left out the
        #    browser could not connect at all. So keep more, not fewer.
        $found = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
            Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' } |
            Select-Object -ExpandProperty IPAddress -Unique)
    }
    catch {
        $found = @([System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) |
            Where-Object { $_.AddressFamily -eq 'InterNetwork' } |
            ForEach-Object { $_.IPAddressToString } |
            Where-Object { $_ -notmatch '^(127\.|169\.254\.)' })
    }
    $IpAddress = $found
}

$dnsNames = @($Hostname)
foreach ($d in $AlsoDns) { if ($d -and $dnsNames -notcontains $d) { $dnsNames += $d } }

# Careful: the FQDN is added by us - often the browser uses the short name and
#    the agent the full name, and if one is missing only that one breaks.
try {
    $fqdn = [System.Net.Dns]::GetHostEntry($env:COMPUTERNAME).HostName
    if ($fqdn -and $dnsNames -notcontains $fqdn) { $dnsNames += $fqdn }
}
catch { Write-Verbose "FQDN পাওয়া গেল না — সমস্যা নেই" }

# localhost - for smoke-testing from the server machine itself
if ($dnsNames -notcontains 'localhost') { $dnsNames += 'localhost' }
$ipList = @($IpAddress) + @('127.0.0.1') | Select-Object -Unique

if ($ipList.Count -le 1) {
    Write-Warning 'কোনো LAN IP পাওয়া যায়নি — শুধু 127.0.0.1 বসছে।'
    Write-Warning 'এজেন্টগুলো IP দিয়ে সংযোগ করলে -IpAddress দিয়ে হাতে বলে দিন।'
}

# ══════════════════════════════════════════════════════════════════════════
#  2. Where the files go, and the guard against overwriting
# ══════════════════════════════════════════════════════════════════════════

if (-not $OutDir) { $OutDir = Join-Path $PSScriptRoot 'certs' }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$OutDir = (Resolve-Path $OutDir).Path

$certPath = Join-Path $OutDir 'oxeio-cert.pem'
$keyPath = Join-Path $OutDir 'oxeio-key.pem'
$pfxPath = Join-Path $OutDir 'oxeio.pfx'
$pinPath = Join-Path $OutDir 'oxeio-pin.txt'

if ($ReuseKey) {
    if (-not (Test-Path $pfxPath)) {
        throw "-ReuseKey দেওয়া হয়েছে, কিন্তু $pfxPath নেই। প্রথমবার -ReuseKey ছাড়া চালান।"
    }
}
elseif ((Test-Path $keyPath) -and -not $Force) {
    # Careful: this guard is the most useful part of the script.
    #    A new key = a new pin = the agents on 15 PCs stop connecting, and that
    #    would be noticed much later (agents quietly keep queuing).
    #    To renew use -ReuseKey; if you really want a new key, use -Force.
    throw @"
$keyPath ইতিমধ্যেই আছে।

  নবায়ন করতে চান?          -ReuseKey  দিন (পিন এক থাকে, PC-তে হাত দিতে হবে না)
  সত্যিই নতুন কী চান?      -Force     দিন (⚠️ পিন বদলাবে — README § ৭.২ পড়ুন)
"@
}

# ══════════════════════════════════════════════════════════════════════════
#  3. Key and certificate
# ══════════════════════════════════════════════════════════════════════════

Write-Host ''
Write-Host '── সার্টিফিকেট বানানো হচ্ছে ─────────────────' -ForegroundColor Cyan

$rsa = $null
$oldPfx = $null
try {
    if ($ReuseKey) {
        # Careful: the bytes are read with `[System.IO.File]::ReadAllBytes`, into a
        #    separate `[byte[]]` variable. `Get-Content -Encoding Byte` was not used
        #    for two reasons: (1) that parameter does not exist in PowerShell 7
        #    (there it is `-AsByteStream`), (2) the result comes back as `object[]`,
        #    and then the X509Certificate2 constructor picks the `(string path, ...)`
        #    overload and turns the array into the string "System.Byte[]" -
        #    giving the message "The system cannot find the file specified", so
        #    it seems the pfx file is missing, while it is right where it should be.
        [byte[]]$pfxBytes = [System.IO.File]::ReadAllBytes($pfxPath)

        # Careful: Exportable, but **not** PersistKeySet - otherwise the key would
        #    stay in Windows' CNG store and nobody would ever delete it.
        $oldPfx = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2(
            $pfxBytes,
            '',
            [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::Exportable)

        # Careful: the key is **not copied** here, it is used directly.
        #
        # The obvious approach would be to make our own copy with
        # `$rsa.ImportParameters($old.ExportParameters($true))`. But that does
        # not work: the key returned from a PFX is a CNG key, and the `Exportable`
        # flag gives it only `AllowExport` (an **encrypted** export, e.g. into
        # a PFX again) - not `AllowPlaintextExport`. So `ExportParameters($true)`
        # throws "The requested operation is not supported", and reading the
        # message you would think the pfx file itself is corrupt.
        #
        # It is not needed anyway. To create a new certificate the key only has
        #    to **sign** - a CNG key can do that fine. And the private key's PEM
        #    file is **not touched at all** on renewal: the key is the same, so
        #    the file stays the same. So on renewal there is no risk of
        #    rewriting the secret file.
        $rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($oldPfx)
        if (-not $rsa) { throw "$pfxPath-এ প্রাইভেট কী নেই।" }

        if (-not (Test-Path $keyPath)) {
            throw "$keyPath নেই। -ReuseKey কী-র ফাইলটা নতুন করে লেখে না, তাই ওটা থাকতেই হবে।"
        }

        Write-Host '   কী: আগেরটাই — পিন বদলাবে না, PC-তে হাত দিতে হবে না' -ForegroundColor Green
    }
    else {
        $rsa = [System.Security.Cryptography.RSA]::Create($KeySize)
        Write-Host "   কী: নতুন RSA-$KeySize"
    }

    $req = New-Object System.Security.Cryptography.X509Certificates.CertificateRequest(
        "CN=$Hostname",
        $rsa,
        [System.Security.Cryptography.HashAlgorithmName]::SHA256,
        [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)

    $san = New-Object System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder
    foreach ($d in $dnsNames) { $san.AddDnsName($d) }
    foreach ($ip in $ipList) {
        $parsed = [System.Net.IPAddress]::Any
        if (-not [System.Net.IPAddress]::TryParse($ip, [ref]$parsed)) {
            throw "'$ip' একটা বৈধ IP নয়।"
        }
        $san.AddIpAddress($parsed)
    }
    $req.CertificateExtensions.Add($san.Build())

    # Not a CA - other certificates cannot be signed with this one
    $req.CertificateExtensions.Add((New-Object System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension(
                $false, $false, 0, $true)))

    $req.CertificateExtensions.Add((New-Object System.Security.Cryptography.X509Certificates.X509KeyUsageExtension(
        ([System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor
                    [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment), $true)))

    # EKU serverAuth. Careful: without it Windows/Chrome treat the certificate as
    #    invalid for a server, and the error message is so cryptic that finding the cause takes days.
    $ekus = New-Object System.Security.Cryptography.OidCollection
    [void]$ekus.Add((New-Object System.Security.Cryptography.Oid('1.3.6.1.5.5.7.3.1', 'Server Authentication')))
    $req.CertificateExtensions.Add((New-Object System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension(
                $ekus, $false)))

    $req.CertificateExtensions.Add((New-Object System.Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension(
                $req.PublicKey, $false)))

    # Careful: start 5 minutes in the past - an office PC's clock does not match
    #    the server's exactly. Without this, for a few minutes after creation some
    #    machines would say "not yet valid", and nobody would know why.
    $notBefore = [DateTimeOffset]::UtcNow.AddMinutes(-5)
    $notAfter = $notBefore.AddDays($Days)

    $cert = $req.CreateSelfSigned($notBefore, $notAfter)

    # ══════════════════════════════════════════════════════════════════════
    #  4. Writing the files
    # ══════════════════════════════════════════════════════════════════════

    $certPem = ConvertTo-Pem -Label 'CERTIFICATE' -Bytes $cert.RawData
    $spki = Get-SpkiBytes -Cert $cert
    $pin = Get-Sha256Base64 -Bytes $spki

    # Careful: UTF-8 without BOM, mandatory. `Set-Content -Encoding utf8` adds a
    #    BOM in 5.1, and with a BOM Node cannot read the PEM - the message is
    #    "error:0909006C:PEM routines:get_name:no start line", from which nobody
    #    can tell that the fault is three invisible bytes.
    #
    # Careful: yet **this script file itself** must have a UTF-8 BOM - the
    #    opposite rule. Windows PowerShell 5.1 treats a file without a BOM as
    #    ANSI, and then the Bengali text below breaks and the script does not even parse.
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($certPath, $certPem, $utf8NoBom)

    # On renewal the private key file is **not touched** (see the explanation above).
    #    The key is the same, so the file is too - and rewriting the secret file
    #    for no reason would only create a chance of damaging it.
    if (-not $ReuseKey) {
        $keyPem = ConvertTo-Pem -Label 'PRIVATE KEY' -Bytes (ConvertTo-Pkcs8 -P $rsa.ExportParameters($true))
        [System.IO.File]::WriteAllText($keyPath, $keyPem, $utf8NoBom)
    }

    [System.IO.File]::WriteAllBytes($pfxPath, $cert.Export(
            [System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, ''))

    $thumb = Get-Sha256Hex -Bytes $cert.RawData

    $pinText = @"
oXeio TLS — এজেন্টে বসানোর তথ্য
================================

SPKI পিন (এটাই MSI-র SERVERPIN):
  $pin

সার্টিফিকেটের SHA-256 (ব্রাউজারে মিলিয়ে দেখার জন্য):
  $thumb

নাম (SAN):  $($dnsNames -join ', ')
IP  (SAN):  $($ipList -join ', ')
মেয়াদ:      $($notBefore.ToLocalTime().ToString('yyyy-MM-dd')) থেকে $($notAfter.ToLocalTime().ToString('yyyy-MM-dd'))
বানানো:     $([DateTimeOffset]::Now.ToString('yyyy-MM-dd HH:mm'))

⚠️ SPKI পিন গোপন নয় — এটা পাবলিক কী-র হ্যাশ। নির্ভয়ে ইমেইলে পাঠানো যায়।
⚠️ oxeio-key.pem আর oxeio.pfx **গোপন** — কখনো git-এ বা ইমেইলে নয়।
"@
    [System.IO.File]::WriteAllText($pinPath, $pinText, $utf8NoBom)

    # ── ACL of the private key ────────────────────────────────────────────
    # Careful: no throw on failure - the certificate has been created, and
    #    discarding it would make no sense. But the warning must not escape notice.
    foreach ($secret in @($keyPath, $pfxPath)) {
        try {
            # Careful: **not** `Get-Acl` + `Set-Acl`, but a brand-new FileSecurity.
            #
            # What Get-Acl returns carries owner/group/SACL fields besides the
            # DACL, and Set-Acl tries to write those too - then without admin
            # rights "The process does not possess the 'SeSecurityPrivilege'
            # privilege" arrives and setting the permission fails. An empty
            # object has only the DACL to change, so only that is written - it
            # works as an ordinary user too.
            $acl = New-Object System.Security.AccessControl.FileSecurity

            # Inheritance off - otherwise "Users: Read" would flow down from the
            # folder, and any account in the office could read the private key.
            $acl.SetAccessRuleProtection($true, $false)
            foreach ($who in @('NT AUTHORITY\SYSTEM', 'BUILTIN\Administrators', "$env:USERDOMAIN\$env:USERNAME")) {
                $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
                            $who, 'FullControl', 'Allow')))
            }
            (Get-Item -LiteralPath $secret).SetAccessControl($acl)
        }
        catch {
            Write-Warning "$secret-এর অনুমতি শক্ত করা গেল না: $($_.Exception.Message)"
            Write-Warning 'ফাইলটা হাতে দেখে নিন — সাধারণ ইউজার যেন পড়তে না পারে।'
        }
    }

    # ══════════════════════════════════════════════════════════════════════
    #  5. What happened, what to do now
    # ══════════════════════════════════════════════════════════════════════

    Write-Host ''
    Write-Host '✅ তৈরি' -ForegroundColor Green
    Write-Host "   $certPath"
    if ($ReuseKey) {
        Write-Host "   $keyPath      (অপরিবর্তিত — আগের কী-ই)"
    }
    else {
        Write-Host "   $keyPath      ⚠️ গোপন"
    }
    Write-Host "   $pfxPath          ⚠️ গোপন"
    Write-Host "   $pinPath"
    Write-Host ''
    Write-Host '── সার্টিফিকেটে যা আছে ──────────────────────' -ForegroundColor Cyan
    Write-Host "   নাম : $($dnsNames -join ', ')"
    Write-Host "   IP  : $($ipList -join ', ')"
    Write-Host "   মেয়াদ: $($notAfter.ToLocalTime().ToString('yyyy-MM-dd')) পর্যন্ত ($Days দিন)"
    Write-Host ''
    Write-Host '   ⚠️ উপরের তালিকাটা মিলিয়ে দেখুন। এজেন্ট বা ব্রাউজার যে ঠিকানা' -ForegroundColor Yellow
    Write-Host '      ব্যবহার করবে সেটা এখানে না থাকলে সংযোগ হবে না।' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '── SPKI পিন (MSI-র SERVERPIN) ───────────────' -ForegroundColor Cyan
    Write-Host "   $pin" -ForegroundColor Green
    Write-Host ''
    Write-Host '── পরের ধাপ ─────────────────────────────────' -ForegroundColor Cyan
    Write-Host '   deploy/README.md § ৩ থেকে এগোন।'
    Write-Host ''
}
finally {
    if ($rsa) { $rsa.Dispose() }
    if ($oldPfx) { $oldPfx.Dispose() }
}
