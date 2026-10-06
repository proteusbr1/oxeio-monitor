<#
.SYNOPSIS
  Builds the oXeio agent's MSI (H03).

.DESCRIPTION
  Steps:
    1. Self-contained publish of both projects into the SAME folder
    2. wix build: WiX builds the file list itself via <Files Include>

  Careful: both projects are published into one folder on purpose. Separate folders
  would install the .NET runtime twice (379 MB vs 199 MB).

.EXAMPLE
  powershell -File installer\build.ps1 -ServerUrl https://monitor.example.com
  powershell -File installer\build.ps1 -ServerUrl https://monitor.example.com -Version 0.3.0
  powershell -File installer\build.ps1 -NoServerUrl

.NOTES
  Careful: this file is saved WITH a UTF-8 BOM. Do not remove the BOM.

  Windows PowerShell 5.1 (the one on stock Windows) treats a file without a BOM as
  ANSI, and then the non-ASCII text below (the ⚠️ marks, dashes and box-drawing
  lines in the messages) is garbled and the script does not even parse: it stops
  with three or four `Unexpected token` errors.

  Careful: the file had no BOM from day one, and this went unnoticed because the
  previous build ran under `pwsh` (PowerShell 7), which assumes UTF-8 without a BOM.
  So on a machine without PowerShell 7 (stock Windows) the MSI could not be built at
  all. The `deploy/*.ps1` scripts already had this rule written down
  ([deploy/README.md](../../deploy/README.md) › "The scripts in this folder");
  only this file had missed it.
#>
[CmdletBinding()]
param(
    # Careful: the default is NOT hardcoded; it is read from Directory.Build.props
    # (below). It used to say '0.1.0' here and the same number separately in
    # Program.cs; when the two differed the MSI installed one version and the agent
    # reported another in its heartbeat, so H04 offered the same update forever.
    [string]$Version,

    # The address agents connect to, e.g. https://monitor.example.com. It is baked
    # into the MSI, which then **installs on a double-click**: no long command to
    # type on every PC.
    #
    # Careful: there is deliberately NO default. It used to be empty, and without
    # `-ServerUrl` the build silently produced an MSI that stopped on double-click
    # with "This MSI was built without a server address". That is exactly what
    # happened with 0.3.2: the build succeeded, the warning was one DarkGray line,
    # and the mistake was found only when the owner installed it.
    #
    # A built-in address is no fix either: every installation has its own server.
    # So the build now fails loudly (below) unless you pass `-ServerUrl`, or ask
    # for an MSI without an address explicitly with `-NoServerUrl`.
    [string]$ServerUrl,

    # An MSI without an address, for rollouts that pass it at install time
    # (`msiexec /qn SERVERURL=...`), e.g. several sites with different servers.
    [switch]$NoServerUrl,

    # ADR-014: thumbprint of the self-made signing certificate (make-code-cert.ps1
    # prints it). Without it the build runs as before, with no error; otherwise
    # building on a dev machine would be blocked.
    [string]$SignWith,

    # The owner's public key for signed updates — a .pem file or its base64
    # body. Baked into the MSI (UPDATEKEY), so the agent installs only updates
    # signed with the matching private key. Empty = sha256 only, as before.
    # deploy/README.md › "Signed agent updates".
    [string]$UpdatePublicKey,

    # A build whose Today window does not show the last screenshot — only
    # when it was taken — and keeps no copy of it on the PC. Pictures are
    # still taken and sent as before. Fixed in the build, so nobody at the PC
    # can turn the preview back on. The MSI name ends in -nopreview.
    [switch]$HideLatestShot,

    # Sign without a timestamp. **Do not normally pass this**; see below for why.
    [switch]$NoTimestamp,

    [string]$TimestampUrl = 'http://timestamp.digicert.com',

    [string]$Configuration = 'Release',
    [string]$Runtime = 'win-x64'
)

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$agentRoot = Split-Path -Parent $here
$publishDir = Join-Path $here 'obj\publish'
$outDir = Join-Path $here 'bin'
# Careful: the version is in the file name; $msi is set below, once the version is known

# ── Version: single source is Directory.Build.props ──────────────────────────
# Careful: an explicit -Version wins (for hotfix builds), but then the assembly's
#    version and the MSI's version differ; a warning is shown below.
$propsPath = Join-Path $agentRoot 'Directory.Build.props'
$propsVersion = ([xml](Get-Content $propsPath)).Project.PropertyGroup.Version

if (-not $propsVersion) {
    throw "No <Version> found in Directory.Build.props: $propsPath"
}

if (-not $Version) {
    $Version = $propsVersion
} elseif ($Version -ne $propsVersion) {
    Write-Warning @"
The MSI will install as $Version, but the agent's assembly will report $propsVersion.
⚠️ The server decides whether to offer an update from the version in the heartbeat (G59) —
   when the two differ, that machine is offered the same update again and again.
   The right fix is to change <Version> in Directory.Build.props and run again.
"@
}

<#
  The version is in the file name: `oXeioAgent-0.3.0.msi`.

  Careful: the name used to be the fixed `oXeioAgent.msi`, and on 12 August exactly
  that bit us: three different binaries went out the same day under the same name
  and version (09:48, 15:53, 16:43). The owner ran the old one and thought the new
  feature had not arrived, and there was no way to tell which was which.

  Now every build stays as a separate file in `bin/`, so they can sit side by side
  and the wrong file cannot be handed out by mistake.
#>
# ⚠️ the variant is in the name too — same version, different behaviour
$variant = if ($HideLatestShot) { '-nopreview' } else { '' }
$msi = Join-Path $outDir "oXeioAgent-$Version$variant.msi"

Write-Host "   version: $Version" -ForegroundColor DarkGray
if ($HideLatestShot) {
    Write-Host '   last screenshot preview: hidden (-HideLatestShot)' -ForegroundColor DarkGray
}

# Careful: building the same version again means two different binaries under one
#    name, exactly the mistake this naming scheme exists to prevent. It does not stop
#    (dev needs to rebuild repeatedly), but says so in a way that is hard to miss.
if (Test-Path $msi) {
    Write-Warning @"
$Version already exists — it is being overwritten.
⚠️ If you have already handed that file out, raise <Version> in
   Directory.Build.props. Two binaries under one number = no way to
   tell any more which one is running where.
"@
}

# Careful: fail loudly without an address. There is no default on purpose (see the
#    -ServerUrl parameter): an MSI silently built without one stops on double-click,
#    and a built-in address would point it at somebody else's server.
if ($ServerUrl -and $NoServerUrl) {
    throw "Pass either -ServerUrl or -NoServerUrl, not both."
}
if (-not $ServerUrl -and -not $NoServerUrl) {
    throw "No server address. Pass -ServerUrl https://monitor.example.com (the address agents connect to), or -NoServerUrl for an MSI installed with msiexec SERVERURL=..."
}

if ($ServerUrl) {
    # Careful: the shape is checked right here. A wrong address baked into the MSI
    #    would only be noticed after installing on every PC, as "not reaching the server".
    if ($ServerUrl -notmatch '^https?://[^/\s]+/?$') {
        throw "ServerUrl should look like https://monitor.example.com (scheme and host, no path) — got: $ServerUrl"
    }
    Write-Host "   server : $ServerUrl (baked into the MSI — installs on a double-click)" -ForegroundColor DarkGray
} else {
    # Careful: not DarkGray. This MSI will NOT work on double-click, and 0.3.2 came
    #    out wrong precisely because this one line was easy to miss.
    Write-Host "   server : ⚠️ not baked in (-NoServerUrl) — will NOT install on a double-click," -ForegroundColor Yellow
    Write-Host "            msiexec needs SERVERURL=" -ForegroundColor Yellow
}

Write-Host '── 1· publish ────────────────────────────────' -ForegroundColor Cyan

# Careful: a running agent LOCKS the DLLs in obj\publish, and then the Remove-Item
#    below stops with "Access denied". The message names Accessibility.dll, so the real
#    cause ("you are running it yourself") is written nowhere.
#
# Careful: this is not just an inconvenience. Even when the build stops, the PREVIOUS
#    MSI stays in bin/ and the PREVIOUS exe in obj\publish. On the night of 12 August
#    exactly this trap led to measuring the old binary twice and concluding "the fix
#    works".
# Careful: the condition is not "oXeio is running" but "running from **obj\publish**".
#    The installed agent (Program Files) or a separate test copy locks nothing in this
#    folder; stopping for those too would force closing your own installation on every
#    build.
$locking = @(
    Get-Process -Name 'oXeio.Agent', 'oXeio.Watchdog' -ErrorAction SilentlyContinue |
        Where-Object {
            # Careful: reading Path can throw (another user's process); then assume
            #    it is not from our folder, otherwise the build would be blocked for nothing
            $p = try { $_.Path } catch { $null }
            $p -and $p.StartsWith($publishDir, [StringComparison]::OrdinalIgnoreCase)
        }
)
if ($locking) {
    throw @"
oXeio is running ($(($locking | ForEach-Object { "$($_.Name)#$($_.Id)" }) -join ', ')) —
the files in the publish folder are locked, so the build cannot continue.

    Stop-Process -Name oXeio.Agent, oXeio.Watchdog -Force

⚠️ To run the agent for testing, do **not** run it from obj\publish — copy it to
   another folder first, or the next build will quietly leave the old binary behind.
"@
}

# ══════════════════════════════════════════════════════════════════════════
#  Signing (ADR-014)
#
#  Careful: the certificate is looked up FIRST, before publish starts. If the
#     thumbprint is wrong we need to know now, not after a 62 MB build finishes.
# ══════════════════════════════════════════════════════════════════════════
$signCert = $null
if ($SignWith) {
    $signCert = Get-ChildItem Cert:\CurrentUser\My, Cert:\LocalMachine\My -ErrorAction SilentlyContinue |
        Where-Object { $_.Thumbprint -eq $SignWith.Replace(' ', '') } |
        Select-Object -First 1

    if (-not $signCert) {
        throw @"
No certificate found with this thumbprint: $SignWith

⚠️ The certificate must be in **this user's** store (with its private key). Sign on
   the same machine where make-code-cert.ps1 was run.

   To sign on another machine, import the .pfx:
       Import-PfxCertificate -FilePath deploy\certs\oxeio-code.pfx ``
           -CertStoreLocation Cert:\CurrentUser\My
"@
    }

    if (-not $signCert.HasPrivateKey) {
        throw "The certificate is there but has no private key — the .cer was imported, not the .pfx."
    }

    if ($signCert.NotAfter -lt (Get-Date)) {
        throw "The certificate expired ($($signCert.NotAfter.ToString('yyyy-MM-dd'))) — make a new one."
    }

    Write-Host "   signing: $($signCert.Subject) (valid until $($signCert.NotAfter.ToString('yyyy-MM-dd')))" -ForegroundColor DarkGray
    if ($NoTimestamp) {
        Write-Host '   ⚠️ no timestamp — the signatures stop being valid when the certificate expires' -ForegroundColor Yellow
    }
}
else {
    Write-Host '   signing: off (pass -SignWith to sign)' -ForegroundColor DarkGray
}

<#
.SYNOPSIS
    Applies an Authenticode signature to one file and verifies the result.
#>
function Invoke-Sign {
    param([Parameter(Mandatory)][string]$Path)

    if (-not $signCert) { return }

    $args = @{ FilePath = $Path; Certificate = $signCert; HashAlgorithm = 'SHA256' }

    # Careful: a timestamp is REQUIRED. Without one, every earlier build's signature
    #    becomes invalid on the day the certificate expires, so in 5 years no machine
    #    could be repaired with an old MSI. With a timestamp, "the certificate was valid
    #    when it was signed" is enough, forever.
    if (-not $NoTimestamp) { $args.TimestampServer = $TimestampUrl }

    $result = Set-AuthenticodeSignature @args
    $name = Split-Path $Path -Leaf

    # Careful: **`Status` means "could this machine verify the signature", NOT "was a
    #    signature applied"**, and the two differ for a self-signed certificate.
    #
    #    If the build machine has not put its own certificate in Trusted Root, Windows
    #    says `UnknownError` ("chain terminated in a root certificate which is not
    #    trusted"). Yet the signature WAS applied, the timestamp too, and on the PCs
    #    where trust-publisher.ps1 has run it is fully valid.
    #
    #    Careful: at first this threw whenever `Status -ne 'Valid'`, so right after
    #    creating the certificate the build stopped and signing became IMPOSSIBLE, with
    #    no real problem. (Found while measuring, 12 August.)
    #
    #    So the real question is asked: **was the signature applied with OUR
    #    certificate?**
    $signed = Get-AuthenticodeSignature $Path
    $mine = $signed.SignerCertificate -and
            $signed.SignerCertificate.Thumbprint -eq $signCert.Thumbprint

    if (-not $mine) {
        $hint = if (-not $NoTimestamp) {
            "`n⚠️ This also happens when the timestamp server cannot be reached ($TimestampUrl)." +
            "`n   To build offline pass -NoTimestamp, but then the signatures expire with the certificate."
        } else { '' }

        throw "Signing failed ($name): $($result.Status) — $($result.StatusMessage)$hint"
    }

    # Careful: a timestamp was requested but not applied; this must not pass silently.
    #    When the certificate expired, all the old builds' signatures would go invalid at once.
    if (-not $NoTimestamp -and -not $signed.TimeStamperCertificate) {
        throw "Signed, but no timestamp was applied ($name) — could not reach $TimestampUrl."
    }

    $script:LocalTrustWarning = $script:LocalTrustWarning -or ($signed.Status -ne 'Valid')

    Write-Host "   ✍ $name" -ForegroundColor DarkGray
}

if (Test-Path $publishDir) { Remove-Item $publishDir -Recurse -Force }
New-Item -ItemType Directory -Path $publishDir -Force | Out-Null

foreach ($project in 'oXeio.Agent', 'oXeio.Watchdog') {
    Write-Host "   $project"
    # Careful: DebugType=none, otherwise libSkiaSharp.pdb alone adds 86 MB.
    #    There is no reason for debug symbols to reach the staff PCs.
    & dotnet publish (Join-Path $agentRoot "src\$project") `
        -c $Configuration -r $Runtime --self-contained true `
        -p:DebugType=none -p:DebugSymbols=false `
        -p:HideLatestShot=$(if ($HideLatestShot) { 'true' } else { 'false' }) `
        -o $publishDir --nologo -v quiet
    if ($LASTEXITCODE -ne 0) { throw "$project publish failed" }
}

Get-ChildItem $publishDir -Filter *.pdb | Remove-Item -Force

$size = [math]::Round((Get-ChildItem $publishDir -Recurse | Measure-Object Length -Sum).Sum / 1MB, 1)
$count = (Get-ChildItem $publishDir -Recurse -File).Count
Write-Host "   $count files · $size MB"

# Careful: the exes are signed BEFORE wix build, on purpose. Signed afterwards, the MSI
#    would contain the unsigned copy and the unsigned exe would land on disk after install,
#    while the MSI's signature made everything look fine.
#
# ADR-014: AV is more suspicious of the inner oXeio.Agent.exe than of the wrapper,
#    so both exes need a signature, not only the MSI.
foreach ($exe in 'oXeio.Agent.exe', 'oXeio.Watchdog.exe') {
    Invoke-Sign (Join-Path $publishDir $exe)
}

Write-Host '── 2· wix build ─────────────────────────────' -ForegroundColor Cyan

New-Item -ItemType Directory -Path $outDir -Force | Out-Null

# Careful: -bindpath. `oxeio.ico` is written as a RELATIVE path in Package.wxs. Without
#    it wix looks for the file from the cwd, not next to Package.wxs, so building from any
#    folder other than installer/ would stop with `Cannot find oxeio.ico`. Exactly this
#    happened on 18 August (it was run from web/, not agent/), and the documented
#    `powershell -File installer\build.ps1` (cwd agent/) would have broken the same way.
#    With bindpath, wix finds the file in installer/ wherever the cwd is.
# The update key as one line of base64 — a file path or the key itself
$updateKeyLine = ''
if ($UpdatePublicKey) {
    $raw = if (Test-Path $UpdatePublicKey) { Get-Content $UpdatePublicKey -Raw } else { $UpdatePublicKey }
    $updateKeyLine = ($raw -replace '-----(BEGIN|END) PUBLIC KEY-----', '' -replace '\s', '')
    if ($updateKeyLine -notmatch '^[A-Za-z0-9+/=]+$') {
        throw "UpdatePublicKey is not a PEM public key or its base64 body: $UpdatePublicKey"
    }
    Write-Host "   update : signed updates only (key $($updateKeyLine.Substring(0, [Math]::Min(16, $updateKeyLine.Length)))…)" -ForegroundColor DarkGray
}

& wix build `
    (Join-Path $here 'Package.wxs') `
    -arch x64 `
    -bindpath "$here" `
    -d "PublishDir=$publishDir" `
    -d "Version=$Version" `
    -d "ServerUrlDefault=$($ServerUrl.TrimEnd('/'))" `
    -d "UpdateKeyDefault=$updateKeyLine" `
    -o $msi

if ($LASTEXITCODE -ne 0) { throw 'wix build failed' }

# Careful: the MSI is signed AFTER wix build, once the wrapper exists. This is the
#    signature that shows "Verified publisher" in the double-click UAC dialog.
Invoke-Sign $msi

$msiName = Split-Path $msi -Leaf
$msiSize = [math]::Round((Get-Item $msi).Length / 1MB, 1)
Write-Host ''
Write-Host "✅ $msi · $msiSize MB" -ForegroundColor Green

# Whether it is signed is reported by READING THE FILE, not by assuming "we signed it".
#    This kind of assumption is what let three wrong builds out on 12 August.
$sig = Get-AuthenticodeSignature $msi
if ($sig.SignerCertificate) {
    $stamped = if ($sig.TimeStamperCertificate) { 'timestamped' } else { '⚠️ no timestamp' }
    Write-Host "   ✍ signed: $($sig.SignerCertificate.Subject) · $stamped" -ForegroundColor Green

    # Careful: this machine could not verify the signature. Almost always it means the
    #    build machine has not put its own certificate in Trusted Root. The MSI is fine;
    #    on a staff PC (where trust-publisher.ps1 has run) it will show as valid.
    if ($script:LocalTrustWarning) {
        Write-Host ''
        Write-Host '   ⚠️ This machine cannot verify the signature — the certificate is not in' -ForegroundColor Yellow
        Write-Host '      Trusted Root here. The MSI is fine; it shows as valid on every PC where' -ForegroundColor Yellow
        Write-Host '      trust-publisher.ps1 has run.' -ForegroundColor Yellow
        Write-Host '      To verify it here too, run that script once on this machine as well.' -ForegroundColor Yellow
    }
}
else {
    Write-Host '   ⚠️ Not signed — installing will show "Unknown publisher"' -ForegroundColor Yellow
    Write-Host '      (to sign: -SignWith <thumbprint>, see deploy/make-code-cert.ps1)' -ForegroundColor Yellow
}

Write-Host ''
if ($ServerUrl) {
    Write-Host 'Install — staff sign in with their own email and password:' -ForegroundColor Yellow
    Write-Host "  double-click, or:  msiexec /i $msiName /qn"
} else {
    Write-Host 'Silent install:' -ForegroundColor Yellow
    Write-Host "  msiexec /i $msiName /qn SERVERURL=`"https://monitor.example.com`""
}

# Everything in bin/, so it is clear at a glance which build is new and which is old
$all = Get-ChildItem $outDir -Filter 'oXeioAgent-*.msi' | Sort-Object LastWriteTime -Descending
if ($all.Count -gt 1) {
    Write-Host ''
    Write-Host "$($all.Count) builds in bin/:" -ForegroundColor DarkGray
    foreach ($f in $all) {
        $mark = if ($f.Name -eq $msiName) { '→' } else { ' ' }
        Write-Host ("  {0} {1,-28} {2,6:N1} MB  {3}" -f $mark, $f.Name, ($f.Length/1MB), $f.LastWriteTime)
    }
}
