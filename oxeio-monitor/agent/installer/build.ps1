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
  powershell -File installer\build.ps1
  powershell -File installer\build.ps1 -Version 0.3.0

.NOTES
  Careful: this file is saved WITH a UTF-8 BOM. Do not remove the BOM.

  Windows PowerShell 5.1 (the one on stock Windows) treats a file without a BOM as
  ANSI, and then the non-ASCII text below (the Bengali messages) is garbled and the
  script does not even parse: it stops with three or four `Unexpected token` errors.

  Careful: the file had no BOM from day one, and this went unnoticed because the
  previous build ran under `pwsh` (PowerShell 7), which assumes UTF-8 without a BOM.
  So on a machine without PowerShell 7 (such as the office's server PC) the MSI could
  not be built at all. The two `deploy/*.ps1` scripts already had this rule written
  down ([deploy/README](../../deploy/README.md), section "Two notes about the
  scripts"); only this file had missed it.
#>
[CmdletBinding()]
param(
    # Careful: the default is NOT hardcoded; it is read from Directory.Build.props
    # (below). It used to say '0.1.0' here and the same number separately in
    # Program.cs; when the two differed the MSI installed one version and the agent
    # reported another in its heartbeat, so H04 offered the same update forever.
    [string]$Version,

    # The address is baked into the MSI, which then **installs on a double-click**:
    # no long command to type on the office's 15 PCs.
    #
    # Careful: the default is deliberately SET, not empty. It used to be empty, and
    # without `-ServerUrl` the build silently produced an MSI that stopped on
    # double-click with "This MSI was built without a server address". That is exactly
    # what happened with 0.3.2: build succeeded, the warning was one DarkGray line,
    # and the mistake was found when the owner installed it ([09 § ৩ন]).
    #
    # This product has a single address, so the default is the right behaviour. An
    # exception must now be requested explicitly with `-NoServerUrl`.
    # 13 Aug: `oxeio.office.local` -> `hub.oxeio.com` (ADR-026). This is now the real
    # address: VPS, Let's Encrypt certificate, public DNS.
    [string]$ServerUrl = 'https://hub.oxeio.com',

    # Careful: an MSI without an address, only for when several offices will install
    # with `msiexec /qn SERVERURL=...` and different addresses.
    [switch]$NoServerUrl,

    # ADR-014: thumbprint of the self-made signing certificate (make-code-cert.ps1
    # prints it). Without it the build runs as before, with no error; otherwise
    # building on a dev machine would be blocked.
    [string]$SignWith,

    # The owner's public key for signed updates — a .pem file or its base64
    # body. Baked into the MSI (UPDATEKEY), so the agent installs only updates
    # signed with the matching private key. Empty = sha256 only, as before.
    # deploy/README.md § "Signed agent updates".
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
    throw "Directory.Build.props-এ <Version> পাওয়া গেল না: $propsPath"
}

if (-not $Version) {
    $Version = $propsVersion
} elseif ($Version -ne $propsVersion) {
    Write-Warning @"
MSI বসবে $Version দিয়ে, কিন্তু এজেন্টের assembly বলবে $propsVersion।
⚠️ সার্ভার heartbeat-এর ভার্সন দেখেই আপডেট অফার করবে কি না ঠিক করে (G59) —
   দুটো আলাদা হলে ওই মেশিনকে একই আপডেট বারবার অফার করা হবে।
   Directory.Build.props-এ <Version> বদলে আবার চালানোই ঠিক পথ।
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
$Version আগে থেকেই আছে — ঢেকে দেওয়া হচ্ছে।
⚠️ ফাইলটা যদি ইতিমধ্যে কাউকে দিয়ে থাকেন, Directory.Build.props-এ
   <Version> বাড়িয়ে নিন। এক নম্বরে দুটো বাইনারি = কোনটা কোথায় চলছে
   সেটা আর জানা যাবে না।
"@
}

# Careful: -NoServerUrl wins; the whole point of the switch is to drop the default address
if ($NoServerUrl) { $ServerUrl = '' }

if ($ServerUrl) {
    # Careful: the shape is checked right here. A wrong address baked into the MSI
    #    would only be noticed after installing on 15 PCs, as "not reaching the server".
    if ($ServerUrl -notmatch '^https?://[^/\s]+/?$') {
        throw "ServerUrl-টা এরকম হওয়া উচিত: https://oxeio.office.local (পথ বা শেষে স্ল্যাশ ছাড়া) — পাওয়া গেল: $ServerUrl"
    }
    Write-Host "   server : $ServerUrl (MSI-তে বেক করা — ডাবল-ক্লিকেই ইনস্টল হবে)" -ForegroundColor DarkGray
} else {
    # Careful: not DarkGray. This MSI will NOT work on double-click, and 0.3.2 came
    #    out wrong precisely because this one line was easy to miss.
    Write-Host "   server : ⚠️ বেক করা হয়নি (-NoServerUrl) — ডাবল-ক্লিকে ইনস্টল হবে না," -ForegroundColor Yellow
    Write-Host "            msiexec-এ SERVERURL= দিতে হবে" -ForegroundColor Yellow
}

Write-Host '── ১· publish ────────────────────────────────' -ForegroundColor Cyan

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
oXeio চলছে ($(($locking | ForEach-Object { "$($_.Name)#$($_.Id)" }) -join ', ')) —
publish ফোল্ডারের ফাইল লক করা, তাই বিল্ড করা যাবে না।

    Stop-Process -Name oXeio.Agent, oXeio.Watchdog -Force

⚠️ পরীক্ষার জন্য এজেন্ট চালাতে হলে obj\publish থেকে **নয়** — আগে অন্য
   ফোল্ডারে কপি করে নিন, নইলে পরের বিল্ডটা চুপচাপ পুরোনো বাইনারি রেখে দেবে।
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
এই thumbprint-এর সার্ট পাওয়া যায়নি: $SignWith

⚠️ সার্টটা **এই ইউজারের** স্টোরে থাকতে হয় (প্রাইভেট কী সহ)। যে মেশিনে
   make-code-cert.ps1 চালানো হয়েছে, সই করাও সেখানেই হবে।

   অন্য মেশিনে সই করতে হলে .pfx ইমপোর্ট করুন:
       Import-PfxCertificate -FilePath deploy\certs\oxeio-code.pfx ``
           -CertStoreLocation Cert:\CurrentUser\My
"@
    }

    if (-not $signCert.HasPrivateKey) {
        throw "সার্টটা আছে কিন্তু প্রাইভেট কী নেই — .cer ইমপোর্ট করা হয়েছে, .pfx নয়।"
    }

    if ($signCert.NotAfter -lt (Get-Date)) {
        throw "সার্টের মেয়াদ শেষ ($($signCert.NotAfter.ToString('yyyy-MM-dd'))) — নতুন সার্ট বানান।"
    }

    Write-Host "   সই     : $($signCert.Subject) ($($signCert.NotAfter.ToString('yyyy-MM-dd')) পর্যন্ত)" -ForegroundColor DarkGray
    if ($NoTimestamp) {
        Write-Host '   ⚠️ টাইমস্ট্যাম্প ছাড়া — সার্টের মেয়াদ শেষ হলে সইগুলোও অচল হবে' -ForegroundColor Yellow
    }
}
else {
    Write-Host '   সই     : করা হবে না (-SignWith দিলে হবে)' -ForegroundColor DarkGray
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
            "`n⚠️ টাইমস্ট্যাম্প সার্ভারে পৌঁছাতে না পারলেও এটা হয় ($TimestampUrl)।" +
            "`n   অফলাইনে বিল্ড করতে হলে -NoTimestamp, কিন্তু উপরের সতর্কবাণীটা পড়ুন।"
        } else { '' }

        throw "সই ব্যর্থ ($name): $($result.Status) — $($result.StatusMessage)$hint"
    }

    # Careful: a timestamp was requested but not applied; this must not pass silently.
    #    When the certificate expired, all the old builds' signatures would go invalid at once.
    if (-not $NoTimestamp -and -not $signed.TimeStamperCertificate) {
        throw "সই হয়েছে কিন্তু টাইমস্ট্যাম্প বসেনি ($name) — $TimestampUrl-এ পৌঁছানো যায়নি।"
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
    if ($LASTEXITCODE -ne 0) { throw "$project publish ব্যর্থ" }
}

Get-ChildItem $publishDir -Filter *.pdb | Remove-Item -Force

$size = [math]::Round((Get-ChildItem $publishDir -Recurse | Measure-Object Length -Sum).Sum / 1MB, 1)
$count = (Get-ChildItem $publishDir -Recurse -File).Count
Write-Host "   $count ফাইল · $size MB"

# Careful: the exes are signed BEFORE wix build, on purpose. Signed afterwards, the MSI
#    would contain the unsigned copy and the unsigned exe would land on disk after install,
#    while the MSI's signature made everything look fine.
#
# ADR-014: AV is more suspicious of the inner oXeio.Agent.exe than of the wrapper,
#    so both exes need a signature, not only the MSI.
foreach ($exe in 'oXeio.Agent.exe', 'oXeio.Watchdog.exe') {
    Invoke-Sign (Join-Path $publishDir $exe)
}

Write-Host '── ২· wix build ─────────────────────────────' -ForegroundColor Cyan

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

if ($LASTEXITCODE -ne 0) { throw 'wix build ব্যর্থ' }

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
    $stamped = if ($sig.TimeStamperCertificate) { 'টাইমস্ট্যাম্প সহ' } else { '⚠️ টাইমস্ট্যাম্প ছাড়া' }
    Write-Host "   ✍ সই: $($sig.SignerCertificate.Subject) · $stamped" -ForegroundColor Green

    # Careful: this machine could not verify the signature. Almost always it means the
    #    build machine has not put its own certificate in Trusted Root. The MSI is fine;
    #    on a staff PC (where trust-publisher.ps1 has run) it will show as valid.
    if ($script:LocalTrustWarning) {
        Write-Host ''
        Write-Host '   ⚠️ এই মেশিন সইটা যাচাই করতে পারছে না — সার্টটা এখানে' -ForegroundColor Yellow
        Write-Host '      Trusted Root-এ বসানো নেই। MSI ঠিক আছে; যে PC-তে' -ForegroundColor Yellow
        Write-Host '      trust-publisher.ps1 চলেছে সেখানে বৈধ দেখাবে।' -ForegroundColor Yellow
        Write-Host '      এখানেও যাচাই করতে চাইলে এই মেশিনেও ওটা একবার চালান।' -ForegroundColor Yellow
    }
}
else {
    Write-Host '   ⚠️ সই করা হয়নি — ইনস্টলে "Unknown publisher" আসবে' -ForegroundColor Yellow
    Write-Host '      (সই করতে: -SignWith <thumbprint>, দেখুন deploy/make-code-cert.ps1)' -ForegroundColor Yellow
}

Write-Host ''
if ($ServerUrl) {
    Write-Host 'ইনস্টল — স্টাফ নিজের ইমেইল-পাসওয়ার্ড দিয়ে সাইন ইন করবে:' -ForegroundColor Yellow
    Write-Host "  ডাবল-ক্লিক, অথবা:  msiexec /i $msiName /qn"
} else {
    Write-Host 'সাইলেন্ট ইনস্টল:' -ForegroundColor Yellow
    Write-Host "  msiexec /i $msiName /qn SERVERURL=`"https://oxeio.office.local`""
}

# Everything in bin/, so it is clear at a glance which build is new and which is old
$all = Get-ChildItem $outDir -Filter 'oXeioAgent-*.msi' | Sort-Object LastWriteTime -Descending
if ($all.Count -gt 1) {
    Write-Host ''
    Write-Host "bin/-এ $($all.Count)টা বিল্ড:" -ForegroundColor DarkGray
    foreach ($f in $all) {
        $mark = if ($f.Name -eq $msiName) { '→' } else { ' ' }
        Write-Host ("  {0} {1,-28} {2,6:N1} MB  {3}" -f $mark, $f.Name, ($f.Length/1MB), $f.LastWriteTime)
    }
}
