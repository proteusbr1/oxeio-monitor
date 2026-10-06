using System.Globalization;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;

using Microsoft.Win32;

namespace oXeio.Agent.Security;

/// <summary>Where this machine's identity actually came from.</summary>
internal enum MachineIdSource
{
    /// <summary>HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid: the desired case.</summary>
    Registry,

    /// <summary>The registry could not be read, so a GUID we generated in %ProgramData%.</summary>
    LocalFile,

    /// <summary>Could not even write to disk; lasts only for the life of this process.</summary>
    Volatile,
}

/// <summary>
/// Everything needed to enroll: the stable machineGuid, hostname, Windows user, OS version.
///
/// <b>Careful: PCs cloned from an image are the most important trap in this file.</b>
/// <c>MachineGuid</c> is created when Windows is installed. <c>sysprep /generalize</c>
/// regenerates it, but what usually happens in an office is: set up one PC, take a disk
/// image and pour it onto the other 14, and then <b>the MachineGuid stays identical</b>.
/// The server then sees 15 PCs as one device; the hours of 15 people pile up under one name
/// and the others' records stay empty. The worst part is that it is silent: the agent runs
/// fine, the dashboard shows green, only the numbers are wrong.
///
/// We deliberately do <b>not</b> try to "fix" that here (mixing the hostname into the
/// machineGuid would lose the identity whenever a PC is renamed, wiping history on every
/// rename). The real defence is in <see cref="DeviceTokenStore"/>: the token is bound to both
/// machineGuid and hostname, and on a cloned machine the hostname does not match, so the token
/// is simply not used. The tray turns red and says "enroll again".
/// So the mistake becomes visible instead of silent.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed record MachineIdentity
{
    private const string CryptographyKeyPath = @"SOFTWARE\Microsoft\Cryptography";
    private const string MachineGuidValueName = "MachineGuid";

    /// <summary>Where our own generated GUID is kept when the registry cannot be read.</summary>
    public const string FallbackFileName = "machine-id.txt";

    public required string MachineGuid { get; init; }
    public required MachineIdSource Source { get; init; }
    public required string Hostname { get; init; }
    public required string WindowsUsername { get; init; }
    public required string OsVersion { get; init; }

    /// <summary>
    /// Careful: false when <see cref="MachineIdSource.Volatile"/>. Enrolling is then
    /// <b>forbidden</b>: a new GUID on every reboot would mean a new device on the server
    /// every day, and one staff member's hours would scatter over dozens of ghost devices.
    /// </summary>
    public required bool UsableForEnrollment { get; init; }

    /// <summary>Non-null means a problem worth showing the admin; never swallowed.</summary>
    public string? Warning { get; init; }

    /// <summary>
    /// <paramref name="dataDirectory"/> = <c>%ProgramData%\oXeio</c>.
    /// The fallback GUID is written and read there. Careful: never throws; failing to
    /// obtain an identity does not kill the agent, it only blocks enrollment.
    /// </summary>
    public static MachineIdentity Collect(string dataDirectory)
    {
        var hostname = ReadHostname();
        var username = ReadUsername();
        var os = ReadOsVersion();

        var registry = TryReadRegistryMachineGuid(out var registryError);
        if (registry is not null)
        {
            return new MachineIdentity
            {
                MachineGuid = registry,
                Source = MachineIdSource.Registry,
                Hostname = hostname,
                WindowsUsername = username,
                OsVersion = os,
                UsableForEnrollment = true,
            };
        }

        var fallback = TryReadOrCreateFallback(dataDirectory, out var fileError);
        if (fallback is not null)
        {
            return new MachineIdentity
            {
                MachineGuid = fallback,
                Source = MachineIdSource.LocalFile,
                Hostname = hostname,
                WindowsUsername = username,
                OsVersion = os,
                UsableForEnrollment = true,
                Warning =
                    $"MachineGuid could not be read from the registry ({registryError}) — " +
                    $"an id generated from {FallbackFileName} is being used instead. " +
                    "⚠️ If %ProgramData%\\oXeio is deleted or Windows is reinstalled, " +
                    "this machine will show up on the server as a new device.",
            };
        }

        // Reaching here means both the registry and the disk failed. A GUID is returned only
        // so the rest of the code does not have to handle null; UsableForEnrollment=false
        // says it must not be trusted.
        return new MachineIdentity
        {
            MachineGuid = Guid.NewGuid().ToString("D"),
            Source = MachineIdSource.Volatile,
            Hostname = hostname,
            WindowsUsername = username,
            OsVersion = os,
            UsableForEnrollment = false,
            Warning =
                $"❌ Could not create a stable machine id. Registry: {registryError}; " +
                $"file: {fileError}. Enrolment will not happen — otherwise every reboot would create a new device.",
        };
    }

    /// <summary>Uses the default data folder: <c>%ProgramData%\oXeio</c>.</summary>
    public static MachineIdentity Collect() => Collect(AgentDataDirectory.Default);

    /// <summary>
    /// Careful: <see cref="RegistryView.Registry64"/> is given explicitly. Running as a 32-bit
    /// process (which happens as soon as someone publishes win-x86) would send WOW64
    /// redirection to <c>SOFTWARE\Wow6432Node\Microsoft\Cryptography</c>, where MachineGuid
    /// does <b>not</b> exist, so every 32-bit build would silently fall back to the fallback
    /// id and every machine would become a "new device".
    /// On 32-bit Windows this view is ignored, so there is no harm.
    /// </summary>
    private static string? TryReadRegistryMachineGuid(out string error)
    {
        try
        {
            using var hklm = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);
            using var key = hklm.OpenSubKey(CryptographyKeyPath, writable: false);

            if (key is null)
            {
                error = $@"HKLM\{CryptographyKeyPath} does not exist";
                return null;
            }

            var raw = key.GetValue(MachineGuidValueName) as string;
            if (string.IsNullOrWhiteSpace(raw))
            {
                error = $"{MachineGuidValueName} is empty";
                return null;
            }

            // Careful: without validation the server would answer 400 and enrollment would be
            // stuck forever. An all-zero GUID really does show up on some broken images.
            var trimmed = raw.Trim();
            if (!Guid.TryParseExact(trimmed, "D", out var parsed) || parsed == Guid.Empty)
            {
                error = "The MachineGuid value is not a GUID";
                return null;
            }

            error = string.Empty;
            return parsed.ToString("D");
        }
        catch (Exception ex)
        {
            error = ex.GetType().Name + ": " + ex.Message;
            return null;
        }
    }

    private static string? TryReadOrCreateFallback(string dataDirectory, out string error)
    {
        try
        {
            var path = Path.Combine(dataDirectory, FallbackFileName);

            if (File.Exists(path))
            {
                var text = File.ReadAllText(path).Trim();
                if (Guid.TryParseExact(text, "D", out var existing) && existing != Guid.Empty)
                {
                    error = string.Empty;
                    return existing.ToString("D");
                }
                // The file exists but is corrupt; it is rewritten below.
            }

            // Careful: not Directory.CreateDirectory. That would create the folder inheriting
            // ProgramData's loose ACL, and DeviceTokenStore would later see "the folder already
            // exists" and never apply the strict ACL.
            AgentDataDirectory.Ensure(dataDirectory);

            var created = Guid.NewGuid().ToString("D");
            File.WriteAllText(path, created);

            error = string.Empty;
            return created;
        }
        catch (Exception ex)
        {
            error = ex.GetType().Name + ": " + ex.Message;
            return null;
        }
    }

    /// <summary>
    /// Careful: not <c>Dns.GetHostName()</c>. It can append a DNS suffix and changes when the
    /// network config changes, yet this value is bound to the token, so if it were unstable it
    /// would trigger "suspected clone" every time and ask for re-enrollment for no reason.
    /// <c>Environment.MachineName</c> is the NetBIOS name and does not change unless renamed.
    /// </summary>
    private static string ReadHostname()
    {
        try
        {
            var name = Environment.MachineName.Trim();
            return string.IsNullOrEmpty(name) ? "unknown-host" : name;
        }
        catch
        {
            return "unknown-host";
        }
    }

    private static string ReadUsername()
    {
        try
        {
            var domain = Environment.UserDomainName;
            var user = Environment.UserName;

            if (string.IsNullOrWhiteSpace(user)) return "unknown-user";

            return string.IsNullOrWhiteSpace(domain) ? user : $@"{domain}\{user}";
        }
        catch
        {
            return "unknown-user";
        }
    }

    /// <summary>
    /// <c>RuntimeInformation.OSDescription</c> includes the build number
    /// ("Microsoft Windows 10.0.26100"). Because app.manifest declares compatibility, it shows
    /// the real version, not a value stuck at Windows 8.
    /// </summary>
    private static string ReadOsVersion()
    {
        try
        {
            var description = RuntimeInformation.OSDescription?.Trim();
            if (!string.IsNullOrEmpty(description)) return description;
        }
        catch
        {
            // falls through to the fallback below
        }

        try
        {
            return "Windows " + Environment.OSVersion.Version.ToString();
        }
        catch
        {
            return "Windows (unknown version)";
        }
    }

    /// <summary>One log line. Nothing secret here; machineGuid is not a secret.</summary>
    public string Describe() => string.Create(
        CultureInfo.InvariantCulture,
        $"machineGuid={MachineGuid} ({Source})  host={Hostname}  user={WindowsUsername}  os={OsVersion}");
}
